/**
 * Login Provisioning Service — BACKLOG-2546
 *
 * ===========================================================================
 * WHAT THIS OWNS
 * ===========================================================================
 * The database half of a sign-in: resolve or create the local user and open its
 * session row. Separately-awaited, autocommitting calls left a partially
 * provisioned account on any failure, and the first of those states was
 * permanent: once the user row exists, the next sign-in takes the update branch
 * and never re-runs new-user provisioning.
 *
 * `provisionDeepLinkLogin` puts that chain in ONE transaction. Callers get back
 * a committed user and a session token, or an exception and no rows at all.
 *
 * ===========================================================================
 * WHY IT LIVES HERE AND NOT IN `db/`
 * ===========================================================================
 * Two reasons, both load-bearing:
 *
 *   1. `writeAtomicity.guard.test.ts` applies the raw-SQL rule inside `db/` and
 *      the composition rule outside it. A composition holding no SQL of its own
 *      reads as ZERO writes inside `db/`, so removing the `dbTransaction` below
 *      would produce no red anywhere. Out here it reads as five db-layer writer
 *      calls and the guard reports it. That is the difference between having a
 *      control and having none.
 *   2. A `*Sync`-named function in `db/` that is neither paired nor reached is a
 *      ratchet red in `syncTwin.guard.test.ts` on day one.
 *
 * ===========================================================================
 * THE RULE FOR THE TRANSACTION BODY
 * ===========================================================================
 * `dbTransaction` takes a SYNCHRONOUS callback: better-sqlite3 commits when the
 * callback RETURNS, so an async body would commit with the body still running.
 * The type enforces the return value, but it CANNOT see a promise-returning call
 * whose result is dropped inside the body — the writes stay in the transaction,
 * the error path does not.
 *
 * So the body below contains only `*Sync` primitives and pure computation. No
 * logging, no Sentry, no network, no `await`. This file is in the
 * `no-floating-promises` glob in `eslint.config.js` so that rule is mechanical
 * rather than a convention.
 *
 * Anything that cannot be in the body sits deliberately on one side of it:
 *   - logging is not awaited and runs outside the body;
 *   - writing `session.json` is a FILE write and runs AFTER the commit
 *     (`saveSignInSession`, the caller's job).
 */

import type { User } from "../types";
import type { PendingDeepLinkUser } from "./signInState";
import * as Sentry from "@sentry/electron/main";
import { dbTransaction, isInitialized as isDbOpen } from "./db/core/dbConnection";
import {
  createUserSync,
  getUserByEmailSync,
  getUserByIdSync,
  getUserByOAuthIdSync,
  migrateUserIdForUnification,
  updateLastLoginSync,
} from "./db/userDbService";
import { createSessionSync } from "./db/sessionDbService";
import logService from "./logService";
import auditService from "./auditService";
import { redactId } from "../utils/redactSensitive";

// ===========================================================================
// DEEP-LINK SIGN-IN — BACKLOG-3322
// ===========================================================================

/** What a deep-link sign-in provisioned: a committed user and its session row. */
export interface DeepLinkProvisionResult {
  user: User;
  sessionToken: string;
  isNewUser: boolean;
}

/**
 * Provision a deep-link (browser) sign-in atomically: resolve or create the local
 * user and open its session row in ONE transaction. Throws on any failure,
 * leaving neither row behind.
 *
 * The lookup order is email FIRST (`users_local.email` is NOT NULL UNIQUE, so
 * a row under another id with the same email must be found, not collided
 * with), then `(provider, supabaseId)` as the OAuth id. `provider` arrives
 * already normalized by the caller (`normalizeOAuthProvider`).
 *
 * Body rule (header): `*Sync` primitives and pure computation only. The
 * lookup and the insert have no `await` between them, so check-then-insert
 * is atomic on the single connection.
 *
 * Callers use `provisionDeepLinkSignIn`, which runs the legacy-id migration
 * first. This function is exported for that wrapper and for its controls.
 */
export function provisionDeepLinkLogin(
  u: PendingDeepLinkUser,
): DeepLinkProvisionResult {
  return dbTransaction(() => {
    const existing =
      getUserByEmailSync(u.email) ??
      getUserByOAuthIdSync(u.provider, u.supabaseId);
    const user =
      existing ??
      createUserSync({
        // TASK-1507G: the Supabase Auth UUID is the local user id.
        id: u.supabaseId,
        email: u.email,
        display_name: u.displayName || u.email.split("@")[0],
        avatar_url: u.avatarUrl,
        oauth_provider: u.provider,
        oauth_id: u.supabaseId,
        subscription_tier: u.subscriptionTier || "free",
        subscription_status: u.subscriptionStatus || "trial",
        trial_ends_at: u.trialEndsAt,
        is_active: true,
      });
    const sessionToken = createSessionSync(user.id);
    // BACKLOG-3340: the sign-in's audit entry is part of the same save as the
    // user row and the session row (the BACKLOG-3339 rule). If the entry cannot
    // be written the whole sign-in rolls back; a sign-in the audit log cannot
    // record is not provisioned. This is the ONLY place a browser sign-in writes
    // LOGIN: both deep-link branches reach it once per sign-in, the session-file
    // retries (signInState.saveSignInSession) never come back here, and the
    // legacy-id migration runs before this transaction.
    // The entry carries no session id and no resource id.
    auditService.recordInTransaction({
      userId: user.id,
      action: "LOGIN",
      resourceType: "SESSION",
      metadata: { provider: u.provider, isNewUser: existing === null, method: "browser" },
    });
    // BACKLOG-4148: stamp "Last login" in the same save, for a new AND a
    // returning user. Sync on purpose (`updateLastLoginSync`): a promise-returning
    // write here would let the transaction commit over a failed UPDATE. Then
    // re-read, so the returned row (and the session file built from it) carries
    // the stamp rather than the row as it was before this sign-in.
    updateLastLoginSync(user.id);
    const stamped = getUserByIdSync(user.id);
    if (!stamped) {
      throw new Error("Failed to retrieve user after the last-login stamp");
    }
    return { user: stamped, sessionToken, isNewUser: existing === null };
  });
}

