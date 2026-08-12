/**
 * @jest-environment node
 *
 * Integration test for migration v64 (BACKLOG-2609 — the review queue learns to
 * ask about a CONTACT, not only about a source record).
 *
 * Before v64 every proposal's subject was a source record BY CHECK AND BY NOT
 * NULL, so "are these two saved contacts one person?" — the question
 * BACKLOG-2616 is built on — could not be stored at all. SQLite cannot ALTER a
 * CHECK, so admitting it is a TABLE REBUILD.
 *
 * A TABLE REBUILD IS THE HIGHEST-RISK SHAPE OF MIGRATION THERE IS, and this repo
 * has been bitten by it twice — v33 `audit_logs`, v36 `contacts`. Both were
 * positional copies: every row survives, holding its neighbour's value, so no row
 * count and no "did it throw" check can see it. The seeded rows here are
 * therefore asserted FIELD FOR FIELD, and one test deliberately seeds a table
 * whose columns are DECLARED IN A DIFFERENT ORDER.
 *
 * The other half of this file is about what must NOT change. The single
 * production writer (`proposeLink`, `INSERT OR IGNORE`, 11 named columns), the
 * single updater (`resolveProposal`) and the readers are exercised against the
 * REBUILT table — not re-implemented here — because "existing writers still work"
 * is a claim about those functions, not about SQL that resembles them.
 *
 * WHAT THIS FILE IS **NOT**. Everything here runs against
 * `createMigrationHarness` — `:memory:`, `dbPath = null`. The real on-disk
 * coverage is in `databaseService.onDiskUpgrade.test.ts` ("v64 rebuilds a
 * POPULATED review queue on the real file...").
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
import { CONTACT_LINK_PROPOSALS_LEGACY_COLUMNS } from "../db/contactIdentitySchemaSql";
import {
  listPendingProposals,
  proposeLink,
  resolveProposal,
} from "../db/contactLinkReviewDbService";

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"));

const USER_ID = "user-v64";
const CONTACT_IDS = ["c-alpha", "c-beta", "c-gamma"];
/** Fixed proposal ids — every survival assertion is an ID SET, never a count. */
const PROPOSAL_IDS = ["p-1", "p-2", "p-3"];

/**
 * The PRE-v64 `contact_link_proposals`, transcribed from the shape that shipped
 * in v59/v61 — NOT exec'd from the shared constant.
 *
 * This transcription is mandatory and is the lesson of BACKLOG-2298: there is one
 * DDL constant and it always describes the CURRENT shape, so a chain replayed
 * with today's code has v59 emit the v64 table and never produces the state a
 * shipped v63 install actually has. A fixture built from the constant would make
 * every assertion below pass without the rebuild ever running.
 */
const PRE_V64_PROPOSALS_SQL = `
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
`;

/**
 * The same pre-v64 table with its columns DECLARED IN A DIFFERENT ORDER.
 *
 * This is the fixture that catches a positional copy. Under `SELECT *` the copy
 * lands every value in its neighbour's column and the CHECK constraints throw —
 * which is what the v59 rebuild's equivalent test proved by running it.
 */
const PRE_V64_PROPOSALS_SHUFFLED_SQL = `
  CREATE TABLE contact_link_proposals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    cluster_key TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (
      source_type IN ('macos', 'iphone', 'outlook', 'google_contacts', 'android_sync')
    ),
    matched_on TEXT,
    source_record_id TEXT NOT NULL,
    identity_assessment TEXT NOT NULL CHECK (
      identity_assessment IN ('same_person', 'possibly_same_person', 'different_people')
    ),
    evidence_json TEXT,
    relationship_assessment TEXT NOT NULL CHECK (
      relationship_assessment IN ('connected', 'possibly_connected', 'no_known_connection')
    ),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending', 'confirmed', 'rejected')
    ),
    resolved_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    UNIQUE (user_id, contact_id, source_type, source_record_id)
  );
  CREATE INDEX idx_contact_link_proposals_pending
    ON contact_link_proposals(user_id, status, cluster_key);
`;

const BASE_FIXTURE = `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);

  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    removed_at DATETIME,
    person_id TEXT,
    FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
  );

  CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migrated_at TEXT DEFAULT (datetime('now'))
  );
`;

