/**
 * @jest-environment node
 *
 * Integration test for migration v48 (BACKLOG-1900 P0.1 — distinct contact sources).
 *
 * v48 widens the `contacts.source` CHECK constraint from
 *   ('manual','email','sms','contacts_app','inferred','android_sync')
 * to add the distinct per-origin values 'iphone', 'outlook', 'google_contacts'.
 *
 * `databaseService.schema-parity.test.ts` compares only PRAGMA table_info +
 * foreign_key_list (and normalizes whitespace only for triggers/views), so
 * CHECK-text divergence is INVISIBLE to it. This dedicated test asserts the
 * observable behaviour of the CHECK on BOTH install paths:
 *
 *   1. MIGRATED path — a pre-v48 contacts table (narrow CHECK) is rebuilt by the
 *      v48 migration; each new value INSERTs successfully afterwards, an invalid
 *      value is still REJECTED, and the contact_lookup view, the
 *      update_contacts_timestamp trigger, and all 4 contacts indexes survive.
 *
 *   2. FRESH-INSTALL path — the real electron/database/schema.sql is exec()'d,
 *      then _runVersionedMigrations() runs; the same insert-succeeds /
 *      insert-rejects behaviour holds (guards against schema.sql drifting from
 *      the migration's widened CHECK).
 *
 * Follows the migration-v40..v47 convention: real better-sqlite3 driver via the
 * node_modules require() bypass, in-memory DB via createMigrationHarness.
 */

import path from "path";
import fs from "fs";
import { jest } from "@jest/globals";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — identical pattern to databaseService.migration-v47.test.ts
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

// ---------------------------------------------------------------------------
// IMPORTS
// ---------------------------------------------------------------------------

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

// The exact file the app reads on a fresh install
// (databaseService.ts: path.join(__dirname, "../database/schema.sql")).
const SCHEMA_SQL_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");

function readSchemaSql(): string {
  return fs.readFileSync(SCHEMA_SQL_PATH, "utf8");
}

// ---------------------------------------------------------------------------
// FIXTURES / HELPERS
// ---------------------------------------------------------------------------

const USER_ID = "user-v48-test";

/**
 * Pre-v48 contacts shape: the post-v36 table with the NARROW source CHECK
 * (no 'iphone'/'outlook'/'google_contacts'), plus the view, trigger, and all 4
 * indexes v48 must preserve. schema_version starts at 47 so ONLY v48 runs.
 */
const PRE_V48_FIXTURE = `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);

  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    company TEXT,
    title TEXT,
    source TEXT DEFAULT 'manual' CHECK (source IN ('manual', 'email', 'sms', 'contacts_app', 'inferred', 'android_sync')),
    last_inbound_at DATETIME,
    last_outbound_at DATETIME,
    total_messages INTEGER DEFAULT 0,
    tags TEXT,
    is_imported INTEGER DEFAULT 1,
    default_role TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
  );

  CREATE TABLE contact_emails (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    email TEXT NOT NULL,
    is_primary INTEGER DEFAULT 0,
    source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );

  CREATE TABLE contact_phones (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    phone_e164 TEXT NOT NULL,
    phone_display TEXT,
    is_primary INTEGER DEFAULT 0,
    source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );

  CREATE INDEX idx_contacts_user_id ON contacts(user_id);
  CREATE INDEX idx_contacts_display_name ON contacts(display_name);
  CREATE INDEX idx_contacts_is_imported ON contacts(is_imported);
  CREATE INDEX idx_contacts_user_imported ON contacts(user_id, is_imported);

  CREATE TRIGGER update_contacts_timestamp
  AFTER UPDATE ON contacts
  BEGIN
    UPDATE contacts SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;

  CREATE VIEW contact_lookup AS
  SELECT
    c.id as contact_id,
    c.user_id,
    c.display_name,
    ce.email,
    cp.phone_e164 as phone
  FROM contacts c
  LEFT JOIN contact_emails ce ON c.id = ce.contact_id
  LEFT JOIN contact_phones cp ON c.id = cp.contact_id;

  CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migrated_at TEXT DEFAULT (datetime('now'))
  );
`;

// Values that must be ACCEPTED by the widened CHECK after v48.
const NEW_VALID_SOURCES = ["iphone", "outlook", "google_contacts", "android_sync"] as const;
// A value that must still be REJECTED.
const INVALID_SOURCE = "totally_not_a_source";

