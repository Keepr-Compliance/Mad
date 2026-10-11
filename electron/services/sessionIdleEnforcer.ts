/**
 * BACKLOG-3833 — enforce the session idle timeout while the app stays open.
 *
 * Two callers:
 * - IPC `session:user-activity` (renderer input heartbeat, at most once a
 *   minute, no arguments): `enforceSessionIdle({ recordActivity: true })`.
 * - A main-side interval (every minute): `enforceSessionIdle({ recordActivity: false })`.
 *
 * Validity is checked BEFORE activity is recorded, so input from a user who
 * returns after the idle limit cannot revive an already idle session: it takes
 * the same sign-out path.
 *
 * Sign-out runs the shared main-side logout (`signOutLocalSession`: stop sync,
 * per-user resets, audit with the real account id, in-memory session, stored
 * session) and only THEN tells the renderer through `session:idle-expired`.
 * No renderer is needed: with the window closed the sign-out is complete.
 *
 * The check is read-only (BACKLOG-3833 R4/B3): it reads the session file
 * through `sessionService.peekSession` (queued behind session writes, never
 * deletes) and the DB row through `getSessionTimes` (no UPDATE). An unreadable
 * file or any error never signs anyone out; the next tick tries again.
 */
import databaseService from "./databaseService";
import sessionService from "./sessionService";
import sessionSecurityService from "./sessionSecurityService";
import logService from "./logService";
import { sendToMainWindow } from "../windowRegistry";
import { signOutLocalSession } from "../handlers/sessionSignOut";

export const SESSION_IDLE_EXPIRED_CHANNEL = "session:idle-expired";
export const SESSION_IDLE_CHECK_INTERVAL_MS = 60 * 1000;

export type IdleEnforceResult =
  | "signed-out"
  | "no-session"
  | "active"
  | "expired"
  | "unreadable"
  | "error";

export async function enforceSessionIdle(opts: {
  recordActivity: boolean;
}): Promise<IdleEnforceResult> {
  try {
    if (!databaseService.isInitialized()) return "no-session";
    const peek = await sessionService.peekSession();
    if (peek.status === "unreadable") return "unreadable";
    if (peek.status === "none" || !peek.session.sessionToken) return "signed-out";
    const token = peek.session.sessionToken;

    const row = databaseService.getSessionTimes(token);
    if (!row) return "no-session";

    const pastExpiry = new Date(row.expires_at).getTime() < Date.now();
    const check = pastExpiry
      ? { valid: false, reason: "expired" as const }
      : await sessionSecurityService.checkSessionValidity(
          { created_at: row.created_at, last_accessed_at: row.last_accessed_at },
          token,
        );

    if (!check.valid) {
      await signOutLocalSession({ token, userId: row.user_id, reason: check.reason ?? "idle" });
      await logService.info("Session signed out by idle enforcement", "SessionIdleEnforcer", {
        reason: check.reason,
      });
      sendToMainWindow(SESSION_IDLE_EXPIRED_CHANNEL);
      return "expired";
    }

    if (opts.recordActivity) {
      sessionSecurityService.recordActivity(token);
    }
    return "active";
  } catch (error) {
    await logService.warn("Session idle enforcement check failed", "SessionIdleEnforcer", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return "error";
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the once-a-minute idle check. Safe to call twice. */
export function startSessionIdleEnforcement(): void {
  if (timer) return;
  timer = setInterval(() => {
    void enforceSessionIdle({ recordActivity: false });
  }, SESSION_IDLE_CHECK_INTERVAL_MS);
  if (typeof timer === "object" && timer && "unref" in timer) {
    timer.unref();
  }
}

export function stopSessionIdleEnforcement(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
