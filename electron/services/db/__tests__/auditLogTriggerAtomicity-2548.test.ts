/**
 * @jest-environment node
 *
 * BACKLOG-2548 — the audit-log immutability trigger, against the REAL driver and
 * the REAL shipped schema.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS GUARDS, AND WHY EACH CONTROL EXISTS
 * ---------------------------------------------------------------------------
 * `markAuditLogsSynced` performs the one write the append-only trigger forbids,
 * so it drops `prevent_audit_update`, updates, and puts it back. Two things were
 * wrong with that, both reproduced before the fix was written:
 *
 *   1. THE STANDING HOLE. The DDL it put back was a drifted hand-copy carrying
 *      `WHEN NEW.synced_at IS NULL OR OLD.synced_at IS NOT NULL`. That clause
 *      constrains `synced_at` and nothing else, so after the first completed
 *      sync any UPDATE that also set `synced_at` could rewrite `action`,
 *      `user_id`, `resource_id`, `metadata` and `timestamp` on a not-yet-synced
 *      row. It was permanent: `schema.sql` uses CREATE TRIGGER IF NOT EXISTS, so
 *      restarting never repaired it. Guarded by C3 (identity) and C4 (behaviour).
 *
 *   2. THE CRASH WINDOW. The three statements autocommitted separately, so a
 *      kill in between left the table with no trigger at all. Guarded by C1
 *      (kill after DROP) and C6 (kill after UPDATE — worse, because it also
 *      leaves the rows marked synced, so the next sync skips them and nothing
 *      ever prompts a repair). C2 pins the benign half of the window.
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE — NO DDL IS WRITTEN BY HAND IN THIS FILE
 * ---------------------------------------------------------------------------
 * The database is built by exec'ing the shipped `electron/database/schema.sql`
 * (pattern from `forceStagingRealSchema-2790.test.ts`), and C3 compares
 * `sqlite_master` against the trigger extracted from that same file at run time.
 * A transcript embedded here would drift exactly the way the production copy did
 * — which is the defect this suite exists to catch — so there is no transcript.
 *
 * The crash controls do NOT re-implement the drop/update/recreate sequence. They
 * spawn a child that loads and calls the PRODUCTION `markAuditLogsSynced`
 * through ts-node, and get their deterministic kill from a Proxy over the driver
 * that fires on the SQL production actually executes. A transcribed copy would
 * stay green when the `db.transaction()` wrapper is removed, which would make
 * C1/C6 worthless.
 *
 * ---------------------------------------------------------------------------
 * MUTATIONS THAT MAKE IT RED (run at adoption; re-run before recommending)
 * ---------------------------------------------------------------------------
 *   - remove the `db.transaction()` wrapper in `markAuditLogsSynced` -> C1, C6
 *   - restore the `WHEN ...` clause on PREVENT_AUDIT_UPDATE_DDL             -> C3, C4
 *   - remove `AND synced_at IS NULL` from the UPDATE                        -> C7
 *   - recreate unconditionally with no DROP                                 -> C5
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     electron/services/db/__tests__/auditLogTriggerAtomicity-2548.test.ts --bail=0
 */

import * as nodePath from "path";
import * as fs from "fs";
import * as os from "os";
import { spawnSync } from "child_process";
import type { Database as DatabaseType } from "better-sqlite3";

// The driver is moduleNameMapper'd to a mock for the rest of the suite, so the
// real one has to be reached by absolute path.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));

import { setDb } from "../core/dbConnection";
import { markAuditLogsSynced } from "../auditLogDbService";

const REPO_ROOT = nodePath.join(__dirname, "..", "..", "..", "..");
const SCHEMA_PATH = nodePath.join(REPO_ROOT, "electron", "database", "schema.sql");

const USER_ID = "user-fixture-1";
const OTHER_USER_ID = "user-fixture-2";

let tmpDir: string;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Whitespace- and IF-NOT-EXISTS-insensitive comparison of two CREATE TRIGGER texts. */
function normalizeDdl(sql: string): string {
  return sql
    .replace(/\bIF\s+NOT\s+EXISTS\s+/gi, "")
    .replace(/\s+/g, " ")
    .replace(/;\s*$/, "")
    .trim();
}

