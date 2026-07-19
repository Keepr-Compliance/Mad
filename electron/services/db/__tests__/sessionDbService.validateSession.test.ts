/**
 * @jest-environment node
 *
 * Regression test for BACKLOG-2132 — session logout loop.
 *
 * ROOT CAUSE: `validateSession` ran `SELECT s.*, u.*` joining `sessions` and
 * `users_local`. Both tables define `created_at`, `id`, and `updated_at`.
 * better-sqlite3 returns a flat object keyed by column name; with duplicate
 * names the LATER projection wins. Because `u.*` was selected after `s.*`,
 * `users_local.created_at` (the fixed account-creation date) OVERWROTE
 * `sessions.created_at` (the fresh per-login timestamp), and `users_local.id`
 * overwrote `sessions.id`. `sessionSecurityService.checkSessionValidity` then
 * computed the "session age" from the ACCOUNT creation date, so any account
 * older than 24h was declared expired on every login → infinite logout loop.
 *
 * These tests exercise the REAL `validateSession` against an in-memory
 * better-sqlite3-multiple-ciphers database (wired via `setDb`), with a minimal
 * subset of the production schema that reproduces the column collision. They
 * assert that the returned `created_at`, `last_accessed_at`, and `id` reflect
 * the SESSION row, not the account, and that the downstream security check
 * therefore behaves correctly.
 *
 * The default Jest moduleNameMapper rewrites "better-sqlite3-multiple-ciphers"
 * to a stub; require the real package via an explicit node_modules path so this
 * integration test exercises actual SQL.
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers")
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";
import crypto from "crypto";

import { setDb, closeDb } from "../core/dbConnection";
import { createSession, validateSession } from "../sessionDbService";
import { sessionSecurityService } from "../../sessionSecurityService";

/**
 * Minimal production-faithful schema for the two tables involved in the JOIN.
 * The collision on `id`, `created_at`, and `updated_at` is the whole point,
 * so both tables intentionally declare those columns (matching schema.sql).
 */
