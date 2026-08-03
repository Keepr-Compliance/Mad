/**
 * @jest-environment node
 *
 * Integration test for migration v59 (BACKLOG-2410 — the contact link review
 * queue, its verdicts, and the `unique_name` match method).
 *
 * v59 does three things, and each has a way of going wrong that CI has already
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
 * WHAT THIS FILE IS **NOT**. Everything here runs against `createMigrationHarness`
 * — `:memory:`, `dbPath = null`, calling `_runVersionedMigrations()` directly.
 * That is a synthetic fixture, and it is precisely the pattern
 * `insight_migration_upgrade_path_untested` / BACKLOG-2298 warns about: a
 * migration can pass every assertion below and still break a real old->new
 * upgrade, because schema.sql is exec'd before the chain on a real file and
 * nothing here reproduces that ordering.
 *
 * An earlier revision of this header claimed the last describe was "a REAL
 * v57-shaped database ... the path a user on v2.27.0 actually takes". IT IS NOT,
 * and the claim is corrected rather than deleted because overstating coverage is
 * how the gap gets rebuilt.
 *
 * THE REAL ON-DISK COVERAGE LIVES IN `databaseService.onDiskUpgrade.test.ts`,
 * which starts from a real v55 file in `os.tmpdir()`, execs the real schema.sql,
 * and drives the PUBLIC `runMigrations()` to head. Since SR review of #2183 it
 * also carries POPULATED crosswalk rows across the v59 rebuild
 * (`v59 rebuilds a POPULATED crosswalk on the real file without scrambling a
 * row`) — previously the rebuild ran there over an empty table, so row-copy
 * fidelity was asserted only in memory.
 */

import path from "path";
import { jest } from "@jest/globals";
import type { Database as DatabaseType } from "better-sqlite3";
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
import { CONTACT_IDENTITY_SCHEMA } from "./helpers/contactIdentitySchema";
import {
  CONTACT_IDENTITY_TABLES,
  CONTACT_SOURCE_LINKS_COLUMNS,
} from "../db/contactIdentitySchemaSql";

// Bypass the jest auto-mock so the parity comparison runs on a real database.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const USER_ID = "user-v59";

/**
 * A REAL post-v57 database: the v57 crosswalk exactly as that migration writes
 * it, including the five-value `match_method` CHECK that v59 has to widen.
 */
