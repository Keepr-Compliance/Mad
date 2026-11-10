/**
 * @jest-environment node
 */

/**
 * BACKLOG-4075: unifying a local user id moves EVERY user-owned row.
 *
 * REAL driver, REAL migrated schema (databaseService.runMigrations on a temp
 * file DB), REAL `migrateUserIdForUnification`. Before this item the writer
 * hand-listed 14 tables (3 absent, 3 without `user_id`) and missed 33 of the
 * 41 that reference `users_local`; `foreign_keys = OFF` hid the orphans.
 * The orphan check is SQLite's own `PRAGMA foreign_key_check`, never the
 * code under test.
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../../databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("k"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "k"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});

import { setDb, setDbPath, setEncryptionKey } from "../core/dbConnection";
import { APPEND_ONLY_USER_TABLES, createUserSync, listUserIdColumns, migrateUserIdForUnification } from "../userDbService";
import { createSessionSync } from "../sessionDbService";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

// Invented ids and addresses.
const LEGACY = "40750000-0000-4000-8000-0000000000c9"; // pii-allow-uuid: invented fixture id
const SUPA = "40750000-0000-4000-8000-0000000000a1"; // pii-allow-uuid: invented fixture id
const EMAIL = "agent-4075@example.test";

/** The 8 tables that store the owner's local id in `user_id` with no FK (decided in listUserIdColumns). */
const USER_ID_WITHOUT_FK = [
  "contact_link_proposals",
  "contact_link_verdicts",
  "contact_source_links",
  "mail_folder_names",
  "mail_folder_refs",
  "rcs_cache_staging_chats",
  "rcs_cache_staging_jobs",
  "transaction_unlocks_cache",
];

describe("BACKLOG-4075: migrateUserIdForUnification on the migrated schema", () => {
  jest.setTimeout(120000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any;
  let db: DatabaseType;
  let tmp: string;
  let template: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-4075-unify-"));
    template = path.join(tmp, "template.db");
    db = new RealDatabase(template) as DatabaseType;
    db.pragma("foreign_keys = ON");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    service = require("../../databaseService").default;
    service.db = db;
    service.dbPath = template;
    service.encryptionKey = "k";
    setDb(db);
    setDbPath(template);
    setEncryptionKey("k");
    await service.runMigrations();
    (service.db as DatabaseType).close();
    service.db = null;
  });

  beforeEach(() => {
    const f = path.join(tmp, `case-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    fs.copyFileSync(template, f);
    db = new RealDatabase(f) as DatabaseType;
    db.pragma("foreign_keys = ON");
    setDb(db);
  });

  afterEach(() => {
    db.close();
  });

  afterAll(() => {
    setDb(null as never);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A legacy local user by the real producer, with rows in tables the old hand list missed. */
  function seedLegacy(): void {
    createUserSync({
      id: LEGACY,
      email: EMAIL,
      display_name: "agent",
      oauth_provider: "google",
      oauth_id: "google-sub-legacy",
      subscription_tier: "free",
      subscription_status: "trial",
      is_active: true,
    } as never);
    createSessionSync(LEGACY);
    db.prepare("INSERT INTO transactions (id, user_id, property_address) VALUES ('tx-1', ?, '1 Fixture Way')").run(LEGACY);
    db.prepare("INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES ('ct-1', ?, 'Fixture Contact', 'manual', 1)").run(LEGACY);
    db.prepare("INSERT INTO llm_settings (id, user_id) VALUES ('llm-1', ?)").run(LEGACY);
    db.prepare("INSERT INTO learn_mode_settings (id, user_id, enabled, created_at, updated_at) VALUES ('lm-1', ?, 1, 'x', 'x')").run(LEGACY);
  }

  const owned = (uid: string) =>
    ["transactions", "contacts", "sessions", "llm_settings", "learn_mode_settings"].map(
      (t) => (db.prepare(`SELECT count(*) AS n FROM ${t} WHERE user_id = ?`).get(uid) as { n: number }).n,
    );
  const fkViolations = () => (db.prepare("PRAGMA foreign_key_check").all() as Array<{ table: string }>).map((r) => r.table);

  it("U1 every user-owned row moves: no foreign-key orphans, nothing left under the old id", async () => {
    seedLegacy();
    expect(fkViolations()).toEqual([]);
    await migrateUserIdForUnification(LEGACY, SUPA);
    expect((db.prepare("SELECT id FROM users_local").all() as Array<{ id: string }>).map((r) => r.id)).toEqual([SUPA]);
    expect(owned(SUPA)).toEqual([1, 1, 1, 1, 1]);
    expect(owned(LEGACY)).toEqual([0, 0, 0, 0, 0]);
    expect(fkViolations()).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("U2 the derived list is every FK to users_local plus exactly the 8 user_id tables without one", () => {
    const fkTables = (db.prepare(
      "SELECT DISTINCT m.name AS t FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type = 'table' AND f.\"table\" = 'users_local' ORDER BY 1",
    ).all() as Array<{ t: string }>).map((r) => r.t);
    expect(fkTables.length).toBeGreaterThan(30);
    const derived = listUserIdColumns(db);
    expect(derived.every((d) => d.column === "user_id")).toBe(true);
    expect(derived.map((d) => d.table).sort()).toEqual([...fkTables, ...USER_ID_WITHOUT_FK].sort());
  });

  it("U4 a legacy user with audit history: unification still commits; audit rows keep the acting id (append-only)", async () => {
    seedLegacy();
    db.prepare("INSERT INTO audit_logs (id, user_id, action, resource_type) VALUES ('al-1', ?, 'LOGIN', 'SESSION')").run(LEGACY);
    await migrateUserIdForUnification(LEGACY, SUPA);
    expect(owned(SUPA)).toEqual([1, 1, 1, 1, 1]);
    expect((db.prepare("SELECT user_id FROM audit_logs").all() as Array<{ user_id: string }>).map((r) => r.user_id)).toEqual([LEGACY]);
    expect(fkViolations()).toEqual(["audit_logs"]);
  });

  it("U5 the only user-owned table with an update-refusing trigger is the append-only list", () => {
    const owners = new Set(listUserIdColumns(db).map((d) => d.table));
    const refusing = (db.prepare(
      "SELECT DISTINCT tbl_name AS t FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%BEFORE UPDATE%' AND sql LIKE '%RAISE%'",
    ).all() as Array<{ t: string }>).map((r) => r.t).filter((t) => owners.has(t));
    expect(refusing.sort()).toEqual([...APPEND_ONLY_USER_TABLES].sort());
  });

  it("U3 a failure rolls everything back and leaves foreign keys ON", async () => {
    seedLegacy();
    // A second local row already holding the target id: the users_local UPDATE collides on the primary key.
    createUserSync({ id: SUPA, email: "other-4075@example.test", oauth_provider: "google", oauth_id: SUPA, is_active: true } as never);
    expect((db.prepare("SELECT id FROM users_local ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id)).toEqual([SUPA, LEGACY]);
    // Not `.rejects.toThrow`: the native driver's SqliteError can come from another
    // test file's realm in the same worker, so `instanceof Error` (which toThrow
    // relies on) is false and jest reports "did not throw". Match the message.
    let err: unknown = null;
    try {
      await migrateUserIdForUnification(LEGACY, SUPA);
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/UNIQUE constraint failed: users_local\.id/);
    expect(owned(LEGACY)).toEqual([1, 1, 1, 1, 1]);
    expect(fkViolations()).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});
