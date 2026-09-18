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
import { dbTransaction } from "./db/core/dbConnection";
import {
  createUserSync,
  getUserByIdSync,
  getUserByOAuthIdSync,
  updateLastLoginSync,
  updateUserSync,
} from "./db/userDbService";
import { saveOAuthTokenSync } from "./db/oauthTokenDbService";
import { createSessionSync } from "./db/sessionDbService";

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