const PRE_V59_FIXTURE = `
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

describe("databaseService migration v59 (BACKLOG-2410 — review queue + verdicts)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(PRE_V59_FIXTURE);
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

  /** Seed at 58 and clip at 59 so ONLY v59 runs. */
  async function runV59(): Promise<void> {
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 57)").run();
    const klass = harness.service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const all = klass.MIGRATIONS;
    klass.MIGRATIONS = all.filter((m) => m.version <= 59);
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
    it("is created and reaches version 59", async () => {
      expect(tableExists(harness.db, "contact_link_proposals")).toBe(false);
      await runV59();
      expect(tableExists(harness.db, "contact_link_proposals")).toBe(true);
      expect(
        (harness.db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
          version: number;
        }).version,
      ).toBe(59);
    });

    it("enforces one proposal per pair — the half of 'never re-proposed' that lives in the schema", async () => {
      await runV59();
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
      await runV59();
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
      await runV59();
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
      await runV59();
      expect(foreignKeys(harness.db, "contact_link_verdicts")).toEqual([]);
      // The proposals table DOES have one, which is the contrast being drawn.
      expect(foreignKeys(harness.db, "contact_link_proposals")).toEqual(["contacts"]);
    });

    it("survives its contact being deleted", async () => {
      await runV59();
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
      await runV59();
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
      await runV59();
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

      await runV59();

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
     * NEGATIVE CONTROL RUN (a): dropped `evidence_ref` from both column lists in
     * the migration's INSERT ... SELECT. Observed: 1 failed / 14 passed — this
     * test, on the missing `ev-7`, while every row-count and constraint
     * assertion in the file still passed. That is why it names every field.
     *
     * NEGATIVE CONTROL RUN (b): replaced the named SELECT with `SELECT *`.
     * Observed: NOT CAUGHT by THIS test — the seeded table's column order is
     * identical to the rebuilt one, so a positional copy happens to land
     * correctly. `a reordered source table still copies field for field` below
     * is the test that catches it; the two are a pair and neither is sufficient
     * alone.
     */
    it("carries every existing row across, field for field", async () => {
      seedExistingLinks();
      await runV59();

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

    /**
     * THE POSITIONAL-COPY TEST. Added at SR request on #2183.
     *
     * The assertion above cannot see a `SELECT *` because the seeded table and
     * the rebuilt one declare their columns in the same order, so a positional
     * copy lands correctly by luck. This one removes the luck: the fixture
     * declares `external_uuid` and `match_method` SWAPPED relative to the target,
     * which is exactly the shape a rebuild must survive.
     *
     * Under `SELECT *` the migration dies with
     *   `CHECK constraint failed: match_method IN ('source_id', ...)`
     * because the uuid lands in the match_method column. Under the shipped
     * explicit column lists it passes.
     *
     * NEGATIVE CONTROL RUN: replaced the named SELECT in the migration with
     * `SELECT *`. Observed: 1 failed / 17 passed — this test, on
     * `Migration 59 failed: CHECK constraint failed: match_method IN (...)`,
     * while `carries every existing row across, field for field` stayed GREEN.
     *
     * This class has bitten the repo twice already — v33 `audit_logs` and v36
     * `contacts`. A comment saying "never SELECT *" that no test defends is one
     * careless edit from the third.
     */
    it("a reordered source table still copies field for field", async () => {
      // Rebuild the fixture's crosswalk with two columns transposed. Everything
      // else — constraints, defaults, the five-value v57 CHECK — is unchanged,
      // so the ONLY variable is declaration order.
      harness.db.exec(`
        DROP TABLE contact_source_links;
        CREATE TABLE contact_source_links (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          contact_id TEXT NOT NULL,
          source_type TEXT NOT NULL CHECK (
            source_type IN ('macos', 'iphone', 'outlook', 'google_contacts', 'android_sync')
          ),
          source_record_id TEXT NOT NULL,
          -- SWAPPED relative to the v59 target shape:
          match_method TEXT NOT NULL CHECK (
            match_method IN ('source_id', 'email', 'phone', 'manual', 'scored')
          ),
          external_uuid TEXT,
          confidence REAL,
          matched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          evidence_ref TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
          UNIQUE (user_id, source_type, source_record_id)
        );
      `);
      harness.db
        .prepare(
          `INSERT INTO contact_source_links
             (id, user_id, contact_id, source_type, source_record_id,
              match_method, external_uuid, confidence, matched_at, evidence_ref,
              created_at, updated_at)
           VALUES ('l-swap', ?, 'c-alpha', 'macos', 'mac-swap',
                   'source_id', 'uuid-swap', NULL, '2026-03-03 00:00:00', 'ev-swap',
                   '2026-03-03 00:00:00', '2026-03-04 00:00:00')`,
        )
        .run(USER_ID);

      await runV59();

      expect(
        harness.db
          .prepare(
            `SELECT id, user_id, contact_id, source_type, source_record_id, external_uuid,
                    match_method, confidence, matched_at, evidence_ref, created_at, updated_at
               FROM contact_source_links`,
          )
          .all(),
      ).toEqual([
        {
          id: "l-swap",
          user_id: USER_ID,
          contact_id: "c-alpha",
          source_type: "macos",
          source_record_id: "mac-swap",
          // The two that would have crossed over under a positional copy.
          external_uuid: "uuid-swap",
          match_method: "source_id",
          confidence: null,
          matched_at: "2026-03-03 00:00:00",
          evidence_ref: "ev-swap",
          created_at: "2026-03-03 00:00:00",
          updated_at: "2026-03-04 00:00:00",
        },
      ]);

      // And the rebuilt table is in the canonical order regardless of what it
      // was rebuilt FROM.
      expect(
        (harness.db.prepare("PRAGMA table_info(contact_source_links)").all() as Array<{
          name: string;
        }>).map((c) => c.name),
      ).toEqual([...CONTACT_SOURCE_LINKS_COLUMNS]);
    });

    it("keeps the pair UNIQUE and the contact cascade after the rebuild", async () => {
      seedExistingLinks();
      await runV59();
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
      await runV59();
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
      await runV59();
      const first = harness.db.prepare("SELECT rowid, id FROM contact_source_links ORDER BY id").all();

      await runV59(); // seeds version back to 57 and replays

      expect(harness.db.prepare("SELECT rowid, id FROM contact_source_links ORDER BY id").all()).toEqual(
        first,
      );
      expect(tableExists(harness.db, "contact_source_links_v59")).toBe(false);
    });
  });

  // =========================================================================
  // PARITY WITH THE SUITES' OWN SCHEMA
  // =========================================================================
  describe("the schema the service suites run against", () => {
    /**
     * THE DRIFT CHANNEL THIS CLOSES — found in SR review of #2183.
     *
     * `helpers/contactIdentitySchema.ts` used to HAND-WRITE this migration's DDL
     * a second time, and every service-level suite (review queue, provenance,
     * name auto-link, linker) built its database from that copy. Nothing
     * compared the two, so the migration and the schema under test could diverge
     * silently — and did: dropping the proposals `UNIQUE` from the real
     * migration left `contactLinkReview.test.ts` green at 27/27, because those
     * tests never executed the real statement.
     *
     * Both now exec the SAME constants from `db/contactIdentitySchemaSql.ts`, so
     * this test is true by construction today. It is here to keep it true: if
     * anyone re-inlines DDL on either side, the two databases stop agreeing and
     * this goes red.
     *
     * Compared on `sqlite_master.sql`, which is SQLite's own normalisation of
     * what was actually created — not on the source strings, which would only
     * prove two constants are equal to themselves.
     */
    function objectSql(db: DatabaseType, names: readonly string[]): Record<string, string> {
      const out: Record<string, string> = {};
      for (const row of db
        .prepare(
          `SELECT name, sql FROM sqlite_master
            WHERE sql IS NOT NULL AND (name IN (${names.map(() => "?").join(",")})
               OR tbl_name IN (${names.map(() => "?").join(",")}))
            ORDER BY name`,
        )
        .all(...names, ...names) as Array<{ name: string; sql: string }>) {
        // Two normalisations, and ONLY two.
        //
        //  1. Collapse whitespace — the constants are indented for reading.
        //  2. Unquote the table name in `CREATE TABLE "x"`. SQLite rewrites the
        //     stored DDL when `ALTER TABLE ... RENAME` runs, and quotes the new
        //     name; the migration reaches `contact_source_links` via the rebuild
        //     rename while the helper creates it directly. That the two agree on
        //     everything else is the point of this test — the shapes converge
        //     even though the routes differ.
        //
        // Column order, constraints, CHECK vocabularies, defaults and index
        // definitions all still have to match exactly. Identifier quoting uses
        // double quotes; every string literal in this DDL uses single quotes, so
        // the substitution cannot touch a CHECK vocabulary.
        out[row.name] = row.sql
          .replace(/\s+/g, " ")
          .replace(/CREATE TABLE "([^"]+)"/, "CREATE TABLE $1")
          .trim();
      }
      return out;
    }

    it("is identical to what the migration produces, table for table and index for index", async () => {
      await runV59();
      const fromMigration = objectSql(harness.db, CONTACT_IDENTITY_TABLES);

      const fromHelper = new RealDatabase(":memory:");
      try {
        fromHelper.exec(CONTACT_IDENTITY_SCHEMA);
        expect(objectSql(fromHelper, CONTACT_IDENTITY_TABLES)).toEqual(fromMigration);
      } finally {
        fromHelper.close();
      }
    });

    it("covers all three identity tables and their indexes — not an empty comparison", async () => {
      await runV59();
      // A parity test that compared {} to {} would pass forever. Name what must
      // be in the set.
      expect(Object.keys(objectSql(harness.db, CONTACT_IDENTITY_TABLES)).sort()).toEqual([
        "contact_link_proposals",
        "contact_link_verdicts",
        "contact_source_links",
        "idx_contact_link_proposals_pending",
        "idx_contact_link_verdicts_pair",
        "idx_contact_source_links_contact",
      ]);
    });
  });

  // =========================================================================
  // THE UNCLIPPED CHAIN — IN MEMORY, NOT ON DISK
  // =========================================================================
  describe("a populated v57-shaped database, upgraded through the unclipped chain", () => {
    /**
     * Runs the WHOLE remaining chain rather than just v59, over a database that
     * already has rows, and then exercises the new tables. It catches a
     * migration that only works in isolation — an ordering dependency between
     * v58 and v59, say.
     *
     * IT IS AN IN-MEMORY TEST. It does NOT reproduce the real upgrade, because
     * `createMigrationHarness` never execs schema.sql and never touches a file,
     * which is where the BACKLOG-2298 class of defect lives. The real on-disk
     * equivalent — including the populated rebuild — is in
     * `databaseService.onDiskUpgrade.test.ts`.
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
        klass.MIGRATIONS = all.filter((m) => m.version <= 59);
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