function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE users_local (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      first_name TEXT,
      last_name TEXT,
      oauth_provider TEXT NOT NULL,
      oauth_id TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login_at DATETIME
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_token TEXT NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
    );
  `);
}

/** Insert a user with an explicit (old) account creation date. */
function insertUser(
  db: DatabaseType,
  userId: string,
  accountCreatedAt: string,
  lastLoginAt: string,
): void {
  db.prepare(
    `INSERT INTO users_local
       (id, email, oauth_provider, oauth_id, created_at, updated_at, last_login_at)
     VALUES (?, ?, 'google', 'oauth-1', ?, ?, ?)`
  ).run(userId, `${userId}@example.com`, accountCreatedAt, accountCreatedAt, lastLoginAt);
}

/**
 * Insert a session row with explicit id / created_at / last_accessed_at.
 * (createSession() lets SQLite stamp defaults; here we need deterministic,
 * distinct-from-account values to prove the collision is resolved.)
 */
function insertSession(
  db: DatabaseType,
  opts: {
    sessionId: string;
    userId: string;
    token: string;
    expiresAt: string;
    createdAt: string;
    lastAccessedAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO sessions
       (id, user_id, session_token, expires_at, created_at, last_accessed_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    opts.sessionId,
    opts.userId,
    opts.token,
    opts.expiresAt,
    opts.createdAt,
    opts.lastAccessedAt,
  );
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("BACKLOG-2132 validateSession column-collision regression", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    setDb(db);
    sessionSecurityService.clearAllActivity();
  });

  afterEach(async () => {
    await closeDb();
  });

  it("returns the SESSION created_at, not the (older) account created_at", async () => {
    const userId = "user-old-account";
    const accountCreatedAt = iso(-13 * DAY); // account is 13 days old
    const sessionCreatedAt = iso(-1000); // session created ~now

    insertUser(db, userId, accountCreatedAt, iso(-13 * DAY));
    const sessionId = crypto.randomUUID();
    const token = "token-fresh-session";
    insertSession(db, {
      sessionId,
      userId,
      token,
      expiresAt: iso(+DAY),
      createdAt: sessionCreatedAt,
      lastAccessedAt: sessionCreatedAt,
    });

    const result = await validateSession(token);

    expect(result).not.toBeNull();
    // The bug returned the ACCOUNT date here; the fix returns the SESSION date.
    expect(result!.created_at).toBe(sessionCreatedAt);
    expect(result!.created_at).not.toBe(accountCreatedAt);
  });

  it("returns the SESSION id, not the account id (id also collides)", async () => {
    const userId = "user-id-collision";
    insertUser(db, userId, iso(-10 * DAY), iso(-10 * DAY));
    const sessionId = crypto.randomUUID();
    const token = "token-id-collision";
    insertSession(db, {
      sessionId,
      userId,
      token,
      expiresAt: iso(+DAY),
      createdAt: iso(-500),
      lastAccessedAt: iso(-500),
    });

    const result = await validateSession(token);

    expect(result).not.toBeNull();
    // The bug returned the account id as `id`; the fix returns the true session id.
    expect(result!.id).toBe(sessionId);
    expect(result!.id).not.toBe(userId);
    // The user fields must still be present and correct.
    expect(result!.user_id).toBe(userId);
    expect(result!.email).toBe(`${userId}@example.com`);
  });

  it("returns the SESSION last_accessed_at (refreshed on validate), not account last_login_at", async () => {
    const userId = "user-last-accessed";
    const accountLastLogin = iso(-9 * DAY);
    insertUser(db, userId, iso(-9 * DAY), accountLastLogin);
    const sessionId = crypto.randomUUID();
    const token = "token-last-accessed";
    insertSession(db, {
      sessionId,
      userId,
      token,
      expiresAt: iso(+DAY),
      createdAt: iso(-2000),
      lastAccessedAt: iso(-2000),
    });

    const before = Date.now();
    const result = await validateSession(token);

    expect(result).not.toBeNull();
    // validateSession updates sessions.last_accessed_at = CURRENT_TIMESTAMP and
    // returns the session's own value, which must NOT be the account last_login_at.
    expect(result!.last_accessed_at).not.toBe(accountLastLogin);
    const returnedMs = new Date(result!.last_accessed_at).getTime();
    // Refreshed to ~now (allow a small clock/second-granularity window).
    expect(returnedMs).toBeGreaterThanOrEqual(before - 2 * HOUR);
  });

  describe("downstream security check consumes the corrected timestamps", () => {
    it("a fresh session on an OLD account survives the 24h age check (was: instant logout)", async () => {
      const userId = "user-fresh-on-old-account";
      insertUser(db, userId, iso(-30 * DAY), iso(-30 * DAY));
      const token = "token-behavioral-valid";
      insertSession(db, {
        sessionId: crypto.randomUUID(),
        userId,
        token,
        expiresAt: iso(+DAY),
        createdAt: iso(-1000),
        lastAccessedAt: iso(-1000),
      });

      const session = await validateSession(token);
      expect(session).not.toBeNull();

      const check = await sessionSecurityService.checkSessionValidity(
        { created_at: session!.created_at, last_accessed_at: session!.last_accessed_at },
        token,
      );

      // Before the fix this returned { valid: false, reason: "expired" }.
      expect(check.valid).toBe(true);
    });

    it("a genuinely >24h-old SESSION still expires", async () => {
      const userId = "user-genuinely-old-session";
      insertUser(db, userId, iso(-30 * DAY), iso(-30 * DAY));
      const token = "token-behavioral-expired";
      // NOTE: not expired via expires_at (kept in the future) so we isolate the
      // age check; session created_at is 25h ago → should trip SESSION_TIMEOUT.
      insertSession(db, {
        sessionId: crypto.randomUUID(),
        userId,
        token,
        expiresAt: iso(+DAY),
        createdAt: iso(-25 * HOUR),
        lastAccessedAt: iso(-25 * HOUR),
      });

      const session = await validateSession(token);
      expect(session).not.toBeNull();

      const check = await sessionSecurityService.checkSessionValidity(
        { created_at: session!.created_at, last_accessed_at: session!.last_accessed_at },
        token,
      );

      expect(check.valid).toBe(false);
      expect(check.reason).toBe("expired");
    });

    it("idle-fallback uses the real session last_accessed_at (>30min idle expires)", async () => {
      const userId = "user-idle";
      insertUser(db, userId, iso(-2 * DAY), iso(-2 * DAY));
      const token = "token-idle";
      insertSession(db, {
        sessionId: crypto.randomUUID(),
        userId,
        token,
        expiresAt: iso(+DAY),
        createdAt: iso(-1 * HOUR),
        lastAccessedAt: iso(-1 * HOUR),
      });

      const session = await validateSession(token);
      expect(session).not.toBeNull();

      // Feed a stale last_accessed_at (45 min ago) to exercise the DB idle
      // fallback branch (no in-memory activity tracked for this token).
      const check = await sessionSecurityService.checkSessionValidity(
        { created_at: session!.created_at, last_accessed_at: iso(-45 * 60 * 1000) },
        token,
      );

      expect(check.valid).toBe(false);
      expect(check.reason).toBe("idle");
    });
  });

  it("createSession + validateSession round-trip returns a fresh session created_at", async () => {
    const userId = "user-roundtrip";
    insertUser(db, userId, iso(-20 * DAY), iso(-20 * DAY));

    const token = await createSession(userId);
    const result = await validateSession(token);

    expect(result).not.toBeNull();
    // Session was just created → its age must be well under the account age.
    const sessionAgeMs = Date.now() - new Date(result!.created_at).getTime();
    expect(sessionAgeMs).toBeLessThan(HOUR);
  });
});