/** The prevent_audit_update trigger as the SHIPPED schema declares it, read at run time. */
function schemaTriggerDdl(): string {
  const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
  const m = schema.match(
    /CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?prevent_audit_update[\s\S]*?END\s*;/i,
  );
  if (!m) {
    throw new Error("prevent_audit_update not found in electron/database/schema.sql");
  }
  return normalizeDdl(m[0]);
}

function triggerSql(db: DatabaseType): string | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='prevent_audit_update'")
    .get() as { sql: string } | undefined;
  return row ? row.sql : null;
}

function openDb(dbPath: string): DatabaseType {
  const db = new Database(dbPath) as unknown as DatabaseType;
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  return db;
}

/** Fresh DB at `dbPath` carrying the real schema, one user, and `ids` unsynced audit rows. */
function seedDb(dbPath: string, ids: string[]): DatabaseType {
  const db = openDb(dbPath);
  db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));
  const insertUser = db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  );
  insertUser.run(USER_ID, "fixture-1@example.test", "oauth-1");
  insertUser.run(OTHER_USER_ID, "fixture-2@example.test", "oauth-2");
  const insertLog = db.prepare(
    "INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, metadata, timestamp) " +
      "VALUES (?, ?, 'LOGIN', 'session', ?, ?, ?)",
  );
  ids.forEach((id, i) =>
    insertLog.run(id, USER_ID, `res-${i}`, '{"seeded":true}', `2026-01-0${i + 1}T00:00:00.000Z`),
  );
  return db;
}

function syncedAtOf(db: DatabaseType, id: string): string | null {
  const row = db.prepare("SELECT synced_at FROM audit_logs WHERE id = ?").get(id) as
    | { synced_at: string | null }
    | undefined;
  return row ? row.synced_at : null;
}

/** Busy-wait so two ISO timestamps in the same test are guaranteed to differ. */
function advanceClock(): void {
  const start = Date.now();
  while (Date.now() === start) {
    /* spin */
  }
}

// ---------------------------------------------------------------------------
// crash-control child: loads and calls the PRODUCTION function, kills itself
// at a point keyed to the SQL production actually executes.
// ---------------------------------------------------------------------------

const CHILD_SOURCE = `
const Module = require('module');
const path = require('path');
const REPO = process.argv[2];
const DB_PATH = process.argv[3];
const KILL_AT = process.argv[4];
const IDS = process.argv.slice(5);

// 'electron' must be stubbed before anything imports it: under ELECTRON_RUN_AS_NODE
// require('electron') yields the executable path string, so a module-scope
// app.getPath() would throw on import.
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return { app: { getAppPath: () => REPO, getPath: () => path.dirname(DB_PATH) } };
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

const kill = () => process.kill(process.pid, 'SIGKILL');

// The kill points are keyed to the production SQL AS EXECUTED. Nothing is copied.
const dbProxy = new Proxy(realDb, {
  get(target, prop) {
    const value = target[prop];
    if (prop === 'exec') {
      return (sql) => {
        const r = value.call(target, sql);
        if (KILL_AT === 'after-drop' && /^\\s*DROP\\s+TRIGGER/i.test(sql)) kill();
        return r;
      };
    }
    if (prop === 'prepare') {
      return (sql) => {
        const stmt = value.call(target, sql);
        return new Proxy(stmt, {
          get(st, p) {
            const sv = st[p];
            if (p === 'run') {
              return (...args) => {
                const rr = sv.apply(st, args);
                if (KILL_AT === 'after-update' && /^\\s*UPDATE\\s+audit_logs/i.test(sql)) kill();
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

require(path.join(REPO, 'electron/services/db/core/dbConnection.ts')).setDb(dbProxy);

if (KILL_AT === 'before-drop') kill();

require(path.join(REPO, 'electron/services/db/auditLogDbService.ts'))
  .markAuditLogsSynced(IDS)
  .then(() => { realDb.close(); process.exit(0); })
  .catch((e) => { console.error(String((e && e.message) || e)); process.exit(2); });
`;

let childPath: string;

/**
 * Run the production markAuditLogsSynced in a child, killing it at `killAt`.
 * Asserting on the child's exit signal is NOT reliable — the electron launcher
 * reports status 1 / signal null for these kills — so every assertion in this
 * file is made against the reopened database instead.
 */