function columns(db: DatabaseType, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
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

function proposalIds(db: DatabaseType): string[] {
  return (
    db.prepare("SELECT id FROM contact_link_proposals ORDER BY id").all() as Array<{ id: string }>
  ).map((r) => r.id);
}

describe("databaseService migration v64 (BACKLOG-2609 — polymorphic proposal subject)", () => {
  let harness: MigrationHarness;

  function build(proposalsDdl: string): void {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(BASE_FIXTURE);
    harness.db.exec(proposalsDdl);
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
    const contact = harness.db.prepare(
      "INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)",
    );
    for (const id of CONTACT_IDS) contact.run(id, USER_ID, `Name ${id}`);
  }

  /**
   * Three proposals with every column populated to a DISTINCT, recognisable
   * value — including the nullable ones. A field-for-field assertion is only
   * meaningful if no two columns hold the same value.
   */
  function seedProposals(): void {
    const stmt = harness.db.prepare(
      `INSERT INTO contact_link_proposals
         (id, user_id, contact_id, source_type, source_record_id, status, reason,
          matched_on, identity_assessment, relationship_assessment, cluster_key,
          evidence_json, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      "p-1", USER_ID, "c-alpha", "macos", "mac-1", "pending", "ambiguous_identifier",
      "email", "possibly_same_person", "possibly_connected", "cluster:one",
      '{"summary":"one"}', "2026-01-01 00:00:00", null,
    );
    stmt.run(
      "p-2", USER_ID, "c-beta", "outlook", "out-9", "confirmed", "identifier_reassigned",
      "phone", "same_person", "connected", "cluster:two",
      '{"summary":"two"}', "2026-02-02 00:00:00", "2026-02-03 00:00:00",
    );
    stmt.run(
      "p-3", USER_ID, "c-gamma", "iphone", "iph-7", "rejected", "name_not_unique",
      null, "different_people", "no_known_connection", "cluster:three",
      null, "2026-03-03 00:00:00", "2026-03-04 00:00:00",
    );
  }

  afterEach(async () => {
    if (harness) {
      try {
        await harness.cleanup();
      } catch {
        /* already cleaned */
      }
    }
  });

  /** Seed at 63 and clip at 64 so ONLY v64 runs. */
  async function runV64(): Promise<void> {
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 63)").run();
    const klass = harness.service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const all = klass.MIGRATIONS;
    klass.MIGRATIONS = all.filter((m) => m.version <= 64);
    try {
      await harness.service._runVersionedMigrations();
    } finally {
      klass.MIGRATIONS = all;
    }
  }

  // =========================================================================
  describe("preconditions — the wall v64 removes", () => {
    beforeEach(() => build(PRE_V64_PROPOSALS_SQL));

    it("cannot store a contact-to-contact question BEFORE the migration", () => {
      // No subject_kind column at all, and source_record_id is NOT NULL — the
      // question BACKLOG-2616 needs has nowhere to go.
      expect(columns(harness.db, "contact_link_proposals")).not.toContain("subject_kind");
      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_link_proposals
               (id, user_id, contact_id, source_type, source_record_id, reason,
                identity_assessment, relationship_assessment, cluster_key)
             VALUES ('pre', ?, 'c-alpha', 'macos', NULL, 'ambiguous_identifier',
                     'possibly_same_person', 'possibly_connected', 'k')`,
          )
          .run(USER_ID),
      ).toThrow(/NOT NULL/i);
    });
  });

  // =========================================================================
  describe("the rebuild", () => {
    beforeEach(() => build(PRE_V64_PROPOSALS_SQL));

    it("reaches version 64", async () => {
      await runV64();
      expect(
        (
          harness.db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
            version: number;
          }
        ).version,
      ).toBe(64);
    });

    it("adds subject_kind, target_contact_id and relaxes the source columns", async () => {
      await runV64();

      const info = harness.db.prepare("PRAGMA table_info(contact_link_proposals)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const byName = Object.fromEntries(info.map((c) => [c.name, c]));

      expect(byName["subject_kind"]).toMatchObject({ notnull: 1, dflt_value: "'source_record'" });
      expect(byName["target_contact_id"]).toMatchObject({ notnull: 0 });
      // The two columns that used to be NOT NULL now are not — this is what lets
      // a contact-kind question exist.
      expect(byName["source_type"].notnull).toBe(0);
      expect(byName["source_record_id"].notnull).toBe(0);
    });

    it("keeps EVERY pre-existing proposal, by exact ID SET", async () => {
      seedProposals();
      expect(proposalIds(harness.db)).toEqual([...PROPOSAL_IDS].sort());

      await runV64();

      expect(proposalIds(harness.db)).toEqual([...PROPOSAL_IDS].sort());
    });

    it("carries every column FIELD FOR FIELD, and stamps the copied rows 'source_record'", async () => {
      seedProposals();
      const before = harness.db
        .prepare(
          `SELECT ${CONTACT_LINK_PROPOSALS_LEGACY_COLUMNS.join(", ")}
             FROM contact_link_proposals ORDER BY id`,
        )
        .all();

      await runV64();

      const after = harness.db
        .prepare(
          `SELECT ${CONTACT_LINK_PROPOSALS_LEGACY_COLUMNS.join(", ")}
             FROM contact_link_proposals ORDER BY id`,
        )
        .all();
      expect(after).toEqual(before);

      // Every copied row is a source-record question, via the DEFAULT — nothing
      // in the copy names the column.
      expect(
        harness.db
          .prepare("SELECT DISTINCT subject_kind FROM contact_link_proposals")
          .all(),
      ).toEqual([{ subject_kind: "source_record" }]);
      expect(
        harness.db
          .prepare("SELECT id FROM contact_link_proposals WHERE target_contact_id IS NOT NULL")
          .all(),
      ).toEqual([]);
    });

    it("recreates the pending index and adds the contact-pair index", async () => {
      const before = indexNames(harness.db);
      expect(before).toContain("idx_contact_link_proposals_pending");

      await runV64();

      expect(indexNames(harness.db)).toEqual(
        [...before, "idx_contact_link_proposals_contact_pair"].sort(),
      );
    });

    it("is re-runnable: a second pass changes no row and no index", async () => {
      seedProposals();
      await runV64();

      const rowsAfterFirst = harness.db
        .prepare("SELECT * FROM contact_link_proposals ORDER BY id")
        .all();
      const indexesAfterFirst = indexNames(harness.db);

      const klass = harness.service.constructor as {
        MIGRATIONS: Array<{ version: number; migrate: (d: DatabaseType) => void }>;
      };
      klass.MIGRATIONS.find((m) => m.version === 64)?.migrate(harness.db);

      expect(harness.db.prepare("SELECT * FROM contact_link_proposals ORDER BY id").all()).toEqual(
        rowsAfterFirst,
      );
      expect(indexNames(harness.db)).toEqual(indexesAfterFirst);
    });

    it("no-ops on a database with no proposals table (partial fixture)", async () => {
      const bare = createMigrationHarness({ seedV29Schema: false });
      try {
        bare.db.exec(BASE_FIXTURE);
        bare.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 63)").run();

        const klass = bare.service.constructor as { MIGRATIONS: Array<{ version: number }> };
        const all = klass.MIGRATIONS;
        klass.MIGRATIONS = all.filter((m) => m.version <= 64);
        try {
          await expect(bare.service._runVersionedMigrations()).resolves.not.toThrow();
        } finally {
          klass.MIGRATIONS = all;
        }

        expect(
          bare.db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='contact_link_proposals'",
            )
            .get(),
        ).toBeUndefined();
      } finally {
        await bare.cleanup();
      }
    });
  });

  // =========================================================================
  describe("the copy is BY NAME — the v33/v36 corruption shape", () => {
    it("lands field for field even when the old columns are DECLARED IN A DIFFERENT ORDER", async () => {
      build(PRE_V64_PROPOSALS_SHUFFLED_SQL);
      seedProposals();

      await runV64();

      // Values, not just ids: a positional copy puts every value in its
      // neighbour's column, which no row count can see.
      expect(
        harness.db
          .prepare(
            `SELECT id, contact_id, source_type, source_record_id, status, reason,
                    matched_on, identity_assessment, relationship_assessment,
                    cluster_key, evidence_json
               FROM contact_link_proposals ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: "p-1", contact_id: "c-alpha", source_type: "macos", source_record_id: "mac-1",
          status: "pending", reason: "ambiguous_identifier", matched_on: "email",
          identity_assessment: "possibly_same_person", relationship_assessment: "possibly_connected",
          cluster_key: "cluster:one", evidence_json: '{"summary":"one"}',
        },
        {
          id: "p-2", contact_id: "c-beta", source_type: "outlook", source_record_id: "out-9",
          status: "confirmed", reason: "identifier_reassigned", matched_on: "phone",
          identity_assessment: "same_person", relationship_assessment: "connected",
          cluster_key: "cluster:two", evidence_json: '{"summary":"two"}',
        },
        {
          id: "p-3", contact_id: "c-gamma", source_type: "iphone", source_record_id: "iph-7",
          status: "rejected", reason: "name_not_unique", matched_on: null,
          identity_assessment: "different_people", relationship_assessment: "no_known_connection",
          cluster_key: "cluster:three", evidence_json: null,
        },
      ]);
    });
  });

  // =========================================================================
  describe("the existing writers and readers, against the REBUILT table", () => {
    beforeEach(() => build(PRE_V64_PROPOSALS_SQL));

    /**
     * The single production INSERT names ELEVEN columns and will never name
     * `subject_kind`. If the DEFAULT were dropped, every linking pass would throw
     * NOT NULL — so this is the assertion that keeps the widening backward
     * compatible.
     */
    it("proposeLink() still writes, unchanged, and lands subject_kind='source_record'", async () => {
      await runV64();

      const result = proposeLink({
        userId: USER_ID,
        contactId: "c-alpha",
        sourceType: "macos",
        sourceRecordId: "mac-new",
        reason: "ambiguous_identifier",
        matchedOn: "email",
        identityAssessment: "possibly_same_person",
        relationshipAssessment: "possibly_connected",
        clusterKey: "cluster:new",
        evidence: {
          summary: "s",
          details: [],
          contactLabel: "c",
          sourceLabel: "s",
          sourceName: null,
        },
      });

      expect(result.created).toBe(true);
      expect(
        harness.db
          .prepare(
            "SELECT subject_kind, target_contact_id, status FROM contact_link_proposals WHERE id = ?",
          )
          .get(result.id as string),
      ).toEqual({ subject_kind: "source_record", target_contact_id: null, status: "pending" });
    });

    it("the pair UNIQUE still dedups a repeated question (INSERT OR IGNORE, every status)", async () => {
      seedProposals();
      await runV64();

      // p-1 is pending, p-2 is confirmed, p-3 rejected — the UNIQUE spans all of
      // them, so none of these three may create a row.
      for (const [contactId, sourceType, sourceRecordId] of [
        ["c-alpha", "macos", "mac-1"],
        ["c-beta", "outlook", "out-9"],
        ["c-gamma", "iphone", "iph-7"],
      ] as const) {
        const again = proposeLink({
          userId: USER_ID,
          contactId,
          sourceType,
          sourceRecordId,
          reason: "ambiguous_identifier",
          matchedOn: null,
          identityAssessment: "possibly_same_person",
          relationshipAssessment: "possibly_connected",
          clusterKey: "cluster:repeat",
          evidence: {
            summary: "s",
            details: [],
            contactLabel: "c",
            sourceLabel: "s",
            sourceName: null,
          },
        });
        expect(again.created).toBe(false);
      }

      expect(proposalIds(harness.db)).toEqual([...PROPOSAL_IDS].sort());
    });

    it("listPendingProposals() returns byte-identical rows across the rebuild", async () => {
      seedProposals();
      const before = listPendingProposals(USER_ID);
      expect(before.map((r) => r.id)).toEqual(["p-1"]);

      await runV64();

      expect(listPendingProposals(USER_ID)).toEqual(before);
    });

    it("resolveProposal() still resolves a pending row", async () => {
      seedProposals();
      await runV64();

      expect(resolveProposal("p-1", "confirmed")).toBe(true);
      expect(
        harness.db.prepare("SELECT status FROM contact_link_proposals WHERE id = 'p-1'").get(),
      ).toEqual({ status: "confirmed" });
      // Already resolved — the WHERE status = 'pending' guard still holds.
      expect(resolveProposal("p-2", "rejected")).toBe(false);
    });

    /**
     * BACKLOG-2473's rule survives the widening: a proposal about a SOURCE RECORD
     * still admits only the five external source types. `manual`/`email`/`sms`/
     * `inferred` describe origin rows, behind which there is no external record
     * and therefore no question to ask. `migration-v61.test.ts:347-372` asserts
     * this same refusal; it must not become collateral damage of the rebuild.
     */
    it("still refuses 'manual' as a source_type", async () => {
      await runV64();

      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_link_proposals
               (id, user_id, contact_id, source_type, source_record_id, reason,
                identity_assessment, relationship_assessment, cluster_key)
             VALUES ('p-manual', ?, 'c-alpha', 'manual', 'r1', 'ambiguous_identifier',
                     'possibly_same_person', 'possibly_connected', 'k')`,
          )
          .run(USER_ID),
      ).toThrow(/CHECK/i);
    });
  });

  // =========================================================================
  describe("the contact-to-contact question, which is the point", () => {
    beforeEach(() => build(PRE_V64_PROPOSALS_SQL));

    function askAboutPair(id: string, contactId: string, targetId: string): void {
      harness.db
        .prepare(
          `INSERT INTO contact_link_proposals
             (id, user_id, contact_id, subject_kind, target_contact_id, reason,
              identity_assessment, relationship_assessment, cluster_key)
           VALUES (?, ?, ?, 'contact', ?, 'ambiguous_identifier',
                   'possibly_same_person', 'possibly_connected', 'pair')`,
        )
        .run(id, USER_ID, contactId, targetId);
    }

    it("stores 'are these two contacts one person?' with its DIRECTION", async () => {
      await runV64();
      askAboutPair("q-1", "c-alpha", "c-beta");

      // contact_id = A, the incumbent the duplicate was found FOR;
      // target_contact_id = B, the record found to be its duplicate. BACKLOG-2611's
      // merge rule ("single-valued fields take A") is executable only off this
      // asymmetry, so the pair is ORDERED and both sides are read back here.
      expect(
        harness.db
          .prepare(
            "SELECT contact_id, target_contact_id, source_type, source_record_id FROM contact_link_proposals WHERE id = 'q-1'",
          )
          .get(),
      ).toEqual({
        contact_id: "c-alpha",
        target_contact_id: "c-beta",
        source_type: null,
        source_record_id: null,
      });
    });

    /**
     * THE NULL-DISTINCTNESS HOLE, asserted rather than assumed.
     *
     * SQLite treats NULLs as DISTINCT in a UNIQUE constraint, so the table-level
     * UNIQUE — which names the two now-NULL source columns — cannot dedup a
     * contact-kind row. Without the partial index the same unanswered question is
     * appended on EVERY pass, which is precisely the unbounded growth the UNIQUE
     * was added to prevent.
     */
    it("dedups a repeated contact-to-contact question via the partial index", async () => {
      await runV64();
      askAboutPair("q-1", "c-alpha", "c-beta");

      expect(() => askAboutPair("q-2", "c-alpha", "c-beta")).toThrow(/UNIQUE/i);
      expect(proposalIds(harness.db)).toEqual(["q-1"]);
    });

    it("treats the REVERSED pair as a different question — direction is identity", async () => {
      await runV64();
      askAboutPair("q-1", "c-alpha", "c-beta");
      askAboutPair("q-2", "c-beta", "c-alpha");

      expect(proposalIds(harness.db)).toEqual(["q-1", "q-2"]);
    });

    it("refuses a contact-kind row that also carries a source record", async () => {
      await runV64();

      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_link_proposals
               (id, user_id, contact_id, subject_kind, source_type, source_record_id,
                target_contact_id, reason, identity_assessment, relationship_assessment, cluster_key)
             VALUES ('bad', ?, 'c-alpha', 'contact', 'macos', 'mac-1', 'c-beta',
                     'ambiguous_identifier', 'possibly_same_person', 'possibly_connected', 'k')`,
          )
          .run(USER_ID),
      ).toThrow(/CHECK/i);
    });

    it("refuses a contact-kind row with no target", async () => {
      await runV64();

      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_link_proposals
               (id, user_id, contact_id, subject_kind, reason,
                identity_assessment, relationship_assessment, cluster_key)
             VALUES ('bad', ?, 'c-alpha', 'contact', 'ambiguous_identifier',
                     'possibly_same_person', 'possibly_connected', 'k')`,
          )
          .run(USER_ID),
      ).toThrow(/CHECK/i);
    });

    it("refuses a source-record row whose source columns are missing", async () => {
      await runV64();

      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_link_proposals
               (id, user_id, contact_id, reason,
                identity_assessment, relationship_assessment, cluster_key)
             VALUES ('bad', ?, 'c-alpha', 'ambiguous_identifier',
                     'possibly_same_person', 'possibly_connected', 'k')`,
          )
          .run(USER_ID),
      ).toThrow(/CHECK/i);
    });

    it("refuses the degenerate self-pair", async () => {
      await runV64();

      expect(() => askAboutPair("bad", "c-alpha", "c-alpha")).toThrow(/CHECK/i);
    });

    it("refuses an unknown subject_kind", async () => {
      await runV64();

      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_link_proposals
               (id, user_id, contact_id, subject_kind, target_contact_id, reason,
                identity_assessment, relationship_assessment, cluster_key)
             VALUES ('bad', ?, 'c-alpha', 'merge_everything', 'c-beta', 'ambiguous_identifier',
                     'possibly_same_person', 'possibly_connected', 'k')`,
          )
          .run(USER_ID),
      ).toThrow(/CHECK/i);
    });

    /**
     * `own_record_change` is BACKLOG-2675's question ("your own record changed —
     * apply?"). It is source-backed, and it is defined narrowly NOW on purpose: a
     * CHECK loosened later is the fourth rebuild of this table, which is the exact
     * cost this widening exists to avoid.
     */
    it("admits an own_record_change question alongside a source_record one for the same pair", async () => {
      await runV64();

      const insert = harness.db.prepare(
        `INSERT INTO contact_link_proposals
           (id, user_id, contact_id, subject_kind, source_type, source_record_id, reason,
            identity_assessment, relationship_assessment, cluster_key)
         VALUES (?, ?, 'c-alpha', ?, 'macos', 'mac-1', 'ambiguous_identifier',
                 'possibly_same_person', 'possibly_connected', 'k')`,
      );
      insert.run("q-src", USER_ID, "source_record");
      insert.run("q-own", USER_ID, "own_record_change");

      // Both survive: subject_kind is part of the UNIQUE tuple precisely so two
      // different questions about one pair can coexist.
      expect(proposalIds(harness.db)).toEqual(["q-own", "q-src"]);
      // ...and a repeat of either is still refused.
      expect(() => insert.run("q-dup", USER_ID, "own_record_change")).toThrow(/UNIQUE/i);
    });

    it("refuses an own_record_change row carrying a target contact", async () => {
      await runV64();

      expect(() =>
        harness.db
          .prepare(
            `INSERT INTO contact_link_proposals
               (id, user_id, contact_id, subject_kind, source_type, source_record_id,
                target_contact_id, reason, identity_assessment, relationship_assessment, cluster_key)
             VALUES ('bad', ?, 'c-alpha', 'own_record_change', 'macos', 'mac-1', 'c-beta',
                     'ambiguous_identifier', 'possibly_same_person', 'possibly_connected', 'k')`,
          )
          .run(USER_ID),
      ).toThrow(/CHECK/i);
    });

    /**
     * THE ASSERTION THAT SEPARATES THE NEW FK FROM A DECORATION.
     *
     * Deleting a contact that a row names ONLY as `target_contact_id` is the only
     * way to observe `FOREIGN KEY (target_contact_id) ... ON DELETE CASCADE`
     * firing — delete the subject instead and the old `contact_id` FK does the
     * work, which is the trap the on-disk version of this test originally fell
     * into. `PRAGMA foreign_key_list` cannot distinguish them either: it returns
     * table names, so both read as ["contacts", "contacts"].
     *
     * `q-3` is the survivor control. Without a row that must NOT die, an
     * over-broad cascade — or a `DELETE FROM contact_link_proposals` anywhere in
     * the path — would satisfy the assertion just as well.
     */
    it("cascades away a question whose TARGET is deleted, and spares the others", async () => {
      await runV64();
      harness.db.pragma("foreign_keys = ON");
      askAboutPair("q-1", "c-alpha", "c-beta"); // c-beta as TARGET only
      askAboutPair("q-2", "c-gamma", "c-beta"); // c-beta as TARGET only
      askAboutPair("q-3", "c-alpha", "c-gamma"); // does not mention c-beta at all

      harness.db.prepare("DELETE FROM contacts WHERE id = 'c-beta'").run();
      expect(proposalIds(harness.db)).toEqual(["q-3"]);

      // ...and the ORIGINAL FK still fires, on the row that just survived.
      harness.db.prepare("DELETE FROM contacts WHERE id = 'c-alpha'").run();
      expect(proposalIds(harness.db)).toEqual([]);
    });
  });
});
