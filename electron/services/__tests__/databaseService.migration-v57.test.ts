/**
 * @jest-environment node
 *
 * Integration test for migration v57 (BACKLOG-2401 — contact source crosswalk).
 *
 * v57 creates `contact_source_links`, the many-to-many bridge from a saved
 * contact to the external source records it came from, and adds
 * `external_contacts.external_uuid` so the macOS ZEXTERNALUUID has somewhere to
 * live between a sync and a link.
 *
 * Properties this file locks in:
 *
 *  1. IDENTITY IS THE PAIR. UNIQUE(user_id, source_type, source_record_id) is
 *     asserted by INSERTing a colliding row and requiring a throw — not by
 *     reading the DDL back, which proves only that the text was written.
 *  2. THE VOCABULARY IS CONSTRAINED. `source_type` reuses ExternalContactSource
 *     and is NOT `contacts.source` (where macOS is 'contacts_app'); conflating
 *     them is the mistake the CHECK exists to catch. `match_method` likewise.
 *  3. A LINK IS NOT A CONTACT. Deleting a link leaves the contact; deleting a
 *     contact cascades its links away. The first is the reversibility guarantee
 *     a wrong auto-match will need (BACKLOG-2273).
 *  4. NO BACKFILL RUNS. Founder decision 2026-08-02: existing contacts are
 *     linked opportunistically during normal sync, not by a one-time migration.
 *     A migration that "helpfully" linked rows would be a silent scope breach,
 *     so zero-rows-after-upgrade is asserted rather than assumed.
 *  5. EXACTLY ONE NEW INDEX. The index-name set is snapshotted before and after
 *     and the delta asserted by name, so an extra index cannot appear unnoticed
 *     on two hot tables (the v56 ruling, applied to v57's own table).
 *  6. schema.sql DECLARES NEITHER. Like v56, this migration is the single source
 *     on both install paths. The last describe turns that into an enforced
 *     invariant instead of a comment somebody has to read.
 *
 * Follows the v47..v56 convention: real better-sqlite3 driver via the
 * node_modules require() bypass, in-memory DB via createMigrationHarness, seeded
 * at 56 AND clipped to 57 so ONLY v57 runs. The real two-step runMigrations()
 * flow over a real FILE is covered by databaseService.onDiskUpgrade.test.ts.
 */

import fs from "fs";
import path from "path";
import { jest } from "@jest/globals";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — identical pattern to databaseService.migration-v56.test.ts
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const USER_ID = "user-v57-test";
const CONTACT_IDS = ["c-v57-alpha", "c-v57-beta"];

/**
 * Post-v56 / pre-v57 shape. `external_contacts` is present WITHOUT
 * external_uuid (v57 adds it) and the two indexes make the index-delta
 * assertion a real comparison rather than empty-set == empty-set.
 */