function runCrashChild(dbPath: string, killAt: string, ids: string[]): void {
  spawnSync(process.execPath, [childPath, REPO_ROOT, dbPath, killAt, ...ids], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TS_NODE_TRANSPILE_ONLY: "true" },
    encoding: "utf8",
    timeout: 120_000,
  });
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "audit-2548-"));
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

let caseNo = 0;
function dbPathFor(name: string): string {
  caseNo += 1;
  return nodePath.join(tmpDir, `${caseNo}-${name}.db`);
}

// ===========================================================================
// C3 / C4 / C5 / C7 / C8 — in-process, against the production function
// ===========================================================================

describe("BACKLOG-2548 · the trigger the sync path leaves behind", () => {
  it("C3: after a completed sync, sqlite_master still matches schema.sql's trigger exactly", async () => {
    const db = seedDb(dbPathFor("c3"), ["a1", "a2"]);
    setDb(db);

    const before = triggerSql(db);
    expect(before).not.toBeNull();
    expect(normalizeDdl(before as string)).toBe(schemaTriggerDdl());

    await markAuditLogsSynced(["a1"]);

    const after = triggerSql(db);
    expect(after).not.toBeNull();
    // RED before the fix: the recreated copy carried a WHEN clause the schema has not.
    expect(normalizeDdl(after as string)).toBe(schemaTriggerDdl());
    expect(after as string).not.toMatch(/\bWHEN\b/i);

    db.close();
  });

  it("C4: after a completed sync, the trigger still REFUSES a tampering update on an unsynced row", async () => {
    const db = seedDb(dbPathFor("c4"), ["a1", "a2"]);
    setDb(db);

    await markAuditLogsSynced(["a1"]);

    // a2 is still unsynced. This is the exact shape the drifted WHEN clause let through.
    expect(() =>
      db
        .prepare(
          "UPDATE audit_logs SET action = ?, user_id = ?, resource_id = ?, metadata = ?, " +
            "timestamp = ?, synced_at = ? WHERE id = 'a2'",
        )
        .run("LOGOUT", OTHER_USER_ID, "forged", '{"forged":true}', "1999-01-01T00:00:00.000Z", "2026-02-02T00:00:00.000Z"),
    ).toThrow(/Audit logs cannot be modified/);

    const row = db
      .prepare("SELECT action, user_id, resource_id, timestamp FROM audit_logs WHERE id = 'a2'")
      .get() as { action: string; user_id: string; resource_id: string; timestamp: string };
    expect(row).toEqual({
      action: "LOGIN",
      user_id: USER_ID,
      resource_id: "res-1",
      timestamp: "2026-01-02T00:00:00.000Z",
    });

    db.close();
  });

  it("C5: the synced_at transition itself still works (the fix is not 'always abort')", async () => {
    const db = seedDb(dbPathFor("c5"), ["a1", "a2"]);
    setDb(db);

    await markAuditLogsSynced(["a1", "a2"]);

    expect(syncedAtOf(db, "a1")).not.toBeNull();
    expect(syncedAtOf(db, "a2")).not.toBeNull();
    // and the immutability trigger is back on
    expect(triggerSql(db)).not.toBeNull();

    db.close();
  });

  it("C7: a re-sync preserves the original synced_at, and a mixed batch still marks the unsynced row", async () => {
    const db = seedDb(dbPathFor("c7"), ["a1", "a2"]);
    setDb(db);

    await markAuditLogsSynced(["a1"]);
    const firstStamp = syncedAtOf(db, "a1");
    expect(firstStamp).not.toBeNull();

    advanceClock();

    // Mixed batch: a1 already synced, a2 not.
    await markAuditLogsSynced(["a1", "a2"]);

    // RED without `AND synced_at IS NULL`: a1's original timestamp gets overwritten.
    expect(syncedAtOf(db, "a1")).toBe(firstStamp);
    const secondStamp = syncedAtOf(db, "a2");
    expect(secondStamp).not.toBeNull();
    expect(secondStamp).not.toBe(firstStamp);

    db.close();
  });

  it("C8: works inside a caller's transaction (raw BEGIN IMMEDIATE), and an outer ROLLBACK restores the strict trigger", async () => {
    const db = seedDb(dbPathFor("c8a"), ["a1", "a2"]);
    setDb(db);

    db.exec("BEGIN IMMEDIATE");
    expect(db.inTransaction).toBe(true);
    await expect(markAuditLogsSynced(["a1"])).resolves.toBeUndefined();
    db.exec("ROLLBACK");

    const sql = triggerSql(db);
    expect(sql).not.toBeNull();
    expect(normalizeDdl(sql as string)).toBe(schemaTriggerDdl());
    expect(syncedAtOf(db, "a1")).toBeNull();

    db.close();
  });

  it("C8: works inside an outer db.transaction(), and its rollback restores the strict trigger", async () => {
    const db = seedDb(dbPathFor("c8b"), ["a1", "a2"]);
    setDb(db);

    // markAuditLogsSynced is `async` but does no awaiting, so all of its database
    // work completes synchronously inside the callback. The promise is CAPTURED
    // rather than returned (better-sqlite3 rejects a transaction function that
    // returns one) and awaited below — left floating, a rejection would take the
    // whole jest worker down as an unhandled rejection instead of failing a test.
    let inner: Promise<void> | undefined;
    const outer = db.transaction(() => {
      inner = markAuditLogsSynced(["a1"]);
      throw new Error("outer rollback");
    });
    expect(() => outer()).toThrow("outer rollback");
    // The inner call must NOT have thrown: nested, better-sqlite3 uses a SAVEPOINT.
    await expect(inner).resolves.toBeUndefined();

    const sql = triggerSql(db);
    expect(sql).not.toBeNull();
    expect(normalizeDdl(sql as string)).toBe(schemaTriggerDdl());
    expect(syncedAtOf(db, "a1")).toBeNull();

    db.close();
  });
});

