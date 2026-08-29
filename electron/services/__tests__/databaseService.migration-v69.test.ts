/**
 * @jest-environment node
 *
 * Integration test for migration v69 (BACKLOG-2630 slice 2 / board D2, piece 1
 * — the three pair shapes).
 *
 * v69 rebuilds BOTH `contact_link_proposals` (the questions) and
 * `contact_link_verdicts` (the answers) so each can name:
 *
 *   record <-> saved contact   what the tables expressed before, unchanged
 *   record <-> record          two external records, NO CONTACT either side
 *   contact <-> contact        two saved contacts, NO SOURCE RECORD either side
 *
 * IT WRITES NO NEW ROWS AND NOTHING IN PRODUCTION CREATES EITHER NEW SHAPE.
 * Founder decision 2026-08-27, "yeah i agree schema first split": the shape
 * ships now, the matcher that fills it waits on a measurement nobody has taken.
 * The direct inserts below are the licence that decision grants a test and
 * denies production code.
 *
 * A TABLE REBUILD IS THE HIGHEST-RISK SHAPE OF MIGRATION THERE IS, and this
 * repo has been bitten twice — v33 `audit_logs`, v36 `contacts`. Both were
 * positional copies: every row survives holding its neighbour's value, so no
 * row count and no "did it throw" check can see it.
 *
 * WHAT THIS FILE IS **NOT**. Everything here runs against
 * `createMigrationHarness` — `:memory:`, calling `_runVersionedMigrations()`
 * directly. That is a synthetic fixture and is exactly the pattern BACKLOG-2298
 * warns about: a migration can pass every assertion below and still break a real
 * old->new upgrade, because a test database is built FRESH from the current
 * constants while a user's file was built by the code as it was then.
 *
 * THE REAL ON-DISK COVERAGE FOR v69 IS IN `databaseService.onDiskUpgrade.test.ts`
 * ("v69 rebuilds the questions and the answers on a REAL old database..."),
 * which reconstructs the genuine pre-v69 DDL on a real file, seeds proposals and
 * verdicts, drives the PUBLIC `runMigrations()`, and asserts every row survives
 * field for field — including the `decided_at DESC, rowid DESC` tiebreak that a
 * rebuild's rowid reassignment could silently flip. Convergence with the
 * fresh-install route is asserted in `databaseService.migrationChainRehearsal.test.ts`.
 *
 * This file covers what neither of those can: idempotency, the marker guard, the
 * partial-schema no-op, and the CHECK refusals that keep each shape honest.
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const USER_ID = "user-v69";
const CONTACT_A = "c-v69-alpha";
const CONTACT_B = "c-v69-beta";
const RECORD_A = "REC-V69-ALPHA:ABPerson";
const RECORD_B = "REC-V69-BETA:Entry";

/**
 * A REAL post-v68 database: both identity tables exactly as v59 left them —
 * `contact_id TEXT NOT NULL` with an FK to `contacts`, `source_record_id NOT
 * NULL`, and the four-column UNIQUE on proposals.
 *
 * `contact_link_verdicts` DECLARES ITS COLUMNS IN A DIFFERENT ORDER from the
 * post-v69 table (`decided_by` and `reason` are moved). That is the assertion
 * that fails under a positional `SELECT *` copy — the v33/v36 failure mode.
 */
const PRE_V69_FIXTURE = `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);

  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    removed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
  );

  CREATE TABLE contact_link_proposals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (
      source_type IN ('macos', 'iphone', 'outlook', 'google_contacts', 'android_sync')
    ),
    source_record_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending', 'confirmed', 'rejected')
    ),
    reason TEXT NOT NULL,
    matched_on TEXT,
    identity_assessment TEXT NOT NULL CHECK (
      identity_assessment IN ('same_person', 'possibly_same_person', 'different_people')
    ),
    relationship_assessment TEXT NOT NULL CHECK (
      relationship_assessment IN ('connected', 'possibly_connected', 'no_known_connection')
    ),
    cluster_key TEXT NOT NULL,
    evidence_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    UNIQUE (user_id, contact_id, source_type, source_record_id)
  );
  CREATE INDEX idx_contact_link_proposals_pending
    ON contact_link_proposals(user_id, status, cluster_key);

  CREATE TABLE contact_link_verdicts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    decided_by TEXT NOT NULL DEFAULT 'user',
    reason TEXT,
    contact_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (
      source_type IN ('macos', 'iphone', 'outlook', 'google_contacts', 'android_sync')
    ),
    source_record_id TEXT NOT NULL,
    identity_verdict TEXT NOT NULL CHECK (
      identity_verdict IN ('same_person', 'possibly_same_person', 'different_people')
    ),
    relationship_verdict TEXT CHECK (
      relationship_verdict IN ('connected', 'possibly_connected', 'no_known_connection')
    ),
    matched_on TEXT,
    evidence_json TEXT,
    decided_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX idx_contact_link_verdicts_pair
    ON contact_link_verdicts(user_id, source_type, source_record_id, contact_id);

  CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migrated_at TEXT DEFAULT (datetime('now'))
  );
`;

