/**
 * @jest-environment node
 *
 * BACKLOG-2546 — login provisioning is one unit, against the REAL driver and the
 * REAL shipped schema.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS GUARDS
 * ---------------------------------------------------------------------------
 * Four login paths used to write the user row, the token row and the session row
 * as separately-autocommitted statements. A failure part way through left a
 * partially provisioned account, and the first such state was permanent: once the
 * user row exists, the next login takes the update branch and never re-runs
 * new-user provisioning. `provisionLogin` puts the whole chain in one
 * transaction; these controls prove each partial state is now unreachable.
 *
 * ---------------------------------------------------------------------------
 * HOW THE FAILURE IS INJECTED, AND WHY NOT WITH A MODULE SPY
 * ---------------------------------------------------------------------------
 * The throw is injected by a Proxy over the REAL driver, keyed to the SQL that
 * production actually executes — the `auditLogTriggerAtomicity-2548` pattern.
 * Nothing is transcribed and nothing is re-implemented, so a control cannot pass
 * against a copy of the code that has drifted from the original.
 *
 * It matters that the throw fires INSIDE the transaction body. A spy on the
 * `databaseService` facade fires outside it and would prove nothing — and the
 * facade is not even on this path any more, which is why it is mocked to an
 * empty object below: if any write were still routed through it, every control
 * here would fail loudly rather than silently exercise the wrong code.
 *
 * ---------------------------------------------------------------------------
 * WHICH CONTROL DRIVES WHICH ENTRY POINT
 * ---------------------------------------------------------------------------
 * `provisionLogin` never writes `session.json` — the handler does. So the
 * controls that involve the file boundary, and the two happy-path logins, drive
 * `handleCompletePendingLogin` end to end with only its edges mocked. The rest
 * drive `provisionLogin` directly.
 *
 * `handleGoogleLogin` and `handleMicrosoftLogin` sit behind the OAuth window and
 * the code exchange and are NOT driven end to end by this file. They are covered
 * only through `provisionLogin` (H3/H4 are their shape). Stated, not implied.
 *
 * ---------------------------------------------------------------------------
 * MUTATIONS THAT MAKE IT RED (run at adoption; re-run before recommending)
 * ---------------------------------------------------------------------------
 *   - remove the `dbTransaction` wrapper in `provisionLogin`      -> C1, C2, C4, C5
 *   - use `provisioned.user` instead of `existingBefore` for the
 *     post-commit terms sync                                      -> C6
 *   - pass `{}` instead of skipping an omitted `updateExisting`   -> H4
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 npx electron node_modules/.bin/jest \
 *     electron/services/db/__tests__/loginProvisioningAtomicity-2546.test.ts --bail=0
 */

import * as nodePath from "path";
import * as fs from "fs";
import * as os from "os";
import { spawnSync } from "child_process";
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

// --- the handler's edges. The db layer stays REAL. -------------------------
// `databaseService` is deliberately an empty object: nothing on this path may
// route through the facade any more, and this makes that a test failure rather
// than a silent success.
jest.mock("../../databaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../supabaseService", () => ({
  __esModule: true,
  default: {
    syncTermsAcceptance: jest.fn(),
    registerDevice: jest.fn(),
    trackEvent: jest.fn(),
    validateSubscription: jest.fn(),
  },
}));
jest.mock("../../auditService", () => ({ __esModule: true, default: { log: jest.fn() } }));
jest.mock("../../sessionService", () => ({
  __esModule: true,
  default: { saveSession: jest.fn(), getSessionExpirationMs: jest.fn(() => 24 * 60 * 60 * 1000) },
}));
jest.mock("../../../handlers/syncHandlers", () => ({ setSyncUserId: jest.fn() }));

import { setDb } from "../core/dbConnection";
import { provisionLogin } from "../../loginProvisioningService";
import sessionService from "../../sessionService";
import supabaseService from "../../supabaseService";
import { handleCompletePendingLogin } from "../../../handlers/sharedAuthHandlers";
import type { IpcMainInvokeEvent } from "electron";

const REPO_ROOT = nodePath.join(__dirname, "..", "..", "..", "..");
const SCHEMA_PATH = nodePath.join(REPO_ROOT, "electron", "database", "schema.sql");