// ===========================================================================
// C1 / C2 / C6 — process kills inside the production function
// ===========================================================================

describe("BACKLOG-2548 · a crash during the sync write", () => {
  it("C1: killed between the DROP and the recreate, the database still has the strict trigger", () => {
    const dbPath = dbPathFor("c1");
    seedDb(dbPath, ["a1", "a2"]).close();

    runCrashChild(dbPath, "after-drop", ["a1"]);

    const db = openDb(dbPath);
    const sql = triggerSql(db);
    // RED before the fix: TRIGGER ABSENT — the append-only guarantee was simply off.
    expect(sql).not.toBeNull();
    expect(normalizeDdl(sql as string)).toBe(schemaTriggerDdl());
    expect(syncedAtOf(db, "a1")).toBeNull();
    db.close();
  });

  it("C6: killed after the UPDATE, the trigger is back AND the rows are not falsely marked synced", () => {
    const dbPath = dbPathFor("c6");
    seedDb(dbPath, ["a1", "a2"]).close();

    runCrashChild(dbPath, "after-update", ["a1"]);

    const db = openDb(dbPath);
    const sql = triggerSql(db);
    // RED before the fix: trigger ABSENT *and* synced_at WRITTEN — so the next sync
    // skips the row and nothing ever prompts a repair.
    expect(sql).not.toBeNull();
    expect(normalizeDdl(sql as string)).toBe(schemaTriggerDdl());
    expect(syncedAtOf(db, "a1")).toBeNull();
    db.close();
  });

  it("C2: killed before the DROP, the trigger is untouched and the rows stay unsynced", () => {
    const dbPath = dbPathFor("c2");
    seedDb(dbPath, ["a1", "a2"]).close();

    runCrashChild(dbPath, "before-drop", ["a1"]);

    const db = openDb(dbPath);
    const sql = triggerSql(db);
    expect(sql).not.toBeNull();
    expect(normalizeDdl(sql as string)).toBe(schemaTriggerDdl());
    expect(syncedAtOf(db, "a1")).toBeNull();
    db.close();
  });

  it("the crash harness really does run the PRODUCTION function (no kill -> the row is synced)", () => {
    const dbPath = dbPathFor("harness");
    seedDb(dbPath, ["a1", "a2"]).close();

    runCrashChild(dbPath, "none", ["a1"]);

    const db = openDb(dbPath);
    // If this fails, the child never reached markAuditLogsSynced and C1/C2/C6 are vacuous.
    expect(syncedAtOf(db, "a1")).not.toBeNull();
    expect(syncedAtOf(db, "a2")).toBeNull();
    const sql = triggerSql(db);
    expect(sql).not.toBeNull();
    expect(normalizeDdl(sql as string)).toBe(schemaTriggerDdl());
    db.close();
  });
});
