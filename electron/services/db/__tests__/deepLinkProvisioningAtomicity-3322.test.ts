/**
 * @jest-environment node
 */
/*
 * BACKLOG-3322 — the deep-link sign-in's user row and session row are one unit,
 * against the REAL driver and the REAL shipped schema.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS GUARDS
 * ---------------------------------------------------------------------------
 * Both deep-link sign-in branches (main.ts `handleDeepLinkCallback` with the DB
 * open, the pending-user drain in systemHandlers.ts with the DB opened later)
 * call `provisionDeepLinkSignIn`. Its second step, `provisionDeepLinkLogin`,
 * resolves or creates the local user and opens the session row in ONE
 * transaction. These controls prove the partial state "user row, no session
 * row" is no longer reachable through a failure part way through, that the
 * lookup order (email, then OAuth id) is the one the old inline code used, and
 * that the legacy-id migration (BACKLOG-600) still runs, outside the
 * transaction.
 *
 * ---------------------------------------------------------------------------
 * HOW THE FAILURE IS INJECTED
 * ---------------------------------------------------------------------------
 * A Proxy over the REAL driver throws right after the matched statement has run
 * (the `loginProvisioningAtomicity-2546` pattern), so the throw fires INSIDE the
 * transaction body with the row already written. The `databaseService` facade
 * is mocked to an empty object: nothing on this path may route through it.
 *
 * The DB is `schema.sql` alone — the fresh shape at BASELINE_VERSION 70. The
 * only migration above it (v71) touches neither `users_local` nor `sessions`.
 *
 * The fixture user is the shape `handleDeepLinkCallback` builds
 * (`deepLinkUserData: PendingDeepLinkUser`, main.ts), with `provider` already
 * normalized there; no `trialEndsAt` (main.ts never sets it).
 *
 * ---------------------------------------------------------------------------
 * MUTATIONS THAT MAKE IT RED (run at adoption, BACKLOG-3322 PR 1)
 * ---------------------------------------------------------------------------
 *   - remove the `dbTransaction` wrapper in `provisionDeepLinkLogin`  -> D1, D2
 *     (and writeAtomicity.guard "NO NEW multi-write function")
 *   - drop the email lookup (OAuth id only)                            -> D3, D5
 *   - skip `migrateUserIdForUnification` in the wrapper                -> D5
 *   - move the migration inside the transaction                        -> D3, D5
 *   - rethrow the migration error in the wrapper's catch               -> D8
 *
 * BACKLOG-3340 (D9-D13, and audit counts in D1/D2/D5/D7): the LOGIN entry is
 * part of the same transaction and carries no session or resource id; a failed
 * provisioning writes one LOGIN_FAILED afterwards for a user whose row exists,
 * on the id that row really has, and none for a first sign-in.
 *   - move recordInTransaction after the dbTransaction                -> D9
 *   - drop recordInTransaction                                        -> D7, D12
 *   - put the session token back in sessionId / resourceId            -> D7
 *   - drop the recordDeepLinkSignInFailure call in the wrapper        -> D10, D13
 *   - write the failure with u.supabaseId instead of the looked-up id -> D13
 *     (no users_local row has that id, so the foreign key refuses the row;
 *     D10 cannot see this one: its local id IS the Supabase id)
 *
 * Run locally with (the shared native module is the Electron build):
 *   ELECTRON_RUN_AS_NODE=1 npx electron node_modules/.bin/jest \
 *     electron/services/db/__tests__/deepLinkProvisioningAtomicity-3322.test.ts --bail=0
 */

import * as nodePath from "path";
import * as fs from "fs";
import * as os from "os";
import { randomUUID } from "crypto";
import type { Database as DatabaseType } from "better-sqlite3";