// Generated per run rather than written down: a UUID literal in a PUBLIC repo
// has no shape that distinguishes an invented id from a live one, so the fixture
// guard cannot tell them apart and neither can a reader (BACKLOG-2871).
const CLOUD_ID = randomUUID();
const OAUTH_ID = "oauth-subject-1";

let tmpDir: string;
let childPath: string;
let caseNo = 0;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function openDb(dbPath: string): DatabaseType {
  const db = new Database(dbPath) as unknown as DatabaseType;
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  return db;
}

/** Fresh DB at `dbPath` carrying the real shipped schema. */
function seedDb(dbPath: string): DatabaseType {
  const db = openDb(dbPath);
  db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
  return db;
}

function dbPathFor(name: string): string {
  caseNo += 1;
  return nodePath.join(tmpDir, `${caseNo}-${name}.db`);
}

function counts(db: DatabaseType): { users: number; tokens: number; sessions: number } {
  const one = (t: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return { users: one("users_local"), tokens: one("oauth_tokens"), sessions: one("sessions") };
}

function userRow(db: DatabaseType, id: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM users_local WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
}

/**
 * The REAL driver, wrapped so that the FIRST statement whose SQL matches
 * `pattern` throws immediately after it has run. The write really happens and
 * the transaction really has to undo it — a throw before the statement would
 * prove far less.
 */
function dbThrowingAfter(real: DatabaseType, pattern: RegExp): DatabaseType {
  let fired = false;
  return new Proxy(real, {
    get(target, prop) {
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      if (prop === "prepare") {
        return (sqlText: string) => {
          const stmt = (value as (s: string) => unknown).call(target, sqlText) as Record<
            string | symbol,
            unknown
          >;
          return new Proxy(stmt, {
            get(st, p) {
              const sv = st[p];
              if (p === "run") {
                return (...args: unknown[]) => {
                  const r = (sv as (...a: unknown[]) => unknown).apply(st, args);
                  if (!fired && pattern.test(sqlText)) {
                    fired = true;
                    throw new Error(`INJECTED FAILURE after: ${pattern}`);
                  }
                  return r;
                };
              }
              return typeof sv === "function" ? (sv as (...a: unknown[]) => unknown).bind(st) : sv;
            },
          });
        };
      }
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as DatabaseType;
}

/** The request shape the four login paths build, with the parts each control varies. */
function request(overrides: Partial<Parameters<typeof provisionLogin>[0]> = {}) {
  return {
    provider: "google" as const,
    oauthId: OAUTH_ID,
    create: {
      id: CLOUD_ID,
      email: "fixture-user@example.test",
      display_name: "Fixture User",
      oauth_provider: "google" as const,
      oauth_id: OAUTH_ID,
      subscription_tier: "free" as const,
      subscription_status: "trial" as const,
      is_active: true,
    },
    touchLastLogin: true,
    token: {
      purpose: "authentication" as const,
      data: {
        access_token: "fixture-access-token",
        refresh_token: "fixture-refresh-token",
        token_expires_at: "2099-01-01T00:00:00.000Z",
        scopes_granted: "scope-a scope-b",
      },
    },
    ...overrides,
  };
}

/**
 * The IPC payload `handleCompletePendingLogin` takes. Derived from the handler's
 * own signature rather than restated, so a change to the payload type breaks
 * this file instead of silently drifting from it.
 */
type PendingPayload = Parameters<typeof handleCompletePendingLogin>[1];

function pendingPayload(overrides: Partial<PendingPayload> = {}): PendingPayload {
  return {
    provider: "google" as const,
    userInfo: {
      id: OAUTH_ID,
      email: "fixture-user@example.test",
      given_name: "Fixture",
      family_name: "User",
      name: "Fixture User",
    },
    tokens: {
      access_token: "fixture-access-token",
      refresh_token: "fixture-refresh-token",
      expires_at: "2099-01-01T00:00:00.000Z",
      scopes: ["scope-a", "scope-b"],
    },
    cloudUser: { id: CLOUD_ID, subscription_tier: "free", subscription_status: "trial" },
    ...overrides,
  };
}

const NO_EVENT = undefined as unknown as IpcMainInvokeEvent;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "login-2546-"));
  childPath = nodePath.join(tmpDir, "crashChild.js");
  fs.writeFileSync(childPath, CHILD_SOURCE, "utf8");
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  (sessionService.getSessionExpirationMs as jest.Mock).mockReturnValue(24 * 60 * 60 * 1000);
  // The success value the real `saveSession` returns. A bare `jest.fn()` resolves
  // `undefined`, which is a value that producer never emits.
  (sessionService.saveSession as jest.Mock).mockResolvedValue(true);
});

