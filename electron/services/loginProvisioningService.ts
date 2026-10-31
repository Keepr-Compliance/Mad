/**
 * Login Provisioning Service — BACKLOG-2546
 *
 * ===========================================================================
 * WHAT THIS OWNS
 * ===========================================================================
 * The database half of a login. Four handlers used to compose the same chain of
 * separately-awaited calls — resolve the local user, create or update it, stamp
 * last-login, re-read it, save the token, open the session — and every link
 * autocommitted on its own. A failure anywhere left a partially provisioned
 * account, and the first of those states was permanent: once the user row exists,
 * the next login takes the update branch and never re-runs new-user provisioning.
 *
 * `provisionLogin` puts that whole chain in ONE transaction. Callers get back a
 * committed user and a session token, or an exception and no rows at all.
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
 *   - the cloud terms sync is a NETWORK call and runs AFTER the commit;
 *   - `sessionService.saveSession` is a FILE write and runs AFTER the commit.
 * Both are the caller's job, and the caller's contract for them is documented at
 * each call site.
 */

import type {
  User,
  NewUser,
  OAuthProvider,
  OAuthPurpose,
  OAuthToken,
} from "../types";
import type { PendingDeepLinkUser } from "./signInState";
import { dbTransaction } from "./db/core/dbConnection";
import {
  createUserSync,
  getUserByEmailSync,
  getUserByIdSync,
  getUserByOAuthIdSync,
  migrateUserIdForUnification,
  updateLastLoginSync,
  updateUserSync,
} from "./db/userDbService";
import { saveOAuthTokenSync } from "./db/oauthTokenDbService";
import { createSessionSync } from "./db/sessionDbService";
import logService from "./logService";
import { redactId } from "../utils/redactSensitive";

/** The token write, when the calling path saves one. */
export interface LoginTokenWrite {
  purpose: OAuthPurpose;
  data: Partial<OAuthToken>;
}

/**
 * Every optional field maps 1:1 to a statement that exists in some, but not all,
 * of the four login paths. Omitting one SKIPS that statement — it never becomes
 * a no-op call with empty arguments.
 *
 * That is not a style preference: `updateUser` throws
 * `DatabaseError("No valid fields to update")` on an empty column set, and inside
 * this transaction that would roll back the ENTIRE login.
 */
export interface LoginProvisionRequest {
  provider: OAuthProvider;
  oauthId: string;
  /** Used only when no local user exists for (provider, oauthId). */
  create: NewUser & { id: string };
  /** Applied right after creating a new user. Omit to skip the statement. */
  updateOnCreate?: Partial<User>;
  /** Applied when a local user already exists. Omit to leave it untouched. */
  updateExisting?: Partial<User>;
  /** Omit `false` to leave `last_login_at` alone. */
  touchLastLogin: boolean;
  /** Omit to write no token row. */
  token?: LoginTokenWrite;
}

export interface LoginProvisionResult {
  /** The committed row, re-read after the last write that touched it. */
  user: User;
  sessionToken: string;
  isNewUser: boolean;
  /**
   * The local row as it was BEFORE any update in this login, or null for a new
   * user.
   *
   * This exists for the cloud terms sync-up, which must run after the commit
   * (it is a network call) but must read the values the caller would have read
   * before the update. The callers' pre-change code already read a pre-update
   * in-memory snapshot for that decision, so passing this back reproduces their
   * arguments by construction — whatever `updateExisting` happened to write.
   * Do NOT "simplify" a caller to use `user` instead; that changes what is sent
   * to the cloud.
   */
  existingBefore: User | null;
}

/**
 * Provision a login atomically. Throws on any failure, leaving no rows behind.
 *
 * Note the ordering consequence of doing the lookup INSIDE the body: with no
 * `await` between the read and the insert, check-then-insert is atomic on the
 * single connection, so two concurrent login callbacks can no longer both see
 * "no user" and race on the same primary key.
 */
export function provisionLogin(
  req: LoginProvisionRequest,
): LoginProvisionResult {
  return dbTransaction(() => {
    const existingBefore = getUserByOAuthIdSync(req.provider, req.oauthId);
    const isNewUser = existingBefore === null;

    let user: User;
    // Whether anything in this body has written to the user row, and therefore
    // whether the in-hand copy is stale. A path that writes nothing returns the
    // row exactly as its pre-change code did, rather than a re-read of it.
    let userRowWritten = false;

    if (existingBefore === null) {
      // `createUserSync` already re-reads the row it inserted.
      user = createUserSync(req.create);
      if (req.updateOnCreate) {
        updateUserSync(user.id, req.updateOnCreate);
        userRowWritten = true;
      }
    } else {
      user = existingBefore;
      if (req.updateExisting) {
        updateUserSync(user.id, req.updateExisting);
        userRowWritten = true;
      }
    }

    if (req.touchLastLogin) {
      updateLastLoginSync(user.id);
      userRowWritten = true;
    }

    if (userRowWritten) {
      const refreshed = getUserByIdSync(user.id);
      if (!refreshed) {
        throw new Error("Failed to retrieve user after update");
      }
      user = refreshed;
    }

    if (req.token) {
      saveOAuthTokenSync(user.id, req.provider, req.token.purpose, req.token.data);
    }

    const sessionToken = createSessionSync(user.id);

    return { user, sessionToken, isNewUser, existingBefore };
  });
}

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
 * The sibling of `provisionLogin`, not a copy of it. The lookup order differs:
 * email FIRST (`users_local.email` is NOT NULL UNIQUE, so a row under another id
 * with the same email must be found, not collided with), then
 * `(provider, supabaseId)` as the OAuth id. `provider` arrives already
 * normalized by the caller (`normalizeOAuthProvider`).
 *
 * Same body rule as `provisionLogin`: `*Sync` primitives and pure computation
 * only. The lookup and the insert have no `await` between them, so
 * check-then-insert is atomic on the single connection.
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
    return { user, sessionToken, isNewUser: existing === null };
  });
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
  const result = provisionDeepLinkLogin(u);
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