/** Why a browser sign-in failed, as a fixed code (the cloud copy keeps it). */
export type DeepLinkSignInFailureReason =
  | "provisioning_failed"
  | "license_blocked"
  | "device_limit"
  | "no_auth_session";

/**
 * BACKLOG-3340: record a failed browser sign-in as LOGIN_FAILED, in its own
 * write, after any rollback (`auditService.recordFailure`, the 3339 rule).
 * Never throws.
 *
 * Who the row belongs to: the LOCAL user found now, by email then
 * (provider, Supabase id) — the same lookup `provisionDeepLinkLogin` makes, so
 * a legacy-id user whose migration failed is recorded under the id it actually
 * has. `audit_logs.user_id` references `users_local(id)` with foreign keys on,
 * so when no local row exists (a first sign-in that rolled back) or the
 * database is not open, NO row can be written: an entry for an id with no
 * user row would fail its foreign key, and if buffered while the database is
 * closed it would block every buffered entry behind it on each flush. That
 * case is reported to Sentry and the log instead.
 */
export function recordDeepLinkSignInFailure(
  u: Pick<PendingDeepLinkUser, "supabaseId" | "email" | "provider">,
  reason: DeepLinkSignInFailureReason,
  error?: unknown,
): void {
  const notRecorded = (why: string): void => {
    void logService.warn("[DeepLink] Sign-in failure not written to the audit log", "LoginProvisioning", {
      reason,
      why,
    });
    Sentry.captureMessage("Sign-in failure not written to the audit log", {
      level: "warning",
      tags: { component: "deep-link", reason, why },
    });
  };
  try {
    if (!isDbOpen()) {
      notRecorded("database_closed");
      return;
    }
    const local =
      (u.email ? getUserByEmailSync(u.email) : null) ??
      getUserByOAuthIdSync(u.provider, u.supabaseId);
    if (!local) {
      notRecorded("no_local_user");
      return;
    }
    auditService.recordFailure({
      userId: local.id,
      action: "LOGIN_FAILED",
      resourceType: "SESSION",
      metadata: { provider: u.provider, reason, method: "browser" },
      errorMessage: error instanceof Error ? error.message : undefined,
    });
  } catch (lookupError) {
    notRecorded("lookup_failed");
    void logService.error("[DeepLink] Sign-in failure lookup failed", "LoginProvisioning", {
      error: lookupError instanceof Error ? lookupError.message : String(lookupError),
    });
  }
}

/**
 * The one entry point both deep-link branches call: `handleDeepLinkCallback`
 * in main.ts (database open) and the pending-user drain in systemHandlers.ts
 * (database opened later).
 *
 * Step 1 — legacy id (BACKLOG-600). A local user created before TASK-1507G has
 * an id other than the Supabase id; it is migrated to the Supabase id first.
 * That migration runs OUTSIDE the provisioning transaction, deliberately: it
 * sets `PRAGMA foreign_keys = OFF` and opens its own transaction, and that
 * pragma is a no-op inside an open transaction, so moving it in makes the
 * parent-id update fail its foreign keys. A migration failure is logged and
 * the sign-in continues on the old id, as before.
 *
 * Non-atomic across the two steps, stated: a crash after the migration commits
 * and before step 2 leaves the migrated user with no session row. The next
 * sign-in finds it by email with the matching id, skips the migration and adds
 * the session.
 *
 * Step 2 — `provisionDeepLinkLogin`, one transaction.
 *
 * Writing `session.json` stays with the caller, after this resolves
 * (`saveSignInSession`): a file write cannot sit inside `dbTransaction`.
 */
export async function provisionDeepLinkSignIn(
  u: PendingDeepLinkUser,
): Promise<DeepLinkProvisionResult> {
  const existing =
    getUserByEmailSync(u.email) ??
    getUserByOAuthIdSync(u.provider, u.supabaseId);
  if (existing && existing.id !== u.supabaseId) {
    // Logging is never awaited here: `logService` rejects when its file append
    // fails, and that must not stop a sign-in from being provisioned.
    void logService.info(
      "[DeepLink] Migrating local user ID to match Supabase",
      "LoginProvisioning",
      { oldId: redactId(existing.id), newId: redactId(u.supabaseId) },
    );
    try {
      await migrateUserIdForUnification(existing.id, u.supabaseId);
    } catch (migrationError) {
      // Sign-in continues on the old id; Supabase operations may fail for it.
      void logService.error(
        "[DeepLink] Failed to migrate local user ID",
        "LoginProvisioning",
        { error: migrationError instanceof Error ? migrationError.message : String(migrationError) },
      );
    }
  }
  let result: DeepLinkProvisionResult;
  try {
    result = provisionDeepLinkLogin(u);
  } catch (provisionError) {
    // BACKLOG-3340: the transaction has rolled back; the failure is its own write.
    recordDeepLinkSignInFailure(u, "provisioning_failed", provisionError);
    throw provisionError;
  }
  // Not awaited, for the same reason (the rows are already committed here).
  void logService.info(
    result.isNewUser
      ? "[DeepLink] Created local user and session"
      : "[DeepLink] Opened session for existing local user",
    "LoginProvisioning",
    { userId: redactId(result.user.id) },
  );
  return result;
}