// ===========================================================================
// FORCED-CRASH CONTROLS
// ===========================================================================

describe("BACKLOG-2546 · a failed login leaves no partial account", () => {
  it("C1: a failure after the user row is written leaves NO users_local row (the ghost account)", () => {
    const path = dbPathFor("c1");
    const real = seedDb(path);
    setDb(dbThrowingAfter(real, /INSERT INTO users_local/i));

    expect(() => provisionLogin(request())).toThrow(/INJECTED FAILURE/);

    // The worst case named by the item, and the one that was PERMANENT: a user
    // row with no token and no session is never re-provisioned, because the next
    // login sees the row and takes the update branch.
    expect(counts(real)).toEqual({ users: 0, tokens: 0, sessions: 0 });
    real.close();
  });

  it("C2: a failure after the token row is written leaves NO orphan token", () => {
    const path = dbPathFor("c2");
    const real = seedDb(path);
    setDb(dbThrowingAfter(real, /INSERT INTO oauth_tokens/i));

    expect(() => provisionLogin(request())).toThrow(/INJECTED FAILURE/);

    expect(counts(real)).toEqual({ users: 0, tokens: 0, sessions: 0 });
    real.close();
  });

  it("C4: on a RETURNING user, a failure at the session row rolls the profile update back too", () => {
    const path = dbPathFor("c4");
    const real = seedDb(path);
    setDb(real);

    // A completed first login, so the second one takes the update branch.
    provisionLogin(request());
    const before = userRow(real, CLOUD_ID) as Record<string, unknown>;
    expect(before.display_name).toBe("Fixture User");

    setDb(dbThrowingAfter(real, /INSERT INTO sessions/i));
    expect(() =>
      provisionLogin(request({ updateExisting: { display_name: "Renamed By Failed Login" } })),
    ).toThrow(/INJECTED FAILURE/);

    const after = userRow(real, CLOUD_ID) as Record<string, unknown>;
    // The update and the last-login stamp are in the SAME unit as the session
    // row, so neither survives.
    expect(after.display_name).toBe("Fixture User");
    expect(after.last_login_at).toBe(before.last_login_at);
    expect(counts(real)).toEqual({ users: 1, tokens: 1, sessions: 1 });
    real.close();
  });
});

// ===========================================================================
// THE FILE BOUNDARY — the one state the transaction cannot cover
// ===========================================================================

describe("BACKLOG-2546 · a crash after the commit but before session.json", () => {
  it("C3: the commit STANDS, the login reports failure, and a retry produces a usable session", async () => {
    const path = dbPathFor("c3");
    const real = seedDb(path);
    setDb(real);

    // The real producer CANNOT reject. `saveSession` (sessionService.ts:287) returns
    // `runSerialized(() => this._writeSession(...))`; `_writeSession` wraps its whole body
    // in one try/catch that returns `false`, and `runSerialized` chains off a `writeLock`
    // that is reset through `.then(() => undefined, () => undefined)` and is therefore
    // always resolved. A disk-full session write RESOLVES FALSE. Transcribed from that
    // producer, not invented — BACKLOG-3299.
    (sessionService.saveSession as jest.Mock).mockResolvedValueOnce(false);

    const failed = await handleCompletePendingLogin(NO_EVENT, pendingPayload());

    // The decision recorded in the plan: no compensating delete. The rows stay.
    expect(failed.success).toBe(false);
    expect(counts(real)).toEqual({ users: 1, tokens: 1, sessions: 1 });

    // And this is what separates "recoverable" from "ghost": the account is
    // fully provisioned, so the next attempt completes normally.
    (sessionService.saveSession as jest.Mock).mockResolvedValueOnce(true);
    const retried = await handleCompletePendingLogin(NO_EVENT, pendingPayload());

    expect(retried.success).toBe(true);
    expect(retried.sessionToken).toBeTruthy();
    const session = real
      .prepare("SELECT user_id FROM sessions WHERE session_token = ?")
      .get(retried.sessionToken) as { user_id: string } | undefined;
    expect(session?.user_id).toBe(CLOUD_ID);
    real.close();
  });
});