const PRE_V57_FIXTURE = `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);

  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    removed_at DATETIME,
    removed_reason TEXT,
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
    UNIQUE(user_id, source, external_record_id)
  );

  CREATE INDEX idx_contacts_user_id ON contacts(user_id);
  CREATE INDEX idx_external_contacts_user ON external_contacts(user_id);

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

function tableExists(db: DatabaseType, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) !==
    undefined
  );
}

describe("databaseService migration v57 (BACKLOG-2401 — contact_source_links)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(PRE_V57_FIXTURE);
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
    for (const id of CONTACT_IDS) {
      harness.db
        .prepare("INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)")
        .run(id, USER_ID, `Name ${id}`);
    }
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
   * Seed at v56 AND clip the chain at v57 so ONLY v57 runs. Clipping (rather
   * than relying on 56 being head-minus-one) keeps every assertion in this file
   * a statement about v57 when v59 lands.
   */
  async function runV57(): Promise<void> {
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 56)").run();
    const klass = harness.service.constructor as { MIGRATIONS: Array<{ version: number }> };
    const all = klass.MIGRATIONS;
    klass.MIGRATIONS = all.filter((m) => m.version <= 57);
    try {
      await harness.service._runVersionedMigrations();
    } finally {
      klass.MIGRATIONS = all;
    }
  }

  function insertLink(
    db: DatabaseType,
    id: string,
    contactId: string,
    sourceType: string,
    recordId: string,
    matchMethod = "source_id",
    confidence: number | null = null,
  ): void {
    db.prepare(
      `INSERT INTO contact_source_links
         (id, user_id, contact_id, source_type, source_record_id, match_method, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, USER_ID, contactId, sourceType, recordId, matchMethod, confidence);
  }

  it("sanity: real better-sqlite3 driver is wired (not the jest auto-mock)", () => {
    expect(typeof RealDatabase).toBe("function");
  });

  it("precondition: the crosswalk does not exist and external_contacts has no external_uuid", () => {
    expect(tableExists(harness.db, "contact_source_links")).toBe(false);
    expect(columns(harness.db, "external_contacts")).not.toContain("external_uuid");
  });

  it("creates contact_source_links with the exact column set, advancing to v57", async () => {
    await runV57();

    expect(tableExists(harness.db, "contact_source_links")).toBe(true);
    expect(columns(harness.db, "contact_source_links")).toEqual([
      "id",
      "user_id",
      "contact_id",
      "source_type",
      "source_record_id",
      "external_uuid",
      "match_method",
      "confidence",
      "matched_at",
      "evidence_ref",
      "created_at",
      "updated_at",
    ]);
    expect(schemaVersion(harness.db)).toBe(57);
  });

  it("adds external_uuid to external_contacts, appended last", async () => {
    await runV57();

    const cols = columns(harness.db, "external_contacts");
    expect(cols).toContain("external_uuid");
    expect(cols.slice(-1)).toEqual(["external_uuid"]);
  });

  it("creates EXACTLY ONE named index — the delta is asserted by name", async () => {
    const before = indexNames(harness.db);
    expect(before).toContain("idx_contacts_user_id");
    expect(before).toContain("idx_external_contacts_user");

    await runV57();

    const after = indexNames(harness.db);
    const added = after.filter((n) => !before.includes(n));
    // Exactly three, and each is accounted for:
    //   idx_contact_source_links_contact  — the ONE deliberate index: contact ->
    //     its source records, the already-imported filter's access path, which
    //     has no other route. (source record -> contact is served by the UNIQUE
    //     auto-index below, so it is deliberately NOT declared again.)
    //   sqlite_autoindex_..._1 — SQLite's own index for `id TEXT PRIMARY KEY`.
    //   sqlite_autoindex_..._2 — SQLite's own index for the UNIQUE constraint.
    // Naming all three means a future extra index cannot slip in unnoticed.
    expect(added).toEqual([
      "idx_contact_source_links_contact",
      "sqlite_autoindex_contact_source_links_1",
      "sqlite_autoindex_contact_source_links_2",
    ]);
    // Nothing was dropped.
    expect(after.filter((n) => before.includes(n))).toEqual(before);
  });

  it("ENFORCES identity as the PAIR: one source record cannot be claimed twice", async () => {
    await runV57();
    insertLink(harness.db, "l-1", CONTACT_IDS[0], "macos", "UUID-A:ABPerson");

    // Same (user, source, record) for a DIFFERENT contact -> rejected.
    expect(() =>
      insertLink(harness.db, "l-2", CONTACT_IDS[1], "macos", "UUID-A:ABPerson"),
    ).toThrow(/UNIQUE/i);

    // ...but the SAME record id under a DIFFERENT source is a different identity
    // and is allowed: id spaces do not overlap across sources.
    expect(() =>
      insertLink(harness.db, "l-3", CONTACT_IDS[1], "outlook", "UUID-A:ABPerson"),
    ).not.toThrow();

    const rows = (
      harness.db
        .prepare("SELECT id, contact_id, source_type FROM contact_source_links ORDER BY id")
        .all() as Array<{ id: string; contact_id: string; source_type: string }>
    ).map((r) => `${r.id}:${r.source_type}:${r.contact_id}`);
    expect(rows).toEqual([`l-1:macos:${CONTACT_IDS[0]}`, `l-3:outlook:${CONTACT_IDS[1]}`]);
  });

  it("CONSTRAINS the vocabulary: source_type is ExternalContactSource, not contacts.source", async () => {
    await runV57();

    for (const valid of ["macos", "iphone", "outlook", "google_contacts", "android_sync"]) {
      expect(() =>
        insertLink(harness.db, `ok-${valid}`, CONTACT_IDS[0], valid, `rec-${valid}`),
      ).not.toThrow();
    }

    // 'contacts_app' is the DISPLAY-facing value for macOS on contacts.source.
    // Accepting it here is precisely the conflation this CHECK prevents.
    expect(() =>
      insertLink(harness.db, "bad-1", CONTACT_IDS[0], "contacts_app", "rec-x"),
    ).toThrow(/CHECK/i);
    expect(() => insertLink(harness.db, "bad-2", CONTACT_IDS[0], "manual", "rec-y")).toThrow(
      /CHECK/i,
    );
  });

  it("CONSTRAINS match_method, and admits 'scored' with a confidence for BACKLOG-2273", async () => {
    await runV57();

    for (const m of ["source_id", "email", "phone", "manual"]) {
      expect(() =>
        insertLink(harness.db, `m-${m}`, CONTACT_IDS[0], "macos", `rec-${m}`, m),
      ).not.toThrow();
    }
    expect(() =>
      insertLink(harness.db, "m-scored", CONTACT_IDS[0], "macos", "rec-scored", "scored", 0.72),
    ).not.toThrow();
    expect(() =>
      insertLink(harness.db, "m-bad", CONTACT_IDS[0], "macos", "rec-bad", "vibes"),
    ).toThrow(/CHECK/i);

    // Deterministic links carry NULL confidence; only the scored one has a value.
    const rows = (
      harness.db
        .prepare(
          "SELECT match_method, confidence FROM contact_source_links ORDER BY match_method",
        )
        .all() as Array<{ match_method: string; confidence: number | null }>
    ).map((r) => `${r.match_method}=${r.confidence}`);
    expect(rows).toEqual([
      "email=null".replace("null", String(null)),
      `manual=${null}`,
      `phone=${null}`,
      "scored=0.72",
      `source_id=${null}`,
    ]);
  });

  it("A LINK IS NOT A CONTACT: deleting a link leaves the contact and its other links", async () => {
    await runV57();
    insertLink(harness.db, "l-1", CONTACT_IDS[0], "macos", "UUID-A:ABPerson");
    insertLink(harness.db, "l-2", CONTACT_IDS[0], "outlook", "AAMkAG1");

    harness.db.prepare("DELETE FROM contact_source_links WHERE id = ?").run("l-1");

    expect(
      (
        harness.db
          .prepare("SELECT id FROM contact_source_links ORDER BY id")
          .all() as Array<{ id: string }>
      ).map((r) => r.id),
    ).toEqual(["l-2"]);
    expect(
      (harness.db.prepare("SELECT id FROM contacts ORDER BY id").all() as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    ).toEqual([...CONTACT_IDS].sort());
  });

  it("deleting a CONTACT cascades its links away (no dangling crosswalk rows)", async () => {
    await runV57();
    harness.db.pragma("foreign_keys = ON");
    insertLink(harness.db, "l-1", CONTACT_IDS[0], "macos", "UUID-A:ABPerson");
    insertLink(harness.db, "l-2", CONTACT_IDS[1], "macos", "UUID-B:ABPerson");

    harness.db.prepare("DELETE FROM contacts WHERE id = ?").run(CONTACT_IDS[0]);

    expect(
      (
        harness.db
          .prepare("SELECT id, contact_id FROM contact_source_links ORDER BY id")
          .all() as Array<{ id: string; contact_id: string }>
      ).map((r) => `${r.id}:${r.contact_id}`),
    ).toEqual([`l-2:${CONTACT_IDS[1]}`]);
  });

  it("RUNS NO BACKFILL — zero links exist after the upgrade, by exact id set", async () => {
    // Deliberately give the fixture data a naive migration might have "helpfully"
    // matched: a shadow record whose name equals a contact's display name.
    harness.db
      .prepare(
        `INSERT INTO external_contacts (id, user_id, name, emails_json, external_record_id, source)
         VALUES (?, ?, ?, ?, ?, 'macos')`,
      )
      .run("ext-1", USER_ID, `Name ${CONTACT_IDS[0]}`, "[]", "UUID-A:ABPerson");

    await runV57();

    expect(
      (
        harness.db.prepare("SELECT id FROM contact_source_links").all() as Array<{ id: string }>
      ).map((r) => r.id),
    ).toEqual([]);
    // ...and every pre-existing contact survives untouched.
    expect(
      (harness.db.prepare("SELECT id FROM contacts ORDER BY id").all() as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    ).toEqual([...CONTACT_IDS].sort());
  });

  it("is idempotent: a second run does not throw, duplicate the table, or change the shape", async () => {
    await runV57();
    const shape = {
      links: columns(harness.db, "contact_source_links"),
      external: columns(harness.db, "external_contacts"),
      indexes: indexNames(harness.db),
    };
    insertLink(harness.db, "l-keep", CONTACT_IDS[0], "macos", "UUID-A:ABPerson");

    await expect(runV57()).resolves.toBeUndefined();

    expect(columns(harness.db, "contact_source_links")).toEqual(shape.links);
    expect(columns(harness.db, "external_contacts")).toEqual(shape.external);
    expect(indexNames(harness.db)).toEqual(shape.indexes);
    // The re-run did not wipe existing rows.
    expect(
      (
        harness.db.prepare("SELECT id FROM contact_source_links").all() as Array<{ id: string }>
      ).map((r) => r.id),
    ).toEqual(["l-keep"]);
  });
});

