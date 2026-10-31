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

import { setDb } from "../core/dbConnection";
import type { PendingDeepLinkUser } from "../../signInState";
import { provisionDeepLinkLogin, provisionDeepLinkSignIn } from "../../loginProvisioningService";

const SCHEMA_PATH = nodePath.join(__dirname, "..", "..", "..", "database", "schema.sql");

let tmpDir: string;
const opened: DatabaseType[] = [];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "deeplink-3322-"));
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

function count(db: DatabaseType, table: "users_local" | "sessions"): number {
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
    expect({ users: count(real, "users_local"), sessions: count(real, "sessions") }).toEqual({
      users: 0,
      sessions: 0,
    });
  });

  it("D2 a failure after the sessions insert (new user) leaves no user and no session", () => {
    const real = seedDb();
    setDb(throwingAfter(real, /INSERT INTO sessions/i));
    expect(() => provisionDeepLinkLogin(deepLinkUser())).toThrow(/INJECTED/);
    expect({ users: count(real, "users_local"), sessions: count(real, "sessions") }).toEqual({
      users: 0,
      sessions: 0,
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
  });
});