// ===========================================================================
// THE POST-COMMIT CLOUD SYNC READS THE PRE-UPDATE SNAPSHOT
// ===========================================================================

describe("BACKLOG-2546 · the cloud terms sync still reads pre-update values", () => {
  it("C6: with cloud privacy present and cloud terms absent, the sync gets the PRE-update version", async () => {
    const path = dbPathFor("c6");
    const real = seedDb(path);
    setDb(real);

    // A user who accepted locally, at an older privacy version than the cloud's.
    provisionLogin(
      request({
        updateOnCreate: {
          terms_accepted_at: "2026-01-01T00:00:00.000Z",
          terms_version_accepted: "local-terms-v1",
          privacy_policy_accepted_at: "2026-01-01T00:00:00.000Z",
          privacy_policy_version_accepted: "local-privacy-v1",
        },
      }),
    );

    // Cloud terms ABSENT (so the sync-up fires) but cloud privacy PRESENT — the
    // combination in which `updateExisting` DOES overwrite
    // `privacy_policy_version_accepted`. If the caller ever reads the committed
    // row instead of the snapshot, this assertion moves to "cloud-privacy-v9".
    await handleCompletePendingLogin(
      NO_EVENT,
      pendingPayload({
        cloudUser: {
          id: CLOUD_ID,
          subscription_tier: "free",
          subscription_status: "trial",
          privacy_policy_accepted_at: "2026-06-01T00:00:00.000Z",
          privacy_policy_version_accepted: "cloud-privacy-v9",
        },
      }),
    );

    expect(supabaseService.syncTermsAcceptance).toHaveBeenCalledWith(
      CLOUD_ID,
      "local-terms-v1",
      "local-privacy-v1",
    );
    // …and the local row really was updated, so the snapshot is genuinely stale.
    expect(userRow(real, CLOUD_ID)?.privacy_policy_version_accepted).toBe("cloud-privacy-v9");
    real.close();
  });
});

// ===========================================================================
// HAPPY PATHS — both branches, on the real driver and the real schema
// ===========================================================================

describe("BACKLOG-2546 · a normal login still works", () => {
  it("H1: a FIRST login writes exactly one user, one token and one session", async () => {
    const path = dbPathFor("h1");
    const real = seedDb(path);
    setDb(real);

    const result = await handleCompletePendingLogin(NO_EVENT, pendingPayload());

    expect(result.success).toBe(true);
    expect(counts(real)).toEqual({ users: 1, tokens: 1, sessions: 1 });
    expect(userRow(real, CLOUD_ID)?.email).toBe("fixture-user@example.test");
    expect(sessionService.saveSession).toHaveBeenCalledTimes(1);
    const saved = (sessionService.saveSession as jest.Mock).mock.calls[0][0];
    expect(saved.user.id).toBe(CLOUD_ID);
    expect(saved.sessionToken).toBe(result.sessionToken);
    real.close();
  });

  it("H2: a REPEAT login updates the one user, upserts the one token, and adds a session", async () => {
    const path = dbPathFor("h2");
    const real = seedDb(path);
    setDb(real);

    await handleCompletePendingLogin(NO_EVENT, pendingPayload());
    const first = userRow(real, CLOUD_ID) as Record<string, unknown>;

    // Force a distinguishable second timestamp.
    real.prepare("UPDATE users_local SET last_login_at = '2000-01-01 00:00:00' WHERE id = ?").run(CLOUD_ID);

    const second = await handleCompletePendingLogin(
      NO_EVENT,
      pendingPayload({
        userInfo: {
          id: OAUTH_ID,
          email: "fixture-user@example.test",
          given_name: "Fixture",
          family_name: "User",
          name: "Renamed Fixture",
        },
      }),
    );

    expect(second.success).toBe(true);
    // No duplicate user, no duplicate token (ON CONFLICT upsert), a second session.
    expect(counts(real)).toEqual({ users: 1, tokens: 1, sessions: 2 });
    const after = userRow(real, CLOUD_ID) as Record<string, unknown>;
    expect(after.display_name).toBe("Renamed Fixture");
    expect(after.last_login_at).not.toBe("2000-01-01 00:00:00");
    expect(first.id).toBe(after.id);
    expect(sessionService.saveSession).toHaveBeenCalledTimes(2);
    real.close();
  });

  it("H3: the token-less, last-login-less shape writes a user and a session and NO token", () => {
    const path = dbPathFor("h3");
    const real = seedDb(path);
    setDb(real);

    const result = provisionLogin(
      request({ token: undefined, touchLastLogin: false }),
    );

    expect(result.isNewUser).toBe(true);
    expect(counts(real)).toEqual({ users: 1, tokens: 0, sessions: 1 });
    expect(userRow(real, CLOUD_ID)?.last_login_at).toBeNull();
    real.close();
  });

  it("H4: an omitted `updateExisting` SKIPS the update instead of sending an empty one", () => {
    const path = dbPathFor("h4");
    const real = seedDb(path);
    setDb(real);

    provisionLogin(request({ token: undefined, touchLastLogin: false }));
    const before = userRow(real, CLOUD_ID) as Record<string, unknown>;

    // `updateUser` throws `DatabaseError("No valid fields to update")` on an empty
    // column set. Inside this transaction that would roll back the whole login,
    // so an omitted update must never become `updateUserSync(id, {})`.
    const result = provisionLogin(request({ token: undefined, touchLastLogin: false }));

    expect(result.isNewUser).toBe(false);
    expect(counts(real)).toEqual({ users: 1, tokens: 0, sessions: 2 });
    expect(userRow(real, CLOUD_ID)).toEqual(before);
    real.close();
  });
});

