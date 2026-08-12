/**
 * @jest-environment node
 *
 * Integration test for migration v61 (BACKLOG-2473 — the crosswalk vocabulary
 * that lets a manual or message-derived contact have a source link at all).
 *
 * v61 does ONE thing: it rebuilds `contact_source_links` so `source_type` admits
 * the four origin-only values and `match_method` admits `origin`. It writes NO
 * rows — the rows are written going forward at contact-create time (founder
 * decision 2026-08-04: the one user with pre-crosswalk contacts is reinstalling,
 * so a backfill would be a table-wide write for zero rows).
 *
 * A TABLE REBUILD IS THE HIGHEST-RISK SHAPE OF MIGRATION THERE IS, and this repo
 * has been bitten by it twice — v33 `audit_logs`, v36 `contacts`. Both were
 * positional copies: every row survives, holding its neighbour's value, so no
 * row count and no "did it throw" check can see it. The seeded rows here are
 * therefore asserted FIELD FOR FIELD, and one test deliberately seeds a table
 * whose columns are DECLARED IN A DIFFERENT ORDER.
 *
 * WHAT THIS FILE IS **NOT**. Everything here runs against `createMigrationHarness`
 * — `:memory:`, `dbPath = null`, calling `_runVersionedMigrations()` directly.
 * That is a synthetic fixture and is exactly the pattern BACKLOG-2298 warns
 * about: a migration can pass every assertion below and still break a real
 * old->new upgrade, because schema.sql is exec'd before the chain on a real file
 * and nothing here reproduces that ordering.
 *
 * THE REAL ON-DISK COVERAGE FOR v61 IS IN `databaseService.onDiskUpgrade.test.ts`
 * ("v61 widens the crosswalk vocabulary on the real file..."), which starts from
 * a real file, execs the real schema.sql, and drives the PUBLIC `runMigrations()`
 * to head with populated crosswalk rows.
 */

import path from "path";
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
  CONTACT_LINK_PROPOSALS_INDEX_SQL,
  CONTACT_LINK_PROPOSALS_TABLE_SQL,
  CONTACT_LINK_VERDICTS_INDEX_SQL,
  CONTACT_LINK_VERDICTS_TABLE_SQL,
  CONTACT_SOURCE_LINKS_COLUMNS,
  ORIGIN_MATCH_METHOD,
  ORIGIN_ONLY_SOURCE_TYPES,
} from "../db/contactIdentitySchemaSql";

// Bypass the jest auto-mock so the parity comparison runs on a real database.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const USER_ID = "user-v61";

/**
 * A REAL post-v60 database: `contact_source_links` exactly as v59 leaves it —
 * `unique_name` already admitted, the five-value `source_type` CHECK still in
 * force. That five-value CHECK is what v61 has to widen, and asserting it is
 * live BEFORE the migration is what makes the "admits it after" assertions mean
 * something.
 */