// The driver is moduleNameMapper'd to a mock for the rest of the suite, so the
// real one has to be reached by absolute path.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/mock/user/data"), getVersion: jest.fn(() => "0.0.0-test") },
}));
jest.mock("../../databaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));
const mockCaptureMessage = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

import { setDb } from "../core/dbConnection";
import type { PendingDeepLinkUser } from "../../signInState";
import { provisionDeepLinkLogin, provisionDeepLinkSignIn } from "../../loginProvisioningService";
import logService from "../../logService";
import { auditService, AuditNotRecordedError } from "../../auditService";
import { forceAuditInsertFailure, realAuditDb, settle } from "./fixtures/auditTxProbe";

const SCHEMA_PATH = nodePath.join(__dirname, "..", "..", "..", "database", "schema.sql");

let tmpDir: string;
const opened: DatabaseType[] = [];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "deeplink-3322-"));
});
// BACKLOG-3340: the audit service on the real audit primitives, as dealAuditInTransaction-3339 does.
const fakeCloud = { getAuthSession: async () => null, batchInsertAuditLogs: async () => undefined };
beforeEach(() => {
  const svc = auditService as unknown as Record<string, unknown>;
  svc.pendingSyncQueue = [];
  svc.pendingLocalWrites = [];
  svc.localInsertFailing = false;
  svc.kickScheduled = false;
  svc.initialized = false;
  auditService.initialize(realAuditDb as never, fakeCloud as never);
  auditService.stopSyncInterval();
  mockCaptureMessage.mockClear();
});
afterEach(async () => {
  auditService.stopSyncInterval();
  await settle();
});