// ===========================================================================
// C5 — the same boundary under a REAL process death, not a thrown exception
// ===========================================================================

const CHILD_SOURCE = `
const Module = require('module');
const path = require('path');
const fs = require('fs');
const REPO = process.argv[2];
const DB_PATH = process.argv[3];
const KILL_AT = process.argv[4];

// The same two substitutions jest makes via moduleNameMapper for every other
// test in this repo. The raw child bypasses the mapper, so it makes them itself.
// Neither module is under test; the production code and the driver stay real.
const noop = () => undefined;
const SENTRY_STUB = {
  captureException: noop, captureMessage: noop, init: noop, setTag: noop,
  setUser: noop, addBreadcrumb: noop, flush: () => Promise.resolve(true),
  withScope: (cb) => cb({ setTag: noop, setExtra: noop }),
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return { app: { getAppPath: () => REPO, getPath: () => path.dirname(DB_PATH), getVersion: () => '0.0.0-test' } };
  }
  if (request === '@sentry/electron' || request.indexOf('@sentry/electron/') === 0) {
    return SENTRY_STUB;
  }
  return origLoad.apply(this, arguments);
};

require(path.join(REPO, 'node_modules', 'ts-node')).register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true },
});

const Database = require(path.join(REPO, 'node_modules', 'better-sqlite3-multiple-ciphers'));
const realDb = new Database(DB_PATH);
realDb.pragma('journal_mode = WAL');
realDb.pragma('synchronous = NORMAL');

// KILL-POINT SENTINEL. Written to a plain file, NOT the database: a database
// write at the kill point would be inside the transaction under test and would
// roll back with it, so it could never be observed. Without it, a production
// function that throws on entry leaves this control asserting the untouched
// seeded state and passing. fsync'd before the SIGKILL so it cannot be lost.
const kill = (where) => {
  const fd = fs.openSync(DB_PATH + '.killpoint', 'w');
  fs.writeSync(fd, where);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  process.kill(process.pid, 'SIGKILL');
};

// Keyed to the production SQL AS EXECUTED. Nothing is copied.
const dbProxy = new Proxy(realDb, {
  get(target, prop) {
    const value = target[prop];
    if (prop === 'prepare') {
      return (sql) => {
        const stmt = value.call(target, sql);
        return new Proxy(stmt, {
          get(st, p) {
            const sv = st[p];
            if (p === 'run') {
              return (...args) => {
                const rr = sv.apply(st, args);
                if (KILL_AT === 'in-transaction' && /INSERT INTO sessions/i.test(sql)) kill('in-transaction');
                return rr;
              };
            }
            return typeof sv === 'function' ? sv.bind(st) : sv;
          },
        });
      };
    }
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

const dbConnection = require(path.join(REPO, 'electron/services/db/core/dbConnection.ts'));
const login = require(path.join(REPO, 'electron/services/loginProvisioningService.ts'));
dbConnection.setDb(dbProxy);

// IMPORT MARKER, written only once BOTH production modules have imported
// successfully. Position is load-bearing: written before the requires, an import
// failure would still stamp it and the control would pass while proving nothing.
realDb.pragma('user_version = 4242');

try {
  login.provisionLogin(JSON.parse(process.argv[5]));
  // The transaction has COMMITTED and returned. This stands in for the instant
  // before sessionService.saveSession writes session.json.
  if (KILL_AT === 'after-commit') kill('after-commit');
  realDb.close();
  process.exit(0);
} catch (e) {
  console.error(String((e && e.message) || e));
  process.exit(2);
}
`;