const PRE_V61_FIXTURE = `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);

  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    source TEXT DEFAULT 'manual',
    is_message_derived INTEGER DEFAULT 0,
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
      match_method IN ('source_id', 'email', 'phone', 'unique_name', 'manual', 'scored')
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
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function foreignKeys(db: DatabaseType, table: string): string[] {
  return (
    db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>
  ).map((r) => r.table);
}

describe("databaseService migration v61 (BACKLOG-2473 — crosswalk origin vocabulary)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(PRE_V61_FIXTURE);
    // The review-queue tables as v59 leaves them. Exec'd from the shared
    // constants rather than transcribed, because v61 does not touch them and
    // the parity assertion below must be comparing the real thing — a
    // hand-written copy here would make that test pass against a fiction.
    harness.db.exec(CONTACT_LINK_PROPOSALS_TABLE_SQL);
    harness.db.exec(CONTACT_LINK_PROPOSALS_INDEX_SQL);
    harness.db.exec(CONTACT_LINK_VERDICTS_TABLE_SQL);
    harness.db.exec(CONTACT_LINK_VERDICTS_INDEX_SQL);
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
    const contact = harness.db.prepare(
      "INSERT INTO contacts (id, user_id, display_name, source, is_message_derived) VALUES (?, ?, ?, ?, ?)",
    );
    contact.run("c-typed", USER_ID, "Hand Typed", "manual", 0);
    contact.run("c-thread", USER_ID, "From A Thread", "sms", 1);
    contact.run("c-book", USER_ID, "From The Mac", "contacts_app", 0);
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

  /** Seed at 60 and clip at 61 so ONLY v61 runs. */
  async function runV61(): Promise<void> {
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 60)").run();
    const klass = harness.service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const all = klass.MIGRATIONS;
    klass.MIGRATIONS = all.filter((m) => m.version <= 61);
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
      "l-1", USER_ID, "c-book", "macos", "mac-1", "uuid-1",
      "source_id", null, "2026-01-01 00:00:00", null, "2026-01-01 00:00:00", "2026-01-02 00:00:00",
    );
    stmt.run(
      "l-2", USER_ID, "c-book", "outlook", "out-9", null,
      "unique_name", 0.5, "2026-02-02 00:00:00", "ev-7", "2026-02-02 00:00:00", "2026-02-03 00:00:00",
    );
  }

  // =========================================================================
  describe("the widened vocabulary", () => {
    it("reaches version 61", async () => {
      await runV61();
      expect(
        (harness.db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
          version: number;
        }).version,
      ).toBe(61);
    });

    /**
     * THE POINT OF THE WHOLE MIGRATION. Before it, a manual contact CANNOT have
     * a crosswalk row — the CHECK refuses the only source type that would
     * describe it — which is why provenance had to be read from the
     * `contacts.source` scalar for those contacts and from the crosswalk for
     * everyone else. Asserted as a refusal BEFORE and an acceptance AFTER, on
     * every one of the four new values.
     */
    it.each([...ORIGIN_ONLY_SOURCE_TYPES])(
      "refuses source_type '%s' before, admits it after",
      async (sourceType) => {
        expect(() =>
          harness.db
            .prepare(
              `INSERT INTO contact_source_links
                 (id, user_id, contact_id, source_type, source_record_id, match_method)
               VALUES ('pre', ?, 'c-typed', ?, 'r-pre', 'manual')`,
            )
            .run(USER_ID, sourceType),
        ).toThrow(/CHECK/i);

        await runV61();

        expect(() =>
          harness.db
            .prepare(
              `INSERT INTO contact_source_links
                 (id, user_id, contact_id, source_type, source_record_id, match_method)
               VALUES ('post', ?, 'c-typed', ?, 'r-post', ?)`,
            )
            .run(USER_ID, sourceType, ORIGIN_MATCH_METHOD),
        ).not.toThrow();
      },
    );

    it("refuses match_method 'origin' before, admits it after", async () => {
      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_source_links
               (id, user_id, contact_id, source_type, source_record_id, match_method)
             VALUES ('pre', ?, 'c-typed', 'macos', 'r-pre', 'origin')`,
          )
          .run(USER_ID),
      ).toThrow(/CHECK/i);

      await runV61();

      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_source_links
               (id, user_id, contact_id, source_type, source_record_id, match_method)
             VALUES ('post', ?, 'c-typed', 'macos', 'r-post', 'origin')`,
          )
          .run(USER_ID),
      ).not.toThrow();
    });

    /**
     * A widened CHECK that admits everything is not a constraint. Both columns
     * must still refuse a value outside their vocabulary — otherwise a typo
     * (`'gogle_contacts'`) becomes a row nothing will ever match.
     */
    it("still refuses a source_type and a match_method outside the vocabulary", async () => {
      await runV61();

      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_source_links
               (id, user_id, contact_id, source_type, source_record_id, match_method)
             VALUES ('bad-src', ?, 'c-typed', 'whatsapp', 'r1', 'origin')`,
          )
          .run(USER_ID),
      ).toThrow(/CHECK/i);

      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_source_links
               (id, user_id, contact_id, source_type, source_record_id, match_method)
             VALUES ('bad-mm', ?, 'c-typed', 'manual', 'r2', 'vibes')`,
          )
          .run(USER_ID),
      ).toThrow(/CHECK/i);
    });

    /**
     * THE NARROW CHECK ON THE OTHER TWO TABLES IS DELIBERATE, NOT AN OVERSIGHT.
     *
     * A proposal asks "is this contact the same person as this EXTERNAL RECORD?"
     * and a verdict answers it. There is no external record behind an origin row,
     * so the question is meaningless and the vocabulary stays narrow — which is
     * also what makes `unlinkContactSource` obliged to refuse an origin link
     * rather than write an impossible verdict.
     */
    it("does NOT widen the proposals or verdicts vocabulary", async () => {
      await runV61();

      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_link_proposals
               (id, user_id, contact_id, source_type, source_record_id, reason,
                identity_assessment, relationship_assessment, cluster_key)
             VALUES ('p-1', ?, 'c-typed', 'manual', 'r1', 'ambiguous_identifier',
                     'possibly_same_person', 'possibly_connected', 'k')`,
          )
          .run(USER_ID),
      ).toThrow(/CHECK/i);

      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_link_verdicts
               (id, user_id, contact_id, source_type, source_record_id, identity_verdict)
             VALUES ('v-1', ?, 'c-typed', 'manual', 'r1', 'different_people')`,
          )
          .run(USER_ID),
      ).toThrow(/CHECK/i);
    });
  });

  // =========================================================================
  describe("the rebuild", () => {
    /**
     * NEGATIVE CONTROL RUN (a): dropped `evidence_ref` from both column lists in
     * the migration's INSERT ... SELECT. Observed: this test fails on the
     * missing `ev-7` while every constraint assertion in the file stays green.
     * That is why it names every field instead of counting rows.
     *
     * NEGATIVE CONTROL RUN (b): replaced the named SELECT with `SELECT *`.
     * Observed: NOT CAUGHT HERE — the seeded table's column order is identical
     * to the rebuilt one, so a positional copy lands correctly by luck.
     * `a reordered source table still copies field for field` is the test that
     * catches it. The two are a pair and neither is sufficient alone.
     */
    it("carries every existing row across, field for field", async () => {
      seedExistingLinks();
      await runV61();

      expect(
        harness.db
          .prepare(
            `SELECT id, user_id, contact_id, source_type, source_record_id, external_uuid,
                    match_method, confidence, matched_at, evidence_ref, created_at, updated_at
               FROM contact_source_links ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: "l-1",
          user_id: USER_ID,
          contact_id: "c-book",
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
          contact_id: "c-book",
          source_type: "outlook",
          source_record_id: "out-9",
          external_uuid: null,
          match_method: "unique_name",
          confidence: 0.5,
          matched_at: "2026-02-02 00:00:00",
          evidence_ref: "ev-7",
          created_at: "2026-02-02 00:00:00",
          updated_at: "2026-02-03 00:00:00",
        },
      ]);
    });

    /**
     * THE POSITIONAL-COPY TEST — the one that defends against the v33/v36 class.
     *
     * The fixture declares `external_uuid` and `match_method` SWAPPED relative to
     * the target shape. Under `SELECT *` the uuid lands in the `match_method`
     * column and the migration dies with a CHECK violation; under the shipped
     * explicit column lists it passes.
     *
     * NEGATIVE CONTROL RUN: replaced the named SELECT in the v61 migration with
     * `SELECT *`. Observed: 1 failed / 19 passed — THIS test, on
     * `Migration 61 failed: CHECK constraint failed: match_method IN (...)`,
     * while `carries every existing row across, field for field` stayed GREEN.
     *
     * A comment saying "never SELECT *" that no test defends is one careless
     * edit from the third incident.
     */
    it("a reordered source table still copies field for field", async () => {
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
          -- SWAPPED relative to the v61 target shape:
          match_method TEXT NOT NULL CHECK (
            match_method IN ('source_id', 'email', 'phone', 'unique_name', 'manual', 'scored')
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
           VALUES ('l-swap', ?, 'c-book', 'macos', 'mac-swap',
                   'source_id', 'uuid-swap', NULL, '2026-03-03 00:00:00', 'ev-swap',
                   '2026-03-03 00:00:00', '2026-03-04 00:00:00')`,
        )
        .run(USER_ID);

      await runV61();

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
          contact_id: "c-book",
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

      // ...and the rebuilt table is in the canonical order regardless of what it
      // was rebuilt FROM.
      expect(
        (harness.db.prepare("PRAGMA table_info(contact_source_links)").all() as Array<{
          name: string;
        }>).map((c) => c.name),
      ).toEqual([...CONTACT_SOURCE_LINKS_COLUMNS]);
    });

    it("keeps the pair UNIQUE, the FK and the contact cascade after the rebuild", async () => {
      seedExistingLinks();
      await runV61();
      harness.db.pragma("foreign_keys = ON");

      expect(foreignKeys(harness.db, "contact_source_links")).toEqual(["contacts"]);

      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_source_links
               (id, user_id, contact_id, source_type, source_record_id, match_method)
             VALUES ('dup', ?, 'c-typed', 'macos', 'mac-1', 'email')`,
          )
          .run(USER_ID),
      ).toThrow(/UNIQUE/i);

      harness.db.prepare("DELETE FROM contacts WHERE id = 'c-book'").run();
      expect(harness.db.prepare("SELECT id FROM contact_source_links").all()).toEqual([]);
    });

    /**
     * The UNIQUE is why an origin row's `source_record_id` is keyed on the
     * contact id rather than a constant sentinel. With a constant, the SECOND
     * manual contact in an account would collide and silently get no origin row
     * — the exact population this work exists to give one to.
     */
    it("admits one origin row per contact — a constant sentinel would have collided", async () => {
      await runV61();
      const insert = harness.db.prepare(
        `INSERT INTO contact_source_links
           (id, user_id, contact_id, source_type, source_record_id, match_method)
         VALUES (?, ?, ?, 'manual', ?, 'origin')`,
      );

      insert.run("o-1", USER_ID, "c-typed", "origin:c-typed");
      expect(() => insert.run("o-2", USER_ID, "c-thread", "origin:c-thread")).not.toThrow();

      // The shape that would have broken: the same record id for both.
      expect(() => insert.run("o-3", USER_ID, "c-book", "origin:c-typed")).toThrow(/UNIQUE/i);

      expect(
        (harness.db
          .prepare("SELECT contact_id FROM contact_source_links ORDER BY contact_id")
          .all() as Array<{ contact_id: string }>).map((r) => r.contact_id),
      ).toEqual(["c-thread", "c-typed"]);
    });

    it("restores the crosswalk index the rebuild drops, and creates no others", async () => {
      const before = indexNames(harness.db);
      await runV61();
      const after = indexNames(harness.db);

      expect(after).toContain("idx_contact_source_links_contact");
      expect(after.filter((n) => !before.includes(n))).toEqual([]);
      expect(before.filter((n) => !after.includes(n))).toEqual([]);
    });

    it("is a no-op on a second run — re-running does not churn ids", async () => {
      seedExistingLinks();
      await runV61();
      const first = harness.db
        .prepare("SELECT rowid, id FROM contact_source_links ORDER BY id")
        .all();

      await runV61(); // seeds version back to 60 and replays

      expect(
        harness.db.prepare("SELECT rowid, id FROM contact_source_links ORDER BY id").all(),
      ).toEqual(first);
      expect(tableExists(harness.db, "contact_source_links_v61")).toBe(false);
    });

    /**
     * v61 IS SCHEMA-ONLY. It must not invent provenance for anybody.
     *
     * The founder's decision to skip the backfill is a decision about USER DATA,
     * so it is pinned by a test rather than left to a comment: three contacts
     * with no links go in, and the crosswalk is still empty afterwards.
     */
    it("writes NO rows — the backfill was deliberately not built", async () => {
      await runV61();
      expect(harness.db.prepare("SELECT id FROM contact_source_links").all()).toEqual([]);
      // And the contacts themselves are untouched.
      expect(
        (harness.db.prepare("SELECT id FROM contacts ORDER BY id").all() as Array<{ id: string }>)
          .map((r) => r.id),
      ).toEqual(["c-book", "c-thread", "c-typed"]);
    });

    /**
     * A database with no crosswalk at all (a partial-schema fixture, or a mocked
     * connection where `sqlite_master.sql` comes back as something other than a
     * string). Reading `.includes` off a non-string would throw INSIDE the
     * migration transaction, and the runner escalates a migration failure to a
     * restore-from-backup dialog — a catastrophic response to an absent table.
     */
    it("is a silent no-op when the crosswalk does not exist", async () => {
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
        bare.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 60)").run();

        const klass = bare.service.constructor as { MIGRATIONS: Array<{ version: number }> };
        const all = klass.MIGRATIONS;
        klass.MIGRATIONS = all.filter((m) => m.version <= 61);
        try {
          await expect(bare.service._runVersionedMigrations()).resolves.not.toThrow();
        } finally {
          klass.MIGRATIONS = all;
        }
        expect(tableExists(bare.db, "contact_source_links")).toBe(false);
      } finally {
        await bare.cleanup().catch(() => undefined);
      }
    });
  });

  // =========================================================================
  // PARITY WITH THE SUITES' OWN SCHEMA
  // =========================================================================
  describe("the schema the service suites run against", () => {
    /**
     * The drift channel closed in v59 and kept closed here: every service-level
     * suite builds its database from `helpers/contactIdentitySchema.ts`, and if
     * that helper and the migration disagree, those suites are testing a schema
     * that does not ship. Both exec the SAME constants, so this is true by
     * construction today — it is here to keep it true.
     *
     * Compared on `sqlite_master.sql`, SQLite's own normalisation of what was
     * actually created, not on the source strings (which would only prove two
     * constants equal themselves).
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
        out[row.name] = row.sql
          .replace(/\s+/g, " ")
          .replace(/CREATE TABLE "([^"]+)"/, "CREATE TABLE $1")
          .trim();
      }
      return out;
    }

    it("is identical to what the migration produces, table for table and index for index", async () => {
      await runV61();
      const fromMigration = objectSql(harness.db, CONTACT_IDENTITY_TABLES);

      const fromHelper = new RealDatabase(":memory:");
      try {
        fromHelper.exec(CONTACT_IDENTITY_SCHEMA);
        expect(objectSql(fromHelper, CONTACT_IDENTITY_TABLES)).toEqual(fromMigration);
      } finally {
        fromHelper.close();
      }
    });

    it("carries the widened vocabulary into the DDL both sides produce", async () => {
      await runV61();
      const sql = objectSql(harness.db, CONTACT_IDENTITY_TABLES)["contact_source_links"];
      for (const value of ORIGIN_ONLY_SOURCE_TYPES) {
        expect(sql).toContain(`'${value}'`);
      }
      expect(sql).toContain(`'${ORIGIN_MATCH_METHOD}'`);
    });
  });
});