function tableSql(db: DatabaseType, name: string): string {
  return (
    (db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as { sql: string })
      ?.sql ?? ""
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

describe("databaseService migration v69 (BACKLOG-2630 D2 — the three pair shapes)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(PRE_V69_FIXTURE);
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
    for (const c of [CONTACT_A, CONTACT_B]) {
      harness.db
        .prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)")
        .run(c, USER_ID, `Person ${c.slice(-5)}`);
    }
  });

  afterEach(() => {
    harness.cleanup();
  });

  /** The chain clipped to v69, from the real pre-migration version. */
  async function runV69(): Promise<void> {
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 68)").run();
    const klass = harness.service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const all = klass.MIGRATIONS;
    klass.MIGRATIONS = all.filter((m) => m.version <= 69);
    try {
      await harness.service._runVersionedMigrations();
    } finally {
      klass.MIGRATIONS = all;
    }
  }

  function seedRecordContactRows(): void {
    harness.db
      .prepare(
        `INSERT INTO contact_link_proposals
           (id, user_id, contact_id, source_type, source_record_id, reason,
            identity_assessment, relationship_assessment, cluster_key, evidence_json)
         VALUES ('p-1', ?, ?, 'macos', ?, 'ambiguous_identifier',
                 'possibly_same_person', 'possibly_connected', 'k-1', '{"summary":"kept"}')`,
      )
      .run(USER_ID, CONTACT_A, RECORD_A);
    harness.db
      .prepare(
        `INSERT INTO contact_link_verdicts
           (id, user_id, decided_by, reason, contact_id, source_type, source_record_id,
            identity_verdict, matched_on, evidence_json, decided_at)
         VALUES ('v-1', ?, 'user', 'answered', ?, 'macos', ?, 'different_people',
                 'email', '{"summary":"frozen"}', '2026-06-10 12:00:00')`,
      )
      .run(USER_ID, CONTACT_A, RECORD_A);
  }

  // =========================================================================
  describe("PRECONDITION — the old shape really cannot express the new pairs", () => {
    it("refuses a record-to-record question and a contact-to-contact verdict before the migration", () => {
      // Without this, every "admits it after" assertion below would be green on
      // a database that had always accepted them.
      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_link_proposals
               (id, user_id, contact_id, source_type, source_record_id, reason,
                identity_assessment, relationship_assessment, cluster_key)
             VALUES ('p-rr', ?, NULL, 'macos', ?, 'r', 'possibly_same_person',
                     'possibly_connected', 'k')`,
          )
          .run(USER_ID, RECORD_A),
      ).toThrow(/NOT NULL/i);

      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_link_verdicts
               (id, user_id, contact_id, source_type, source_record_id, identity_verdict)
             VALUES ('v-cc', ?, ?, NULL, NULL, 'same_person')`,
          )
          .run(USER_ID, CONTACT_A),
      ).toThrow(/NOT NULL/i);
    });
  });

  // =========================================================================
  describe("the rebuild", () => {
    it("copies BY NAME — a verdict whose columns are declared in a different order lands field for field", async () => {
      seedRecordContactRows();
      await runV69();

      // The fixture declares `decided_by` third and `reason` fourth; the new
      // table declares them last. Under `SELECT *` the values would land in
      // each other's columns and every row would still be present.
      expect(
        harness.db
          .prepare(
            `SELECT id, user_id, decided_by, reason, contact_id, source_type,
                    source_record_id, identity_verdict, matched_on, evidence_json,
                    decided_at, pair_kind, subject_side, pair_key
               FROM contact_link_verdicts`,
          )
          .all(),
      ).toEqual([
        {
          id: "v-1",
          user_id: USER_ID,
          decided_by: "user",
          reason: "answered",
          contact_id: CONTACT_A,
          source_type: "macos",
          source_record_id: RECORD_A,
          identity_verdict: "different_people",
          matched_on: "email",
          evidence_json: '{"summary":"frozen"}',
          decided_at: "2026-06-10 12:00:00",
          pair_kind: "record_contact",
          subject_side: "a",
          pair_key: `c:${CONTACT_A}|r:macos:${RECORD_A}`,
        },
      ]);
    });

    it("recreates the index each table's DROP took with it", async () => {
      await runV69();
      expect(indexNames(harness.db)).toEqual(
        expect.arrayContaining([
          "idx_contact_link_proposals_pending",
          "idx_contact_link_verdicts_pair",
        ]),
      );
    });

    it("keeps the FK asymmetry: proposals cascade, verdicts deliberately do not", async () => {
      seedRecordContactRows();
      await runV69();

      harness.db.pragma("foreign_keys = ON");
      harness.db.prepare("DELETE FROM contacts WHERE id = ?").run(CONTACT_A);

      // The QUESTION about a deleted contact is noise and goes.
      expect(harness.db.prepare("SELECT id FROM contact_link_proposals").all()).toEqual([]);
      // The ANSWER is evidence and stays — "these two are different people"
      // remains true after the contact row is gone, and nothing can regenerate
      // a person's opinion.
      expect(
        (harness.db.prepare("SELECT id FROM contact_link_verdicts").all() as Array<{ id: string }>)
          .map((r) => r.id),
      ).toEqual(["v-1"]);
    });
  });

  // =========================================================================
  describe("re-runs and absent tables", () => {
    it("is idempotent — a second run leaves the DDL and the rows byte-identical", async () => {
      seedRecordContactRows();
      await runV69();

      const ddlAfterFirst = [
        tableSql(harness.db, "contact_link_proposals"),
        tableSql(harness.db, "contact_link_verdicts"),
      ];
      const rowsAfterFirst = [
        harness.db.prepare("SELECT rowid, * FROM contact_link_proposals ORDER BY id").all(),
        harness.db.prepare("SELECT rowid, * FROM contact_link_verdicts ORDER BY id").all(),
      ];

      await runV69();

      expect([
        tableSql(harness.db, "contact_link_proposals"),
        tableSql(harness.db, "contact_link_verdicts"),
      ]).toEqual(ddlAfterFirst);
      // ROWIDS INCLUDED. A guard that fired twice would rebuild the table and
      // reassign them, which is invisible to a plain row comparison and is
      // exactly what the verdicts tiebreak rides on.
      expect([
        harness.db.prepare("SELECT rowid, * FROM contact_link_proposals ORDER BY id").all(),
        harness.db.prepare("SELECT rowid, * FROM contact_link_verdicts ORDER BY id").all(),
      ]).toEqual(rowsAfterFirst);
    });

    it("no-ops without the tables, so a partial-schema fixture does not throw", async () => {
      harness.db.exec("DROP TABLE contact_link_proposals; DROP TABLE contact_link_verdicts;");
      // A throw inside a migration is escalated to a restore-from-backup dialog,
      // which is a catastrophic response to an absent table.
      await expect(runV69()).resolves.not.toThrow();
    });
  });

  // =========================================================================
  describe("the shape CHECK keeps each pair honest", () => {
    beforeEach(async () => {
      await runV69();
    });

    const proposal = (cols: string, vals: string) =>
      `INSERT INTO contact_link_proposals
         (id, user_id, reason, identity_assessment, relationship_assessment, cluster_key, ${cols})
       VALUES (?, ?, 'r', 'possibly_same_person', 'possibly_connected', 'k', ${vals})`;

    it("refuses a record pair that carries a contact — the sentinel-row shortcut is closed", () => {
      // Pointing a record pair's contact column at a placeholder is the exact
      // shortcut the founder prohibited: it trades a schema problem for a data
      // problem every reader of `contacts` inherits.
      expect(() =>
        harness.db
          .prepare(
            proposal(
              "pair_kind, contact_id, source_type, source_record_id, target_source_type, target_source_record_id",
              "'record_record', ?, 'macos', ?, 'outlook', ?",
            ),
          )
          .run("p-x", USER_ID, CONTACT_A, RECORD_A, RECORD_B),
      ).toThrow(/CHECK/i);
    });

    it("refuses a contact pair that carries a source record", () => {
      expect(() =>
        harness.db
          .prepare(
            proposal(
              "pair_kind, contact_id, target_contact_id, source_type, source_record_id",
              "'contact_contact', ?, ?, 'macos', ?",
            ),
          )
          .run("p-y", USER_ID, CONTACT_A, CONTACT_B, RECORD_A),
      ).toThrow(/CHECK/i);
    });

    it("refuses a pair whose two sides are the same thing", () => {
      expect(() =>
        harness.db
          .prepare(
            proposal("pair_kind, contact_id, target_contact_id", "'contact_contact', ?, ?"),
          )
          .run("p-z", USER_ID, CONTACT_A, CONTACT_A),
      ).toThrow(/CHECK/i);

      expect(() =>
        harness.db
          .prepare(
            proposal(
              "pair_kind, source_type, source_record_id, target_source_type, target_source_record_id",
              "'record_record', 'macos', ?, 'macos', ?",
            ),
          )
          .run("p-z2", USER_ID, RECORD_A, RECORD_A),
      ).toThrow(/CHECK/i);
    });

    it("pins the SUBJECT of a record-to-contact question to the contact", () => {
      // BACKLOG-2616, 13 Aug: "The proposal must record which side is the
      // SUBJECT" — a row naming only a pair cannot be executed later. For this
      // shape the subject is the contact, side 'a'.
      expect(() =>
        harness.db
          .prepare(
            proposal(
              "pair_kind, contact_id, source_type, source_record_id, subject_side",
              "'record_contact', ?, 'macos', ?, 'b'",
            ),
          )
          .run("p-s", USER_ID, CONTACT_A, RECORD_A),
      ).toThrow(/CHECK/i);

      // ...and it is FREE on the two new shapes, because D3 decides the
      // incumbent at emission. A CHECK forbidding a value here would force the
      // third table rebuild this slice exists to avoid.
      expect(() =>
        harness.db
          .prepare(
            proposal(
              "pair_kind, contact_id, target_contact_id, subject_side",
              "'contact_contact', ?, ?, 'b'",
            ),
          )
          .run("p-s2", USER_ID, CONTACT_A, CONTACT_B),
      ).not.toThrow();
    });

    it("keeps the source vocabulary narrow on BOTH record endpoints (BACKLOG-2473)", () => {
      // There is no external record behind an origin row and no question to ask
      // about one, so `manual`/`email`/`sms`/`inferred` must never reach these
      // tables. v69 adds a SECOND record endpoint, and it inherits the rule.
      for (const bad of ["manual", "email", "sms", "inferred"]) {
        expect(() =>
          harness.db
            .prepare(
              proposal(
                "pair_kind, source_type, source_record_id, target_source_type, target_source_record_id",
                `'record_record', 'macos', ?, '${bad}', ?`,
              ),
            )
            .run(`p-v-${bad}`, USER_ID, RECORD_A, RECORD_B),
        ).toThrow(/CHECK/i);
      }
    });
  });

  // =========================================================================
  describe("parity — the migration and the shared constants agree", () => {
    it("produces byte-identical DDL to a database built from the constants alone", async () => {
      await runV69();

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const {
        CONTACT_LINK_PROPOSALS_TABLE_SQL,
        CONTACT_LINK_VERDICTS_TABLE_SQL,
      } = require("../db/contactIdentitySchemaSql");

      const fresh = new RealDatabase(":memory:") as DatabaseType;
      try {
        fresh.exec("CREATE TABLE contacts (id TEXT PRIMARY KEY);");
        fresh.exec(CONTACT_LINK_PROPOSALS_TABLE_SQL);
        fresh.exec(CONTACT_LINK_VERDICTS_TABLE_SQL);

        // The rebuild creates its table under a temporary name and RENAMEs it,
        // which rewrites the stored DDL. Comparing the text is what proves the
        // rename left no trace of the scratch name and that the two routes
        // cannot drift.
        //
        // TWO NORMALISATIONS, AND ONLY TWO — lifted verbatim from the v59
        // parity assertion, which faced the identical problem:
        //   1. collapse whitespace (the constants are indented for reading);
        //   2. unquote the table name in `CREATE TABLE "x"`, because SQLite
        //      rewrites the stored DDL when `ALTER TABLE ... RENAME` runs and
        //      quotes the new name, while the constants create it directly.
        // Column order, constraints, CHECK vocabularies, the generated
        // expression and defaults all still have to match exactly. Identifier
        // quoting uses double quotes and every string literal in this DDL uses
        // single quotes, so the substitution cannot touch a CHECK vocabulary.
        const normalise = (sql: string) =>
          sql
            .replace(/\s+/g, " ")
            .replace(/CREATE TABLE "([^"]+)"/, "CREATE TABLE $1")
            .trim();

        for (const t of ["contact_link_proposals", "contact_link_verdicts"]) {
          expect(normalise(tableSql(harness.db, t))).toBe(normalise(tableSql(fresh, t)));
          // The scratch table name must leave no trace at all.
          expect(tableSql(harness.db, t)).not.toMatch(/_v69/);
        }
      } finally {
        fresh.close();
      }
    });
  });
});