describe("databaseService migration v57 — partial-schema DB (table guards)", () => {
  let partial: MigrationHarness;

  afterEach(async () => {
    if (partial) {
      try {
        await partial.cleanup();
      } catch {
        /* already cleaned */
      }
    }
  });

  it("skips entirely when `contacts` is absent — the FK parent must exist first", async () => {
    partial = createMigrationHarness({ seedV29Schema: false });
    partial.db.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        migrated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    partial.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 56)").run();

    await expect(partial.service._runVersionedMigrations()).resolves.toBeUndefined();

    expect(tableExists(partial.db, "contact_source_links")).toBe(false);
  });

  it("creates the crosswalk when `external_contacts` is absent, and skips only that ALTER", async () => {
    partial = createMigrationHarness({ seedV29Schema: false });
    partial.db.exec(`
      CREATE TABLE contacts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, display_name TEXT);
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        migrated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    partial.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 56)").run();

    await expect(partial.service._runVersionedMigrations()).resolves.toBeUndefined();

    expect(tableExists(partial.db, "contact_source_links")).toBe(true);
    expect(tableExists(partial.db, "external_contacts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The "single source on both install paths" invariant (mirrors v56's test)
// ---------------------------------------------------------------------------

const SCHEMA_SQL_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");

describe("schema.sql declares NEITHER the crosswalk nor external_uuid (BACKLOG-2401)", () => {
  it("does not create contact_source_links — migration v57 is its only source", () => {
    // Both install paths exec schema.sql and THEN run the chain, so declaring the
    // table in only one place is what makes fresh and upgraded installs converge
    // without a schema-parity KNOWN_DRIFT pin. Declaring it in BOTH is harmless
    // for a CREATE TABLE IF NOT EXISTS but would tempt a follow-up to add a
    // top-level CREATE INDEX beside it — and schema.sql is exec'd BEFORE the
    // chain, so an index on a not-yet-created table throws on every real
    // upgrade. That is the BACKLOG-2298/2300 failure class.
    const schemaSql = fs.readFileSync(SCHEMA_SQL_PATH, "utf8");
    expect(schemaSql).not.toMatch(/contact_source_links/);
  });

  it("does not declare external_contacts.external_uuid — migration v57 adds it", () => {
    const schemaSql = fs.readFileSync(SCHEMA_SQL_PATH, "utf8");
    expect(schemaSql).not.toMatch(/external_uuid/);
  });
});
