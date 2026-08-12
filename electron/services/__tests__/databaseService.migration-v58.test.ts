/**
 * @jest-environment node
 *
 * Integration test for migration v58 (BACKLOG-2407 — per-source contact
 * identity capture).
 *
 * v58 adds `external_contacts.source_identity_json`, where the iPhone and
 * Android import paths park the identifiers that cannot be recovered later:
 * ABPerson's ExternalIdentifier / ExternalModificationTag / ModificationDate /
 * CreationDate / StoreID, and Android's LOOKUP_KEY. (ABPerson.ExternalUUID does
 * NOT land here — it reuses v57's `external_uuid`, because it is the same
 * concept as the macOS ZEXTERNALUUID that column was created for.)
 *
 * Properties this file locks in:
 *
 *  1. THE COLUMN EXISTS AND HOLDS JSON. Asserted by writing and reading a value
 *     back through `json_extract`, not by reading the DDL text — which would
 *     prove only that the statement was written down.
 *  2. NOTHING ELSE ON THE TABLE MOVES. The pre-existing column set is asserted
 *     unchanged and the new column appended, so an ADD COLUMN cannot quietly
 *     disturb a table that four import paths write to.
 *  3. NO INDEX IS CREATED. The index-name set is snapshotted before and after
 *     and asserted equal. Nothing queries this column, and an index shipped
 *     without its query is dead weight on a hot table (the v56 ruling).
 *  4. RE-RUNNING IS SAFE. The guarded ADD COLUMN is idempotent — the migration
 *     runner is not the only thing that can invoke a migration.
 *  5. IT NO-OPS WITHOUT ITS PARENT TABLE, mirroring v48/v52..v57, so a minimal
 *     partial-schema fixture does not throw.
 *  6. NO BACKFILL RUNS. There is nothing in the database to backfill FROM —
 *     these values live on the device — so a migration that populated anything
 *     would be inventing data. Zero-populated-after-upgrade is asserted rather
 *     than assumed.
 *  7. schema.sql DOES NOT DECLARE IT, so this migration is the single source on
 *     both install paths and schema-parity needs no KNOWN_DRIFT pin.
 *
 * Follows the v47..v57 convention: real better-sqlite3 driver via the
 * node_modules require() bypass, in-memory DB via createMigrationHarness, seeded
 * at 57 AND clipped to 58 so ONLY v58 runs.
 */

import fs from "fs";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — identical pattern to databaseService.migration-v57.test.ts
// ---------------------------------------------------------------------------

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock("../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../contactsService", () => ({ getContactNames: jest.fn(() => Promise.resolve([])) }));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";

const USER_ID = "user-v58-test";

/**
 * Post-v57 / pre-v58 shape: `external_contacts` WITH `external_uuid` (v57 added
 * it) and WITHOUT `source_identity_json`. Two indexes so the index-delta
 * assertion is a real comparison rather than empty-set == empty-set.
 */
const PRE_V58_FIXTURE = `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);

  CREATE TABLE external_contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT,
    phones_json TEXT,
    phones_normalized_json TEXT,
    emails_json TEXT,
    company TEXT,
    last_message_at DATETIME,
    external_record_id TEXT,
    source TEXT DEFAULT 'macos',
    synced_at DATETIME,
    sync_session_id TEXT,
    external_uuid TEXT,
    UNIQUE(user_id, source, external_record_id)
  );

  CREATE INDEX idx_external_contacts_user ON external_contacts(user_id);
  CREATE INDEX idx_external_contacts_source ON external_contacts(user_id, source);

  CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migrated_at TEXT DEFAULT (datetime('now'))
  );
`;

/** The column set `external_contacts` carries BEFORE v58, in order. */
const PRE_V58_COLUMNS = [
  "id",
  "user_id",
  "name",
  "phones_json",
  "phones_normalized_json",
  "emails_json",
  "company",
  "last_message_at",
  "external_record_id",
  "source",
  "synced_at",
  "sync_session_id",
  "external_uuid",
];

function columns(db: DatabaseType, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function schemaVersion(db: DatabaseType): number {
  return (
    db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }
  ).version;
}

function indexNames(db: DatabaseType): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

