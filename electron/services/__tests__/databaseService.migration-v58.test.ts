/**
 * @jest-environment node
 *
 * Integration test for migration v58 (BACKLOG-2410 — the contact link review
 * queue, its verdicts, and the `unique_name` match method).
 *
 * v58 does three things, and each has a way of going wrong that CI has already
 * missed once in this codebase:
 *
 *  1. CREATES `contact_link_proposals`. The pair UNIQUE is what makes a re-run
 *     idempotent, so it is asserted by INSERTing a colliding row and requiring
 *     the conflict — not by reading the DDL text back, which proves only that
 *     the string was written.
 *  2. CREATES `contact_link_verdicts`. Asserted to have NO foreign key to
 *     `contacts`: the verdicts are the labelled ground-truth set, and an
 *     ON DELETE CASCADE would delete them as a side effect of ordinary contact
 *     cleanup. That is the kind of thing that reads as a sensible default in
 *     review and is unrecoverable in production.
 *  3. REBUILDS `contact_source_links` to admit `unique_name`. A table rebuild
 *     is the highest-risk shape of migration there is, so the EXISTING ROWS ARE
 *     SEEDED FIRST and their exact ids, values and column alignment asserted
 *     afterwards. A positional `SELECT *` copy would pass a row-count check and
 *     fail this one.
 *
 * PLUS the real upgrade path. `insight_migration_upgrade_path_untested`: a
 * migration can pass every test in this repo and still break a real old->new
 * upgrade, because the suites either call `_runVersionedMigrations` on a
 * synthetic fixture or seed schema.sql at HEAD. The last describe here starts
 * from a REAL v57-shaped database WITH DATA and runs the chain, which is the
 * path a user on v2.27.0 actually takes.
 */

import path from "path";
import { jest } from "@jest/globals";
import type { Database as DatabaseType } from "better-sqlite3";

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

const USER_ID = "user-v58";

/**
 * A REAL post-v57 database: the v57 crosswalk exactly as that migration writes
 * it, including the five-value `match_method` CHECK that v58 has to widen.
 */
const PRE_V58_FIXTURE = `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);

  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    removed_at DATETIME,
    removed_reason DATETIME,
    FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
  );

  CREATE TABLE external_contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT,
    phones_json TEXT,
    emails_json TEXT,
    external_record_id TEXT,
    source TEXT DEFAULT 'macos',
    synced_at DATETIME,
    external_uuid TEXT,
    UNIQUE(user_id, source, external_record_id)
  );

  CREATE TABLE contact_source_links (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (
      source_type IN ('macos', 'iphone', 'outlook', 'google_contacts', 'android_sync')
    ),
    source_record_id TEXT NOT NULL,
    external_uuid TEXT,
    match_method TEXT NOT NULL CHECK (
      match_method IN ('source_id', 'email', 'phone', 'manual', 'scored')
    ),
    confidence REAL,
    matched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    evidence_ref TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    UNIQUE (user_id, source_type, source_record_id)
  );
  CREATE INDEX idx_contact_source_links_contact ON contact_source_links(contact_id);
  CREATE INDEX idx_contacts_user_id ON contacts(user_id);

  CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migrated_at TEXT DEFAULT (datetime('now'))
  );
`;

function tableExists(db: DatabaseType, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) !==
    undefined
  );
}

function indexNames(db: DatabaseType): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function foreignKeys(db: DatabaseType, table: string): string[] {
  return (
    db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>
  ).map((r) => r.table);
}