afterAll(() => {
  for (const d of opened) {
    try {
      d.close();
    } catch {
      /* already closed */
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Fresh DB carrying the real shipped schema, foreign keys on (as production). */
function seedDb(): DatabaseType {
  const db = new Database(nodePath.join(tmpDir, `${randomUUID()}.db`)) as unknown as DatabaseType;
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
  opened.push(db);
  return db;
}

function count(db: DatabaseType, table: "users_local" | "sessions" | "audit_logs"): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** The real driver, except the first `.run()` of a statement matching `pattern` throws AFTER it ran. */
function throwingAfter(real: DatabaseType, pattern: RegExp): DatabaseType {
  let fired = false;
  return new Proxy(real, {
    get(target, prop) {
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      if (prop === "prepare") {
        return (sqlText: string) => {
          const stmt = (value as (s: string) => Record<string | symbol, unknown>).call(target, sqlText);
          return new Proxy(stmt, {
            get(s, p) {
              const sv = s[p];
              if (p === "run") {
                return (...args: unknown[]) => {
                  const r = (sv as (...x: unknown[]) => unknown).apply(s, args);
                  if (!fired && pattern.test(sqlText)) {
                    fired = true;
                    throw new Error("INJECTED");
                  }
                  return r;
                };
              }
              return typeof sv === "function" ? (sv as (...x: unknown[]) => unknown).bind(s) : sv;
            },
          });
        };
      }
      return typeof value === "function" ? (value as (...x: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as DatabaseType;
}

// Generated per run: a UUID literal in a PUBLIC repo cannot be told apart from a live one (BACKLOG-2871).
function deepLinkUser(): PendingDeepLinkUser {
  return {
    supabaseId: randomUUID(),
    email: `user-${randomUUID()}@example.test`,
    displayName: "Test User",
    avatarUrl: undefined,
    provider: "google",
    subscriptionTier: "free",
    subscriptionStatus: "trial",
  };
}

function insertUser(db: DatabaseType, id: string, email: string, oauthId: string): void {
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, ?, ?)").run(
    id,
    email,
    "google",
    oauthId,
  );
}

describe("BACKLOG-3322 deep-link provisioning is one transaction", () => {
  it("D1 a failure after the users_local insert leaves no user and no session", () => {
    const real = seedDb();
    setDb(throwingAfter(real, /INSERT INTO users_local/i));
    expect(() => provisionDeepLinkLogin(deepLinkUser())).toThrow(/INJECTED/);
    expect({ users: count(real, "users_local"), sessions: count(real, "sessions"), audit: count(real, "audit_logs") }).toEqual({
      users: 0,
      sessions: 0,
      audit: 0,
    });
  });

  it("D2 a failure after the sessions insert (new user) leaves no user and no session", () => {
    const real = seedDb();
    setDb(throwingAfter(real, /INSERT INTO sessions/i));
    expect(() => provisionDeepLinkLogin(deepLinkUser())).toThrow(/INJECTED/);
    expect({ users: count(real, "users_local"), sessions: count(real, "sessions"), audit: count(real, "audit_logs") }).toEqual({
      users: 0,
      sessions: 0,
      audit: 0,
    });
  });

  it("D3 email is looked up first: same email under another id and OAuth id gets the session, no UNIQUE throw", () => {
    const real = seedDb();
    setDb(real);
    const u = deepLinkUser();
    insertUser(real, u.supabaseId, u.email, "legacy-subject");
    const r = provisionDeepLinkLogin({ ...u, supabaseId: randomUUID() });
    expect(r.user.id).toBe(u.supabaseId);
    expect(r.isNewUser).toBe(false);
    expect({ users: count(real, "users_local"), sessions: count(real, "sessions") }).toEqual({
      users: 1,
      sessions: 1,
    });
  });

  it("D4 OAuth id fallback: another email, same (provider, oauth id) -> no second user", () => {
    const real = seedDb();
    setDb(real);
    const u = deepLinkUser();
    insertUser(real, u.supabaseId, "earlier-address@example.test", u.supabaseId);
    const r = provisionDeepLinkLogin(u);
    expect(r.user.id).toBe(u.supabaseId);
    expect(r.isNewUser).toBe(false);
    expect({ users: count(real, "users_local"), sessions: count(real, "sessions") }).toEqual({
      users: 1,
      sessions: 1,
    });
  });

  it("D5 legacy id: a user found by email under an old id (with a child row) is migrated; every session is on the Supabase id", async () => {
    const real = seedDb();
    setDb(real);
    const u = deepLinkUser();
    const oldId = randomUUID();
    insertUser(real, oldId, u.email, "legacy-subject");
    real
      .prepare("INSERT INTO sessions (id, user_id, session_token, expires_at) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), oldId, randomUUID(), "2099-01-01");
    const r = await provisionDeepLinkSignIn(u);
    expect(r.user.id).toBe(u.supabaseId);
    const sessionUsers = (real.prepare("SELECT user_id FROM sessions").all() as { user_id: string }[]).map(
      (row) => row.user_id,
    );
    expect(sessionUsers).toEqual([u.supabaseId, u.supabaseId]);
    expect(real.prepare("SELECT id FROM users_local").all()).toEqual([{ id: u.supabaseId }]);
    // BACKLOG-3340: one LOGIN, on the migrated id (the migration writes none).
    expect(real.prepare("SELECT user_id, action FROM audit_logs").all()).toEqual([
      { user_id: u.supabaseId, action: "LOGIN" },
    ]);
  });

  it("D6 heal: a user row with no session (a pre-3322 crash leftover) gets its session on the next sign-in, no second user", async () => {
    const real = seedDb();
    setDb(real);
    const u = deepLinkUser();
    insertUser(real, u.supabaseId, u.email, u.supabaseId);
    const r = await provisionDeepLinkSignIn(u);
    expect(r.isNewUser).toBe(false);
    expect({ users: count(real, "users_local"), sessions: count(real, "sessions") }).toEqual({
      users: 1,
      sessions: 1,
    });
  });

  it("D7 a new user: one user row on the Supabase id and one session row carrying the returned token", async () => {
    const real = seedDb();
    setDb(real);
    const u = deepLinkUser();
    const r = await provisionDeepLinkSignIn(u);
    expect(r.isNewUser).toBe(true);
    expect(r.user.id).toBe(u.supabaseId);
    expect(real.prepare("SELECT user_id, session_token FROM sessions").all()).toEqual([
      { user_id: u.supabaseId, session_token: r.sessionToken },
    ]);
    // BACKLOG-3340: exactly one LOGIN, same commit, with no session or resource id.
    expect(
      real.prepare("SELECT user_id, action, resource_type, resource_id, session_id, success FROM audit_logs").all(),
    ).toEqual([
      {
        user_id: u.supabaseId,
        action: "LOGIN",
        resource_type: "SESSION",
        resource_id: null,
        session_id: null,
        success: 1,
      },
    ]);
    // ...and the session token appears in no column of the row.
    const row = real.prepare("SELECT * FROM audit_logs").get() as Record<string, unknown>;
    const carrying = Object.entries(row)
      .filter(([, v]) => v !== null && String(v).includes(r.sessionToken))
      .map(([k]) => k);
    expect(carrying).toEqual([]);
  });

  it("D8 the legacy-id migration fails (real driver, real UNIQUE conflict): the sign-in still completes on the OLD id, the error is logged not thrown", async () => {
    const real = seedDb();
    setDb(real);
    const u = deepLinkUser();
    const oldId = randomUUID();
    // The legacy user, found by email under an id that is not the Supabase id.
    insertUser(real, oldId, u.email, "legacy-subject");
    // A different row already holds the Supabase id, so the migration's
    // `UPDATE users_local SET id = <supabaseId>` hits the primary key and the
    // real migrateUserIdForUnification throws (and rolls back). Not stubbed.
    insertUser(real, u.supabaseId, `other-${randomUUID()}@example.test`, "other-subject");
    (logService.error as jest.Mock).mockClear();

    const r = await provisionDeepLinkSignIn(u);

    expect(r.user.id).toBe(oldId);
    expect(r.isNewUser).toBe(false);
    expect(real.prepare("SELECT id FROM users_local WHERE email = ?").all(u.email)).toEqual([{ id: oldId }]);
    expect(real.prepare("SELECT user_id, session_token FROM sessions").all()).toEqual([
      { user_id: oldId, session_token: r.sessionToken },
    ]);
    expect(logService.error).toHaveBeenCalledWith(
      "[DeepLink] Failed to migrate local user ID",
      "LoginProvisioning",
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it("D9 the LOGIN insert fails (real CHECK-style abort): no user, no session, no audit row", () => {
    const real = seedDb();
    setDb(real);
    forceAuditInsertFailure(real);
    expect(() => provisionDeepLinkLogin(deepLinkUser())).toThrow(AuditNotRecordedError);
    expect({ users: count(real, "users_local"), sessions: count(real, "sessions"), audit: count(real, "audit_logs") }).toEqual({
      users: 0,
      sessions: 0,
      audit: 0,
    });
  });

  it("D10 existing user, the session insert fails: one LOGIN_FAILED for that user after the rollback, no LOGIN", async () => {
    const real = seedDb();
    const u = deepLinkUser();
    insertUser(real, u.supabaseId, u.email, u.supabaseId);
    setDb(throwingAfter(real, /INSERT INTO sessions/i));
    await expect(provisionDeepLinkSignIn(u)).rejects.toThrow(/INJECTED/);
    await settle();
    expect(count(real, "sessions")).toBe(0);
    expect(real.prepare("SELECT user_id, action, success FROM audit_logs").all()).toEqual([
      { user_id: u.supabaseId, action: "LOGIN_FAILED", success: 0 },
    ]);
  });

  it("D13 legacy user whose migration failed, then the session insert fails: one LOGIN_FAILED on the LEGACY id", async () => {
    const real = seedDb();
    const u = deepLinkUser();
    const oldId = randomUUID();
    // The legacy user, found by email under an id that is not the Supabase id.
    // No row holds the Supabase id, so a LOGIN_FAILED written on it has no
    // users_local row and the foreign key refuses it.
    insertUser(real, oldId, u.email, "legacy-subject");
    // The migration's primary-record update fails (and rolls back), then the
    // provisioning transaction's session insert fails. Injected rather than
    // D8's conflicting row: that row would give the Supabase id a users_local
    // row to point at.
    setDb(throwingAfter(throwingAfter(real, /UPDATE users_local SET id/i), /INSERT INTO sessions/i));
    (logService.error as jest.Mock).mockClear();

    await expect(provisionDeepLinkSignIn(u)).rejects.toThrow(/INJECTED/);
    await settle();

    expect(logService.error).toHaveBeenCalledWith(
      "[DeepLink] Failed to migrate local user ID",
      "LoginProvisioning",
      expect.objectContaining({ error: expect.any(String) }),
    );
    expect(real.prepare("SELECT id FROM users_local").all()).toEqual([{ id: oldId }]);
    expect(count(real, "sessions")).toBe(0);
    expect(real.prepare("SELECT user_id, action, success FROM audit_logs").all()).toEqual([
      { user_id: oldId, action: "LOGIN_FAILED", success: 0 },
    ]);
  });

  it("D11 a first sign-in with a provider users_local refuses (BACKLOG-4096 shape): no rows anywhere, one Sentry report", async () => {
    const real = seedDb();
    setDb(real);
    const u = { ...deepLinkUser(), provider: "email" as never };
    await expect(provisionDeepLinkSignIn(u)).rejects.toThrow(/CHECK constraint/);
    await settle();
    expect({ users: count(real, "users_local"), sessions: count(real, "sessions"), audit: count(real, "audit_logs") }).toEqual({
      users: 0,
      sessions: 0,
      audit: 0,
    });
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "Sign-in failure not written to the audit log",
      expect.objectContaining({ tags: expect.objectContaining({ why: "no_local_user" }) }),
    );
  });

  it("D12 two sign-ins for one user: two sessions, two LOGIN rows, one per sign-in", async () => {
    const real = seedDb();
    setDb(real);
    const u = deepLinkUser();
    await provisionDeepLinkSignIn(u);
    await provisionDeepLinkSignIn(u);
    expect(count(real, "sessions")).toBe(2);
    expect((real.prepare("SELECT action FROM audit_logs").all() as { action: string }[]).map((r) => r.action)).toEqual([
      "LOGIN",
      "LOGIN",
    ]);
  });
});
