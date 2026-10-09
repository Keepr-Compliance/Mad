/**
 * BACKLOG-3833 — one main-side sign-out, used by user logout (`auth:logout`)
 * and by idle expiry (sessionIdleEnforcer).
 *
 * It runs entirely in main and needs no renderer, so an idle sign-out with the
 * window closed (macOS keeps the app running) still stops sync, resets the
 * per-user caches and writes the audit entry.
 *
 * Order: stop sync and per-user state, write the audit entry with the account
 * id the caller resolved BEFORE anything was cleared, drop the in-memory
 * session, then delete the stored session (DB row + session file). Callers
 * notify the renderer only after this resolves.
 *
 * The cleanup steps are fail-closed one by one: a failing step is logged and
 * the rest still run, so the stored session is always cleared. A failure to
 * clear the stored session itself propagates to the caller.
 */
import * as Sentry from "@sentry/electron/main";
import databaseService from "../services/databaseService";
import sessionService from "../services/sessionService";
import sessionSecurityService from "../services/sessionSecurityService";
import auditService from "../services/auditService";
import logService from "../services/logService";
import { setSyncUserId } from "./syncHandlers";

/**
 * BACKLOG-1840: stop the additive-only shadow delta poller on every logout path so
 * it can't keep ticking (and polling with the now-stale user id) after sign-out.
 * The poller is only ever started while signed in (see maybeStartShadowDeltaSync);
 * stop() is a no-op when it was never started. Fire-and-forget + fail-closed via
 * dynamic import (mirrors the start wiring) — must NEVER throw into a logout path.
 */
export function stopShadowDeltaSyncOnLogout(): void {
  void import("../services/shadowDeltaSyncService")
    .then((m) => m.default.stop())
    .catch((err) => {
      logService.warn(
        "[SessionHandlers] Shadow delta sync stop failed (non-fatal)",
        "SessionHandlers",
        { error: err instanceof Error ? err.message : "Unknown" },
      );
    });
}

/**
 * BACKLOG-2474: drop ALREADY-QUEUED contact-linking work and the per-session
 * gates that go with it, on every logout path.
 *
 * Both are keyed by user id, so leaving them is not merely untidy: a pass left
 * queued for the user who just signed out would run against their data and then
 * notify a window that is now showing someone else, and the one-shot reconcile
 * gate would make the NEXT user look already-reconciled when they are not.
 *
 * WHAT THIS DOES NOT DO: it does not stop work being scheduled AFTER it runs. A
 * background sync still in flight at logout can write to `external_contacts`
 * and signal the scheduler, and that pass will execute for the signed-out user.
 * This is a one-shot cleanup, not a latch.
 *
 * That residue is left alone deliberately. Every query in the pass is
 * `WHERE user_id = ?`-scoped, so it cannot touch another user's rows; the
 * notify is `isDestroyed()`-guarded and lands on a channel whose only consumer
 * re-reads a count for the user it is currently rendering. A latch would add a
 * second piece of session state that could be left set — silently disabling
 * matching for the next user — which is a worse failure than a redundant pass.
 *
 * Dynamic import and fail-closed, mirroring the poller stop above — this must
 * NEVER throw into a logout path, and a static import would drag the whole
 * contact-handler dependency tree into every consumer of this module.
 */
export function resetContactLinkingOnLogout(): void {
  void import("./contactHandlers")
    .then((m) => m.resetContactSessionState())
    .catch((err) => {
      logService.warn(
        "[SessionHandlers] Contact linking session reset failed (non-fatal)",
        "SessionHandlers",
        { error: err instanceof Error ? err.message : "Unknown" },
      );
    });
}

/**
 * BACKLOG-3476: drop the feature-gate answers — the plan map AND the strict
 * reader's cached membership — on every logout path. Both belong to the
 * account that just signed out.
 *
 * In-memory only (`invalidateCache`, not `clearCache`): the persisted copy is
 * the offline fallback, keyed by organization, and deleting it is not what
 * signing out has ever done.
 *
 * Dynamic import and fail-closed, mirroring the two resets above — this must
 * NEVER throw into a logout path.
 */
export function resetFeatureGateOnLogout(): void {
  void import("../services/featureGateService")
    .then((m) => m.default.invalidateCache())
    .catch((err) => {
      logService.warn(
        "[SessionHandlers] Feature gate cache reset failed (non-fatal)",
        "SessionHandlers",
        { error: err instanceof Error ? err.message : "Unknown" },
      );
    });
}

/**
 * BACKLOG-3618: drop the checklist template listing — memory AND file — on
 * every logout path. A listing now holds the signed-in user's own checklists,
 * so it belongs to that user; the next person on this profile must not be
 * shown it. The cache is also keyed on the user, so this is the second line.
 *
 * Dynamic import and fail-closed, mirroring the resets above — this must
 * NEVER throw into a logout path.
 */
export function resetChecklistTemplatesOnLogout(): void {
  void import("../services/checklistTemplateService")
    .then((m) => m.default.invalidate())
    .catch((err) => {
      logService.warn(
        "[SessionHandlers] Checklist template cache reset failed (non-fatal)",
        "SessionHandlers",
        { error: err instanceof Error ? err.message : "Unknown" },
      );
    });
}

export type SignOutReason = "user" | "idle" | "expired" | "invalid";

/**
 * Tokens this process has already signed out. When the renderer reacts to an
 * idle sign-out it calls `auth:logout` with the old token; that call must not
 * write a second LOGOUT audit entry (it would have no account id left).
 */
const signedOutTokens = new Set<string>();

export function wasSignedOutHere(token: string): boolean {
  return signedOutTokens.has(token);
}

async function step(name: string, run: () => unknown): Promise<void> {
  try {
    await run();
  } catch (error) {
    await logService.warn(`Sign-out step failed: ${name}`, "SessionSignOut", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export async function signOutLocalSession(opts: {
  token: string;
  /** Account id (users_local id), resolved by the caller before anything is cleared. */
  userId: string;
  reason: SignOutReason;
}): Promise<void> {
  const { token, userId, reason } = opts;

  await step("stop sync", () => setSyncUserId(null));
  await step("sentry user", () => Sentry.setUser(null));
  await step("shadow delta sync", () => stopShadowDeltaSyncOnLogout());
  await step("contact linking", () => resetContactLinkingOnLogout());
  await step("feature gates", () => resetFeatureGateOnLogout());
  await step("checklist templates", () => resetChecklistTemplatesOnLogout());
  await step("audit", () =>
    auditService.log({
      userId,
      sessionId: token,
      action: "LOGOUT",
      resourceType: "SESSION",
      resourceId: token,
      success: true,
      metadata: { reason },
    }),
  );
  await step("in-memory session", () => sessionSecurityService.cleanupSession(token));

  await databaseService.deleteSession(token);
  await sessionService.clearSession();
  signedOutTokens.add(token);

  await logService.info("Session signed out", "SessionSignOut", { userId, reason });
}
