/**
 * @jest-environment node
 *
 * Integration test for migration v63 (BACKLOG-2609 — the person layer: the node
 * ABOVE contacts).
 *
 * v63 does three things and nothing else: creates `persons`, adds
 * `contacts.person_id`, and gives every existing contact its own person. No read,
 * no projection, no export and no renderer is rewired — the migration is inert by
 * design, and several assertions below exist only to prove that.
 *
 * WHAT THIS FILE IS **NOT**. Everything here runs against
 * `createMigrationHarness` — `:memory:`, `dbPath = null`, calling
 * `_runVersionedMigrations()` directly. That is a synthetic fixture and is exactly
 * the pattern BACKLOG-2298 warns about: a migration can pass every assertion below
 * and still break a real old->new upgrade, because `schema.sql` is exec'd BEFORE
 * the chain on a real file and nothing here reproduces that ordering.
 *
 * THE REAL ON-DISK COVERAGE FOR v63 IS IN `databaseService.onDiskUpgrade.test.ts`
 * ("v63 creates the person layer on a REAL old database..."), which starts from a
 * real v55 file, execs the real `schema.sql`, and drives the PUBLIC
 * `runMigrations()` to head.
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
import { PERSONS_COLUMNS } from "../db/personSchemaSql";

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"));

const USER_ID = "user-v63";
const OTHER_USER_ID = "user-v63-other";

/** Fixed ids — every assertion below is an ID SET, never a count. */
const LIVE_CONTACT_IDS = ["c-alpha", "c-beta", "c-gamma"];
/**
 * A TOMBSTONED contact. It must be backfilled like any other: contacts are
 * tombstoned rather than deleted (v56), and "restore rejoins the SAME person"
 * works only because the tombstoned row keeps its `person_id`. A backfill that
 * filtered on `removed_at IS NULL` would pass every other test in this file and
 * silently un-merge a person on the first delete/restore round trip.
 */
const REMOVED_CONTACT_ID = "c-deleted";
/** A contact belonging to a SECOND local user — its person must carry that user. */
const OTHER_USER_CONTACT_ID = "c-other-user";
const ALL_CONTACT_IDS = [
  ...LIVE_CONTACT_IDS,
  REMOVED_CONTACT_ID,
  OTHER_USER_CONTACT_ID,
];

/** A fixed, recognisable timestamp so "did updated_at move" is unambiguous. */
const SEEDED_UPDATED_AT = "2020-01-01 00:00:00";

/**
 * A REAL post-v62 database: `contacts` as it stands after v56's tombstone
 * columns, WITHOUT `person_id`, plus the AFTER UPDATE trigger from
 * `schema.sql:1135` — which is the whole reason this migration is delicate.
 *
 * The trigger is transcribed here from `schema.sql`, not invented: v63 has to
 * drop and recreate it around its backfill, and a fixture without it would make
 * the "updated_at did not move" assertion pass against a database that could not
 * fail it.
 */