interface ChildRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  spawnError?: Error;
}

function runCrashChild(dbPath: string, killAt: string, req: unknown): ChildRun {
  const r = spawnSync(process.execPath, [childPath, REPO_ROOT, dbPath, killAt, JSON.stringify(req)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TS_NODE_TRANSPILE_ONLY: "true" },
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    status: r.status,
    signal: r.signal,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    spawnError: r.error,
  };
}

/**
 * THE VACUITY GUARD. A control whose child never reached the kill point is
 * asserting the untouched seeded state, which any broken production function
 * would also satisfy. It must fail loudly, and it must print the child's stderr
 * — the diagnosis is otherwise unavailable.
 */
function assertReachedKillPoint(dbPath: string, run: ChildRun, expected: string): void {
  const sentinel = `${dbPath}.killpoint`;
  const got = fs.existsSync(sentinel) ? fs.readFileSync(sentinel, "utf8") : null;
  if (got !== expected) {
    throw new Error(
      `CHILD NEVER REACHED THE KILL POINT (expected \`${expected}\`, sentinel ${
        got === null ? "absent" : `= \`${got}\``
      }). This control proves NOTHING.\n` +
        `  spawn error : ${run.spawnError ? run.spawnError.message : "none"}\n` +
        `  exit status : ${String(run.status)}   signal: ${String(run.signal)}\n` +
        `  child stdout: ${run.stdout.trim() || "(empty)"}\n` +
        `  child stderr: ${run.stderr.trim() || "(empty)"}`,
    );
  }
}

describe("BACKLOG-2546 · the commit survives a real process death", () => {
  it("C5a: SIGKILL'd INSIDE the transaction, the database keeps NOTHING", () => {
    const path = dbPathFor("c5a");
    seedDb(path).close();

    const run = runCrashChild(path, "in-transaction", request());
    assertReachedKillPoint(path, run, "in-transaction");

    const reopened = openDb(path);
    // The import marker: both production modules loaded before the kill.
    expect(reopened.pragma("user_version", { simple: true })).toBe(4242);

    // Stronger than C1/C2: those unwind a thrown exception, this is the process
    // dying with the write already issued. The rollback survives real death and
    // WAL recovery, so the ghost account is unreachable that way too.
    expect(counts(reopened)).toEqual({ users: 0, tokens: 0, sessions: 0 });
    reopened.close();
  });

  it("C5b: SIGKILL'd AFTER the commit, the account is complete and session.json is absent", () => {
    const path = dbPathFor("c5b");
    seedDb(path).close();

    const run = runCrashChild(path, "after-commit", request());
    assertReachedKillPoint(path, run, "after-commit");

    const reopened = openDb(path);
    expect(reopened.pragma("user_version", { simple: true })).toBe(4242);

    // The §4 decision under a real process death rather than a thrown error: the
    // committed account stands, no compensating delete runs, and the session file
    // never lands. That state is recoverable — C3 drives the retry that proves it.
    expect(counts(reopened)).toEqual({ users: 1, tokens: 1, sessions: 1 });
    expect(fs.existsSync(nodePath.join(nodePath.dirname(path), "session.json"))).toBe(false);
    reopened.close();
  });
});