describe("databaseService migration v58 (BACKLOG-2410 — review queue + verdicts)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(PRE_V58_FIXTURE);
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
    harness.db
      .prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)")
      .run("c-alpha", USER_ID, "Alpha Person");
    harness.db
      .prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)")
      .run("c-beta", USER_ID, "Beta Person");
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

  /** Seed at 57 and clip at 58 so ONLY v58 runs. */
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

  function seedExistingLinks(): void {
    const stmt = harness.db.prepare(
      `INSERT INTO contact_source_links
         (id, user_id, contact_id, source_type, source_record_id, external_uuid,
          match_method, confidence, matched_at, evidence_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      "l-1", USER_ID, "c-alpha", "macos", "mac-1", "uuid-1",
      "source_id", null, "2026-01-01 00:00:00", null, "2026-01-01 00:00:00", "2026-01-02 00:00:00",
    );
    stmt.run(
      "l-2", USER_ID, "c-beta", "outlook", "out-9", null,
      "email", null, "2026-02-02 00:00:00", "ev-7", "2026-02-02 00:00:00", "2026-02-03 00:00:00",
    );
  }

  // =========================================================================
  describe("the queue table", () => {
    it("is created and reaches version 58", async () => {
      expect(tableExists(harness.db, "contact_link_proposals")).toBe(false);
      await runV58();
      expect(tableExists(harness.db, "contact_link_proposals")).toBe(true);
      expect(
        (harness.db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
          version: number;
        }).version,
      ).toBe(58);
    });

    it("enforces one proposal per pair — the half of 'never re-proposed' that lives in the schema", async () => {
      await runV58();
      const insert = (id: string) =>
        harness.db
          .prepare(
            `INSERT INTO contact_link_proposals
               (id, user_id, contact_id, source_type, source_record_id, reason,
                identity_assessment, relationship_assessment, cluster_key)
             VALUES (?, ?, 'c-alpha', 'macos', 'mac-1', 'ambiguous_identifier',
                     'possibly_same_person', 'possibly_connected', 'contact:c-alpha')`,
          )
          .run(id, USER_ID);

      insert("p-1");
      expect(() => insert("p-2")).toThrow(/UNIQUE/i);

      // INSERT OR IGNORE — the production write — is a silent no-op instead.
      const ignored = harness.db
        .prepare(
          `INSERT OR IGNORE INTO contact_link_proposals
             (id, user_id, contact_id, source_type, source_record_id, reason,
              identity_assessment, relationship_assessment, cluster_key)
           VALUES ('p-3', ?, 'c-alpha', 'macos', 'mac-1', 'ambiguous_identifier',
                   'possibly_same_person', 'possibly_connected', 'contact:c-alpha')`,
        )
        .run(USER_ID);
      expect(ignored.changes).toBe(0);
      expect(
        (harness.db.prepare("SELECT id FROM contact_link_proposals").all() as Array<{ id: string }>)
          .map((r) => r.id),
      ).toEqual(["p-1"]);
    });

    it("constrains both vocabularies and the status", async () => {
      await runV58();
      const bad = (col: string, value: string) =>
        harness.db.prepare(
          `INSERT INTO contact_link_proposals
             (id, user_id, contact_id, source_type, source_record_id, status, reason,
              identity_assessment, relationship_assessment, cluster_key)
           VALUES ('x', ?, 'c-alpha', 'macos', 'r1',
                   ${col === "status" ? `'${value}'` : "'pending'"},
                   'ambiguous_identifier',
                   ${col === "identity" ? `'${value}'` : "'possibly_same_person'"},
                   ${col === "relationship" ? `'${value}'` : "'possibly_connected'"},
                   'k')`,
        );

      expect(() => bad("status", "maybe").run(USER_ID)).toThrow(/CHECK/i);
      expect(() => bad("identity", "0.82").run(USER_ID)).toThrow(/CHECK/i);
      expect(() => bad("relationship", "likely").run(USER_ID)).toThrow(/CHECK/i);
    });

    it("cascades a proposal away when its contact is deleted", async () => {
      await runV58();
      harness.db.pragma("foreign_keys = ON");
      harness.db
        .prepare(
          `INSERT INTO contact_link_proposals
             (id, user_id, contact_id, source_type, source_record_id, reason,
              identity_assessment, relationship_assessment, cluster_key)
           VALUES ('p-1', ?, 'c-alpha', 'macos', 'mac-1', 'ambiguous_identifier',
                   'possibly_same_person', 'possibly_connected', 'contact:c-alpha')`,
        )
        .run(USER_ID);

      harness.db.prepare("DELETE FROM contacts WHERE id = 'c-alpha'").run();
      expect(harness.db.prepare("SELECT id FROM contact_link_proposals").all()).toEqual([]);
    });
  });

  // =========================================================================
  describe("the verdicts table", () => {
    /**
     * NEGATIVE CONTROL RUN: added
     * `FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE` to
     * the verdicts DDL in the migration. Observed: both tests below fail — the
     * FK appears in `foreign_key_list` and the verdict is destroyed by an
     * ordinary contact delete, taking the ground-truth label with it.
     */
    it("has NO foreign key to contacts — a verdict outlives the contact", async () => {
      await runV58();
      expect(foreignKeys(harness.db, "contact_link_verdicts")).toEqual([]);
      // The proposals table DOES have one, which is the contrast being drawn.
      expect(foreignKeys(harness.db, "contact_link_proposals")).toEqual(["contacts"]);
    });

    it("survives its contact being deleted", async () => {
      await runV58();
      harness.db.pragma("foreign_keys = ON");
      harness.db
        .prepare(
          `INSERT INTO contact_link_verdicts
             (id, user_id, contact_id, source_type, source_record_id, identity_verdict)
           VALUES ('v-1', ?, 'c-alpha', 'macos', 'mac-1', 'different_people')`,
        )
        .run(USER_ID);

      harness.db.prepare("DELETE FROM contacts WHERE id = 'c-alpha'").run();

      expect(
        (harness.db
          .prepare("SELECT id, identity_verdict FROM contact_link_verdicts")
          .all() as Array<{ id: string; identity_verdict: string }>)
          .map((r) => `${r.id}|${r.identity_verdict}`),
      ).toEqual(["v-1|different_people"]);
    });

    it("allows the same pair to be answered twice — a user may change their mind", async () => {
      await runV58();
      const insert = (id: string, verdict: string) =>
        harness.db
          .prepare(
            `INSERT INTO contact_link_verdicts
               (id, user_id, contact_id, source_type, source_record_id, identity_verdict)
             VALUES (?, ?, 'c-alpha', 'macos', 'mac-1', ?)`,
          )
          .run(id, USER_ID, verdict);

      insert("v-1", "different_people");
      expect(() => insert("v-2", "same_person")).not.toThrow();
      expect(
        (harness.db.prepare("SELECT id FROM contact_link_verdicts ORDER BY id").all() as Array<{
          id: string;
        }>).map((r) => r.id),
      ).toEqual(["v-1", "v-2"]);
    });

    it("refuses a numeric verdict — the vocabulary is words", async () => {
      await runV58();
      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_link_verdicts
               (id, user_id, contact_id, source_type, source_record_id, identity_verdict)
             VALUES ('v-x', ?, 'c-alpha', 'macos', 'mac-1', '0.91')`,
          )
          .run(USER_ID),
      ).toThrow(/CHECK/i);
    });
  });

  // =========================================================================
  describe("the contact_source_links rebuild", () => {
    it("admits unique_name and still refuses an unknown method", async () => {
      // Before: the v57 CHECK rejects it.
      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_source_links
               (id, user_id, contact_id, source_type, source_record_id, match_method)
             VALUES ('l-x', ?, 'c-alpha', 'macos', 'pre', 'unique_name')`,
          )
          .run(USER_ID),
      ).toThrow(/CHECK/i);

      await runV58();

      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_source_links
               (id, user_id, contact_id, source_type, source_record_id, match_method)
             VALUES ('l-x', ?, 'c-alpha', 'macos', 'post', 'unique_name')`,
          )
          .run(USER_ID),
      ).not.toThrow();

      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_source_links
               (id, user_id, contact_id, source_type, source_record_id, match_method)
             VALUES ('l-y', ?, 'c-alpha', 'macos', 'post2', 'vibes')`,
          )
          .run(USER_ID),
      ).toThrow(/CHECK/i);
    });

    /**
     * THE REBUILD'S REAL RISK. A rebuild that copies positionally, or drops a
     * column, or reorders one, passes a row count and corrupts every row.
     *
     * NEGATIVE CONTROL RUN: changed the migration's
     * `INSERT INTO ... SELECT <named columns>` to `INSERT INTO ... SELECT *`.
     * Observed: this test fails on `evidence_ref`/`created_at` misalignment
     * while the row COUNT stays at 2 — which is exactly why the assertion names
     * every field.
     */
    it("carries every existing row across, field for field", async () => {
      seedExistingLinks();
      await runV58();

      const rows = harness.db
        .prepare(
          `SELECT id, user_id, contact_id, source_type, source_record_id, external_uuid,
                  match_method, confidence, matched_at, evidence_ref, created_at, updated_at
             FROM contact_source_links ORDER BY id`,
        )
        .all();

      expect(rows).toEqual([
        {
          id: "l-1",
          user_id: USER_ID,
          contact_id: "c-alpha",
          source_type: "macos",
          source_record_id: "mac-1",
          external_uuid: "uuid-1",
          match_method: "source_id",
          confidence: null,
          matched_at: "2026-01-01 00:00:00",
          evidence_ref: null,
          created_at: "2026-01-01 00:00:00",
          updated_at: "2026-01-02 00:00:00",
        },
        {
          id: "l-2",
          user_id: USER_ID,
          contact_id: "c-beta",
          source_type: "outlook",
          source_record_id: "out-9",
          external_uuid: null,
          match_method: "email",
          confidence: null,
          matched_at: "2026-02-02 00:00:00",
          evidence_ref: "ev-7",
          created_at: "2026-02-02 00:00:00",
          updated_at: "2026-02-03 00:00:00",
        },
      ]);
    });

    it("keeps the pair UNIQUE and the contact cascade after the rebuild", async () => {
      seedExistingLinks();
      await runV58();
      harness.db.pragma("foreign_keys = ON");

      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_source_links
               (id, user_id, contact_id, source_type, source_record_id, match_method)
             VALUES ('dup', ?, 'c-beta', 'macos', 'mac-1', 'email')`,
          )
          .run(USER_ID),
      ).toThrow(/UNIQUE/i);

      harness.db.prepare("DELETE FROM contacts WHERE id = 'c-alpha'").run();
      expect(
        (harness.db.prepare("SELECT id FROM contact_source_links ORDER BY id").all() as Array<{
          id: string;
        }>).map((r) => r.id),
      ).toEqual(["l-2"]);
    });

    it("restores the crosswalk index the rebuild drops, and adds exactly two more", async () => {
      const before = indexNames(harness.db);
      await runV58();
      const after = indexNames(harness.db);

      expect(after).toContain("idx_contact_source_links_contact");
      expect(after.filter((n) => !before.includes(n)).sort()).toEqual([
        "idx_contact_link_proposals_pending",
        "idx_contact_link_verdicts_pair",
      ]);
      expect(before.filter((n) => !after.includes(n))).toEqual([]);
    });

    it("is a no-op on a second run — re-running does not churn ids", async () => {
      seedExistingLinks();
      await runV58();
      const first = harness.db.prepare("SELECT rowid, id FROM contact_source_links ORDER BY id").all();

      await runV58(); // seeds version back to 57 and replays

      expect(harness.db.prepare("SELECT rowid, id FROM contact_source_links ORDER BY id").all()).toEqual(
        first,
      );
      expect(tableExists(harness.db, "contact_source_links_v58")).toBe(false);
    });
  });

  // =========================================================================
  // THE REAL UPGRADE PATH
  // =========================================================================
  describe("a real v57 database with data, upgraded through the chain", () => {
    /**
     * A migration that adds a table AND a standalone index can pass every
     * synthetic test and still break a real old->new upgrade — that is
     * BACKLOG-2298/2300, caught by founder QA rather than by CI. This runs the
     * UNCLIPPED chain from 57 over a populated database and then exercises the
     * new tables, so "the upgrade works" is asserted rather than assumed.
     */
    it("upgrades, keeps its data, and the new tables are usable afterwards", async () => {
      seedExistingLinks();
      harness.db
        .prepare(
          `INSERT INTO external_contacts (id, user_id, name, external_record_id, source, synced_at)
           VALUES ('e-1', ?, 'Alpha Person', 'mac-1', 'macos', '2026-01-01')`,
        )
        .run(USER_ID);

      harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 57)").run();
      await harness.service._runVersionedMigrations();

      // Data intact.
      expect(
        (harness.db.prepare("SELECT id FROM contact_source_links ORDER BY id").all() as Array<{
          id: string;
        }>).map((r) => r.id),
      ).toEqual(["l-1", "l-2"]);

      // And the new tables actually work on the upgraded database.
      harness.db
        .prepare(
          `INSERT INTO contact_link_proposals
             (id, user_id, contact_id, source_type, source_record_id, reason,
              identity_assessment, relationship_assessment, cluster_key)
           VALUES ('p-1', ?, 'c-alpha', 'macos', 'mac-1', 'identifier_reassigned',
                   'possibly_same_person', 'connected', 'contact:c-alpha')`,
        )
        .run(USER_ID);
      harness.db
        .prepare(
          `INSERT INTO contact_link_verdicts
             (id, user_id, contact_id, source_type, source_record_id, identity_verdict)
           VALUES ('v-1', ?, 'c-alpha', 'macos', 'mac-1', 'different_people')`,
        )
        .run(USER_ID);
      harness.db
        .prepare(
          `INSERT INTO contact_source_links
             (id, user_id, contact_id, source_type, source_record_id, match_method)
           VALUES ('l-3', ?, 'c-alpha', 'outlook', 'out-new', 'unique_name')`,
        )
        .run(USER_ID);

      expect(
        (harness.db
          .prepare("SELECT id FROM contact_source_links ORDER BY id")
          .all() as Array<{ id: string }>).map((r) => r.id),
      ).toEqual(["l-1", "l-2", "l-3"]);
    });

    it("is idempotent when a partial-schema database has no contacts table", async () => {
      const bare = createMigrationHarness({ seedV29Schema: false });
      try {
        bare.db.exec(`
          CREATE TABLE schema_version (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            version INTEGER NOT NULL DEFAULT 1,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            migrated_at TEXT DEFAULT (datetime('now'))
          );
        `);
        bare.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 57)").run();

        const klass = bare.service.constructor as { MIGRATIONS: Array<{ version: number }> };
        const all = klass.MIGRATIONS;
        klass.MIGRATIONS = all.filter((m) => m.version <= 58);
        try {
          await expect(bare.service._runVersionedMigrations()).resolves.not.toThrow();
        } finally {
          klass.MIGRATIONS = all;
        }
        // Guarded out entirely — nothing created, nothing thrown.
        expect(tableExists(bare.db, "contact_link_proposals")).toBe(false);
      } finally {
        await bare.cleanup().catch(() => undefined);
      }
    });
  });
});