const PRE_V63_FIXTURE = `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);

  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    company TEXT,
    title TEXT,
    source TEXT DEFAULT 'manual',
    removed_at DATETIME,
    removed_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
  );

  CREATE INDEX idx_contacts_user_id ON contacts(user_id);

  CREATE TRIGGER update_contacts_timestamp
  AFTER UPDATE ON contacts
  BEGIN
    UPDATE contacts SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
  END;

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

function triggerSql(db: DatabaseType, name: string): string | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name = ?")
    .get(name) as { sql?: string | null } | undefined;
  return typeof row?.sql === "string" ? row.sql : null;
}

describe("databaseService migration v63 (BACKLOG-2609 — the person layer)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(PRE_V63_FIXTURE);
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(OTHER_USER_ID);

    const insert = harness.db.prepare(
      `INSERT INTO contacts (id, user_id, display_name, company, title, removed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const id of LIVE_CONTACT_IDS) {
      insert.run(id, USER_ID, `Name ${id}`, `Co ${id}`, "buyer", null, SEEDED_UPDATED_AT);
    }
    insert.run(
      REMOVED_CONTACT_ID,
      USER_ID,
      "Deleted Person",
      "Gone Ltd",
      "seller",
      "2026-01-01 00:00:00",
      SEEDED_UPDATED_AT,
    );
    insert.run(
      OTHER_USER_CONTACT_ID,
      OTHER_USER_ID,
      "Second User's Contact",
      null,
      null,
      null,
      SEEDED_UPDATED_AT,
    );
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

  /** Seed at 62 and clip at 63 so ONLY v63 runs. */
  async function runV63(): Promise<void> {
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 62)").run();
    const klass = harness.service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const all = klass.MIGRATIONS;
    klass.MIGRATIONS = all.filter((m) => m.version <= 63);
    try {
      await harness.service._runVersionedMigrations();
    } finally {
      klass.MIGRATIONS = all;
    }
  }

  function personIdOf(contactId: string): string | null {
    return (
      harness.db.prepare("SELECT person_id FROM contacts WHERE id = ?").get(contactId) as {
        person_id: string | null;
      }
    ).person_id;
  }

  // =========================================================================
  describe("preconditions — the state v63 acts on", () => {
    it("starts with NO persons table and NO person_id column", () => {
      expect(tableExists(harness.db, "persons")).toBe(false);
      expect(columns(harness.db, "contacts")).not.toContain("person_id");
    });

    it("starts with the seeded contact ID SET, tombstone and all", () => {
      expect(
        (
          harness.db.prepare("SELECT id FROM contacts ORDER BY id").all() as Array<{ id: string }>
        ).map((r) => r.id),
      ).toEqual([...ALL_CONTACT_IDS].sort());
    });

    it("starts with the updated_at trigger LIVE — so the backfill really can be caught", () => {
      expect(triggerSql(harness.db, "update_contacts_timestamp")).toContain("AFTER UPDATE");

      // Prove the trigger fires: an ordinary UPDATE moves updated_at. Without
      // this leg, "updated_at did not move" could be satisfied by a fixture
      // whose trigger never worked.
      harness.db.prepare("UPDATE contacts SET company = 'poke' WHERE id = ?").run("c-alpha");
      expect(
        (
          harness.db.prepare("SELECT updated_at FROM contacts WHERE id = ?").get("c-alpha") as {
            updated_at: string;
          }
        ).updated_at,
      ).not.toBe(SEEDED_UPDATED_AT);
    });
  });

  // =========================================================================
  describe("the structures", () => {
    it("reaches version 63", async () => {
      await runV63();
      expect(
        (
          harness.db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
            version: number;
          }
        ).version,
      ).toBe(63);
    });

    it("creates `persons` with exactly the declared columns", async () => {
      await runV63();
      expect(tableExists(harness.db, "persons")).toBe(true);
      expect(columns(harness.db, "persons")).toEqual([...PERSONS_COLUMNS]);
    });

    it("adds `contacts.person_id` and changes NO other column of contacts", async () => {
      const before = harness.db.prepare("PRAGMA table_info(contacts)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;

      await runV63();

      const after = harness.db.prepare("PRAGMA table_info(contacts)").all() as typeof before;

      // Exactly one column added, and it is person_id.
      expect(after.map((c) => c.name)).toEqual([...before.map((c) => c.name), "person_id"]);
      // Every pre-existing column is byte-identical in type, nullability,
      // default and key role. A rebuild that "just" retyped a column would pass
      // a name-only check.
      for (const col of before) {
        expect(after.find((c) => c.name === col.name)).toEqual(col);
      }
    });

    it("creates NO index — the index-name set is identical before and after", async () => {
      const before = indexNames(harness.db);
      await runV63();
      expect(indexNames(harness.db)).toEqual(before);
    });

    it("leaves the updated_at trigger byte-identical to how it found it", async () => {
      const before = triggerSql(harness.db, "update_contacts_timestamp");
      await runV63();
      expect(triggerSql(harness.db, "update_contacts_timestamp")).toBe(before);

      // ...and still WORKING. A recreated-but-broken trigger would satisfy a
      // text comparison on a fixture that never exercised it.
      harness.db.prepare("UPDATE contacts SET company = 'poke' WHERE id = ?").run("c-beta");
      expect(
        (
          harness.db.prepare("SELECT updated_at FROM contacts WHERE id = ?").get("c-beta") as {
            updated_at: string;
          }
        ).updated_at,
      ).not.toBe(SEEDED_UPDATED_AT);
    });
  });

  // =========================================================================
  describe("the backfill", () => {
    it("gives EVERY contact — tombstoned included — its own DISTINCT person, by ID SET", async () => {
      await runV63();

      const rows = harness.db
        .prepare("SELECT id, person_id FROM contacts ORDER BY id")
        .all() as Array<{ id: string; person_id: string | null }>;

      // Every contact is covered...
      expect(rows.map((r) => r.id)).toEqual([...ALL_CONTACT_IDS].sort());
      // ...every one has a person...
      expect(rows.filter((r) => r.person_id === null)).toEqual([]);
      // ...and no two contacts share one. Asserted as a SET so a backfill that
      // pointed all five at a single person row cannot pass on a count.
      const personIds = rows.map((r) => r.person_id as string);
      expect(new Set(personIds).size).toBe(personIds.length);

      // The persons table holds exactly those ids — no orphans, none missing.
      const personRowIds = (
        harness.db.prepare("SELECT id FROM persons ORDER BY id").all() as Array<{ id: string }>
      ).map((r) => r.id);
      expect(personRowIds).toEqual([...personIds].sort());
    });

    it("carries each contact's user_id onto its person", async () => {
      await runV63();

      const rows = harness.db
        .prepare(
          `SELECT c.id AS contact_id, p.user_id AS person_user
             FROM contacts c JOIN persons p ON p.id = c.person_id
            ORDER BY c.id`,
        )
        .all() as Array<{ contact_id: string; person_user: string }>;

      expect(rows).toEqual(
        [...ALL_CONTACT_IDS].sort().map((id) => ({
          contact_id: id,
          person_user: id === OTHER_USER_CONTACT_ID ? OTHER_USER_ID : USER_ID,
        })),
      );
    });

    it("leaves the person's display fields NULL — the merge seeds them, not this", async () => {
      await runV63();

      const rows = harness.db
        .prepare("SELECT display_name, company, title, removed_at FROM persons")
        .all() as Array<{
        display_name: string | null;
        company: string | null;
        title: string | null;
        removed_at: string | null;
      }>;

      expect(rows).toHaveLength(ALL_CONTACT_IDS.length);
      for (const row of rows) {
        expect(row).toEqual({
          display_name: null,
          company: null,
          title: null,
          removed_at: null,
        });
      }
    });

    /**
     * THE INERTNESS ASSERTION WITH TEETH.
     *
     * The backfill writes `person_id` onto every contact, and `contacts` carries
     * an AFTER UPDATE trigger that stamps `updated_at = CURRENT_TIMESTAMP`. A
     * plain UPDATE would therefore rewrite the whole table's `updated_at` to the
     * instant of the upgrade — a user-visible column, flattened, by a migration
     * that is supposed to change nothing.
     */
    it("does NOT move any contact's updated_at, despite writing to every row", async () => {
      const before = harness.db
        .prepare("SELECT id, updated_at FROM contacts ORDER BY id")
        .all() as Array<{ id: string; updated_at: string }>;

      await runV63();

      const after = harness.db
        .prepare("SELECT id, updated_at FROM contacts ORDER BY id")
        .all() as typeof before;

      expect(after).toEqual(before);
      // ...and the seeded value really is the one being compared, so this cannot
      // pass by both sides being equally wrong.
      expect(new Set(after.map((r) => r.updated_at))).toEqual(new Set([SEEDED_UPDATED_AT]));
    });

    it("changes no other contact field — display_name, company, title, removed_at all hold", async () => {
      const before = harness.db
        .prepare(
          "SELECT id, user_id, display_name, company, title, source, removed_at FROM contacts ORDER BY id",
        )
        .all();

      await runV63();

      expect(
        harness.db
          .prepare(
            "SELECT id, user_id, display_name, company, title, source, removed_at FROM contacts ORDER BY id",
          )
          .all(),
      ).toEqual(before);
    });

    it("is re-runnable: a second pass adds no person and repoints no contact", async () => {
      await runV63();
      const personsAfterFirst = (
        harness.db.prepare("SELECT id FROM persons ORDER BY id").all() as Array<{ id: string }>
      ).map((r) => r.id);
      const linksAfterFirst = harness.db
        .prepare("SELECT id, person_id FROM contacts ORDER BY id")
        .all();

      // Re-run the migration body directly against the same database.
      const klass = harness.service.constructor as {
        MIGRATIONS: Array<{ version: number; migrate: (d: DatabaseType) => void }>;
      };
      const v63 = klass.MIGRATIONS.find((m) => m.version === 63);
      expect(v63).toBeDefined();
      v63?.migrate(harness.db);

      expect(
        (
          harness.db.prepare("SELECT id FROM persons ORDER BY id").all() as Array<{ id: string }>
        ).map((r) => r.id),
      ).toEqual(personsAfterFirst);
      expect(harness.db.prepare("SELECT id, person_id FROM contacts ORDER BY id").all()).toEqual(
        linksAfterFirst,
      );
    });
  });

  // =========================================================================
  describe("lifecycle — the founder's retain-on-delete decision, in the schema", () => {
    /**
     * *"We need to retain the person with its details even if the linked contact
     * is deleted."* — founder, 12 Aug, `pm_comments` on BACKLOG-2609.
     *
     * The guarantee is structural: the foreign key lives on `contacts.person_id`
     * pointing AT `persons`, so a contact delete cannot reach a person row. This
     * asserts it against a REAL delete with foreign keys ON — the state a real
     * connection runs in, and NOT the state the migration loop runs in
     * (the runner turns FKs off for the duration).
     */
    it("deleting a contact leaves its person row standing", async () => {
      await runV63();
      harness.db.pragma("foreign_keys = ON");

      const personId = personIdOf("c-alpha");
      expect(personId).not.toBeNull();

      harness.db.prepare("DELETE FROM contacts WHERE id = ?").run("c-alpha");

      expect(
        harness.db.prepare("SELECT id FROM persons WHERE id = ?").get(personId as string),
      ).toEqual({ id: personId });
    });

    /**
     * The other direction, which CAN fire: deleting a person un-merges its
     * contacts rather than taking them with it. If this ever became
     * ON DELETE CASCADE, deleting a person would delete the user's contacts.
     */
    it("deleting a person NULLs the contact's person_id and keeps the contact", async () => {
      await runV63();
      harness.db.pragma("foreign_keys = ON");

      const personId = personIdOf("c-beta");
      harness.db.prepare("DELETE FROM persons WHERE id = ?").run(personId as string);

      expect(harness.db.prepare("SELECT id FROM contacts WHERE id = ?").get("c-beta")).toEqual({
        id: "c-beta",
      });
      expect(personIdOf("c-beta")).toBeNull();
    });

    /**
     * Restore rejoins the SAME person. Contacts are tombstoned, not deleted, so
     * clearing `removed_at` must land the contact back on the person id it had —
     * which is only true because the backfill covered tombstoned rows.
     */
    it("a tombstoned contact keeps its person across a delete/restore round trip", async () => {
      await runV63();

      const before = personIdOf(REMOVED_CONTACT_ID);
      expect(before).not.toBeNull();

      harness.db
        .prepare("UPDATE contacts SET removed_at = NULL, removed_reason = NULL WHERE id = ?")
        .run(REMOVED_CONTACT_ID);

      expect(personIdOf(REMOVED_CONTACT_ID)).toBe(before);
    });
  });

  // =========================================================================
  describe("guards", () => {
    it("no-ops on a database with no contacts table (partial fixture)", async () => {
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
        bare.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 62)").run();

        const klass = bare.service.constructor as { MIGRATIONS: Array<{ version: number }> };
        const all = klass.MIGRATIONS;
        klass.MIGRATIONS = all.filter((m) => m.version <= 63);
        try {
          await expect(bare.service._runVersionedMigrations()).resolves.not.toThrow();
        } finally {
          klass.MIGRATIONS = all;
        }

        expect(tableExists(bare.db, "persons")).toBe(false);
      } finally {
        await bare.cleanup();
      }
    });

    it("survives a contacts table that has no rows", async () => {
      harness.db.prepare("DELETE FROM contacts").run();
      await runV63();

      expect(tableExists(harness.db, "persons")).toBe(true);
      expect(harness.db.prepare("SELECT id FROM persons").all()).toEqual([]);
      expect(columns(harness.db, "contacts")).toContain("person_id");
    });
  });
});