let rowCounter = 0;
function insertContact(db: DatabaseType, source: string): void {
  rowCounter += 1;
  db.prepare(
    "INSERT INTO contacts (id, user_id, display_name, source) VALUES (?, ?, ?, ?)",
  ).run(`contact-${source}-${rowCounter}`, USER_ID, `Contact ${source}`, source);
}

function objectExists(
  db: DatabaseType,
  type: "view" | "trigger" | "index",
  name: string,
): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
    .get(type, name) as { name: string } | undefined;
  return row?.name === name;
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe("databaseService migration v48 (BACKLOG-1900 P0.1 — distinct contact sources)", () => {
  let harness: MigrationHarness;

  afterEach(async () => {
    if (harness) {
      try {
        await harness.cleanup();
      } catch {
        /* already cleaned */
      }
    }
  });

  it("sanity: real better-sqlite3 driver is wired (not the jest auto-mock)", () => {
    expect(typeof RealDatabase).toBe("function");
    harness = createMigrationHarness({ seedV29Schema: false });
    expect(Array.isArray(harness.db.pragma("user_version"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Block 1: MIGRATED path — pre-v48 narrow CHECK → v48 rebuild.
  // -------------------------------------------------------------------------

  describe("migrated path (pre-v48 fixture, schema_version=47)", () => {
    beforeEach(async () => {
      harness = createMigrationHarness({ seedV29Schema: false });
      harness.db.exec(PRE_V48_FIXTURE);
      harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
      harness.db.prepare("INSERT INTO schema_version (id, version) VALUES (1, 47)").run();
      await harness.service._runVersionedMigrations();
    });

    it("advances schema_version past 48 to the latest migration", () => {
      // The pre-v48 fixture starts at 47, so the runner applies v48 and every
      // migration after it (v49+ added by later work). Assert v48 was reached AND
      // the final version equals the newest migration in the array — decoupled from
      // a hardcoded number so adding a migration after v48 does not break this test.
      const migrations = harness.service.constructor.MIGRATIONS as Array<{ version: number }>;
      const latest = migrations[migrations.length - 1].version;
      expect(latest).toBeGreaterThanOrEqual(48);

      const row = harness.db
        .prepare("SELECT version FROM schema_version WHERE id = 1")
        .get() as { version: number };
      expect(row.version).toBe(latest);
    });

    it.each(NEW_VALID_SOURCES)(
      "accepts an insert with the new source value '%s' after v48",
      (source) => {
        expect(() => insertContact(harness.db, source)).not.toThrow();

        const stored = harness.db
          .prepare("SELECT source FROM contacts WHERE source = ?")
          .get(source) as { source: string } | undefined;
        expect(stored?.source).toBe(source);
      },
    );

    it("still rejects an insert with an invalid source value after v48", () => {
      expect(() => insertContact(harness.db, INVALID_SOURCE)).toThrow(
        /CHECK constraint failed/i,
      );
    });

    it("preserves the contact_lookup view, update_contacts_timestamp trigger, and all 4 indexes", () => {
      expect(objectExists(harness.db, "view", "contact_lookup")).toBe(true);
      expect(objectExists(harness.db, "trigger", "update_contacts_timestamp")).toBe(true);
      for (const idx of [
        "idx_contacts_user_id",
        "idx_contacts_display_name",
        "idx_contacts_is_imported",
        "idx_contacts_user_imported",
      ]) {
        expect(objectExists(harness.db, "index", idx)).toBe(true);
      }
    });

    it("preserves child contact_phones / contact_emails rows through the rebuild (no cascade wipe)", async () => {
      // Data-safety regression guard: the v48 contacts rebuild does DROP TABLE contacts.
      // With foreign_keys=ON that would cascade-delete every child row. The migration
      // runner disables FKs around the loop precisely to prevent this. Seed a contact
      // WITH children BEFORE v48 runs and assert they survive.
      await harness.cleanup();
      harness = createMigrationHarness({ seedV29Schema: false });
      harness.db.exec(PRE_V48_FIXTURE);
      harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
      harness.db
        .prepare("INSERT INTO contacts (id, user_id, display_name, source) VALUES (?, ?, ?, ?)")
        .run("parent-1", USER_ID, "Parent Contact", "contacts_app");
      harness.db
        .prepare(
          "INSERT INTO contact_emails (id, contact_id, email) VALUES (?, ?, ?)",
        )
        .run("email-1", "parent-1", "parent@example.com");
      harness.db
        .prepare(
          "INSERT INTO contact_phones (id, contact_id, phone_e164) VALUES (?, ?, ?)",
        )
        .run("phone-1", "parent-1", "+14155550000");
      harness.db.prepare("INSERT INTO schema_version (id, version) VALUES (1, 47)").run();

      await harness.service._runVersionedMigrations();

      const emailCount = (
        harness.db
          .prepare("SELECT COUNT(*) c FROM contact_emails WHERE contact_id = ?")
          .get("parent-1") as { c: number }
      ).c;
      const phoneCount = (
        harness.db
          .prepare("SELECT COUNT(*) c FROM contact_phones WHERE contact_id = ?")
          .get("parent-1") as { c: number }
      ).c;
      expect(emailCount).toBe(1);
      expect(phoneCount).toBe(1);
    });

    it("preserves pre-existing contact rows through the table rebuild", async () => {
      // Fresh harness so the pre-existing row is seeded BEFORE v48 runs.
      await harness.cleanup();
      harness = createMigrationHarness({ seedV29Schema: false });
      harness.db.exec(PRE_V48_FIXTURE);
      harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
      harness.db
        .prepare("INSERT INTO contacts (id, user_id, display_name, source) VALUES (?, ?, ?, ?)")
        .run("pre-existing-1", USER_ID, "Legacy Contact", "contacts_app");
      harness.db.prepare("INSERT INTO schema_version (id, version) VALUES (1, 47)").run();

      await harness.service._runVersionedMigrations();

      const row = harness.db
        .prepare("SELECT display_name, source FROM contacts WHERE id = ?")
        .get("pre-existing-1") as { display_name: string; source: string } | undefined;
      expect(row?.display_name).toBe("Legacy Contact");
      expect(row?.source).toBe("contacts_app");
    });

    it("is idempotent — re-running the runner keeps the latest version and does not error", async () => {
      const migrations = harness.service.constructor.MIGRATIONS as Array<{ version: number }>;
      const latest = migrations[migrations.length - 1].version;
      await expect(harness.service._runVersionedMigrations()).resolves.toBeUndefined();
      const row = harness.db
        .prepare("SELECT version FROM schema_version WHERE id = 1")
        .get() as { version: number };
      expect(row.version).toBe(latest);
    });
  });

  // -------------------------------------------------------------------------
  // Block 2: FRESH-INSTALL path — real schema.sql → migrations.
  // -------------------------------------------------------------------------

  describe("fresh-install path (real schema.sql, then migrations)", () => {
    beforeEach(async () => {
      harness = createMigrationHarness({ seedV29Schema: false });
      harness.db.exec(readSchemaSql());
      await harness.service._runVersionedMigrations();
      // Real schema.sql's users_local enforces NOT NULL email/oauth_provider/oauth_id
      // (and foreign_keys=ON), so a minimal id-only insert would be silently ignored
      // and the contacts FK would then fail. Insert a fully valid user row.
      harness.db
        .prepare(
          "INSERT OR IGNORE INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, ?, ?)",
        )
        .run(USER_ID, `${USER_ID}@example.com`, "google", `oauth-${USER_ID}`);
    });

    it("reaches the latest migration version", () => {
      // A fresh install runs the full chain, ending at the newest migration (>= 48).
      const migrations = harness.service.constructor.MIGRATIONS as Array<{ version: number }>;
      const latest = migrations[migrations.length - 1].version;
      const row = harness.db
        .prepare("SELECT version FROM schema_version WHERE id = 1")
        .get() as { version: number };
      expect(row.version).toBe(latest);
    });

    it.each(NEW_VALID_SOURCES)(
      "accepts an insert with the new source value '%s' on a fresh install",
      (source) => {
        expect(() => insertContact(harness.db, source)).not.toThrow();
      },
    );

    it("still rejects an insert with an invalid source value on a fresh install", () => {
      expect(() => insertContact(harness.db, INVALID_SOURCE)).toThrow(
        /CHECK constraint failed/i,
      );
    });

    it("has the contact_lookup view, update_contacts_timestamp trigger, and all 4 indexes", () => {
      expect(objectExists(harness.db, "view", "contact_lookup")).toBe(true);
      expect(objectExists(harness.db, "trigger", "update_contacts_timestamp")).toBe(true);
      for (const idx of [
        "idx_contacts_user_id",
        "idx_contacts_display_name",
        "idx_contacts_is_imported",
        "idx_contacts_user_imported",
      ]) {
        expect(objectExists(harness.db, "index", idx)).toBe(true);
      }
    });
  });
});