describe("databaseService migration v58 (BACKLOG-2407 — source_identity_json)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(PRE_V58_FIXTURE);
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
  });

  afterEach(async () => {
    if (harness) {
      try {
        await harness.cleanup();
      } catch {
        /* already cleaned */
      }
    }
  });

  /**
   * Seed at v57 AND clip the chain at v58 so ONLY v58 runs. Clipping rather than
   * relying on 57 being head-minus-one keeps every assertion here a statement
   * about v58 when v59 lands.
   */
  async function runV58(): Promise<void> {
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 57)").run();
    const klass = harness.service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const all = klass.MIGRATIONS;
    klass.MIGRATIONS = all.filter((m) => m.version <= 58);
    try {
      await harness.service._runVersionedMigrations();
    } finally {
      klass.MIGRATIONS = all;
    }
  }

  it("advances schema_version to 58", async () => {
    await runV58();
    expect(schemaVersion(harness.db)).toBe(58);
  });

  it("appends source_identity_json and disturbs no existing column", async () => {
    expect(columns(harness.db, "external_contacts")).toEqual(PRE_V58_COLUMNS);

    await runV58();

    // Four import paths write this table. An ADD COLUMN that reordered or
    // dropped anything would be silent until one of them broke in the field.
    expect(columns(harness.db, "external_contacts")).toEqual([
      ...PRE_V58_COLUMNS,
      "source_identity_json",
    ]);
  });

  it("actually stores and reads back JSON — not merely a declared column", async () => {
    await runV58();

    harness.db
      .prepare(
        `INSERT INTO external_contacts (id, user_id, source, external_record_id, source_identity_json)
         VALUES (?, ?, 'android_sync', ?, ?)`,
      )
      .run("row-1", USER_ID, "android-dev-1-101", JSON.stringify({ lookupKey: "0r1-4A3B2C" }));

    // Read it back the way a future promotion migration would, so the column is
    // proven usable for the `json_extract` path its comment promises.
    const got = harness.db
      .prepare(
        `SELECT json_extract(source_identity_json, '$.lookupKey') AS k
           FROM external_contacts WHERE id = 'row-1'`,
      )
      .get() as { k: string };
    expect(got.k).toBe("0r1-4A3B2C");
  });

  it("creates NO index — nothing queries this column", async () => {
    const before = indexNames(harness.db);
    await runV58();
    // Asserted as an exact set, not a count: an index appearing under a
    // different name would otherwise slip through.
    expect(indexNames(harness.db)).toEqual(before);
  });

  it("is idempotent — re-running does not throw or duplicate the column", async () => {
    await runV58();
    const after = columns(harness.db, "external_contacts");

    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 57)").run();
    await expect(runV58()).resolves.not.toThrow();

    expect(columns(harness.db, "external_contacts")).toEqual(after);
  });

  it("no-ops when external_contacts is absent", async () => {
    harness.db.exec("DROP TABLE external_contacts");
    // Mirrors the v48/v52..v57 guard: a minimal partial-schema fixture may not
    // have the parent table, and the chain must still advance.
    await expect(runV58()).resolves.not.toThrow();
    expect(schemaVersion(harness.db)).toBe(58);
  });

  it("runs NO backfill — pre-existing rows keep a null column", async () => {
    harness.db
      .prepare(
        `INSERT INTO external_contacts (id, user_id, source, external_record_id, external_uuid)
         VALUES (?, ?, 'iphone', ?, ?)`,
      )
      .run("legacy-1", USER_ID, "1", "11111111-1111-4111-8111-111111111111");

    await runV58();

    // There is nothing to backfill FROM: these identifiers live on the device,
    // not in this database. A migration that populated anything would be
    // inventing data. The next ordinary sync fills them in for free.
    const row = harness.db
      .prepare(`SELECT external_uuid, source_identity_json FROM external_contacts WHERE id = 'legacy-1'`)
      .get() as { external_uuid: string | null; source_identity_json: string | null };

    expect(row.source_identity_json).toBeNull();
    // v57's capture is untouched by v58.
    expect(row.external_uuid).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("is NOT declared in schema.sql — the migration is the single source", () => {
    // Enforced rather than left as a comment. Declaring it in schema.sql would
    // give fresh installs (which start at v32) a different shape from upgraded
    // ones, and a standalone CREATE INDEX on it there would throw on every real
    // upgrade because schema.sql is exec'd BEFORE the chain (BACKLOG-2298/2300).
    const schemaSql = fs.readFileSync(
      path.join(__dirname, "..", "..", "database", "schema.sql"),
      "utf8",
    );
    expect(schemaSql).not.toContain("source_identity_json");
  });
});
