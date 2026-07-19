/**
 * @jest-environment node
 *
 * Integration test for migration v49 (BACKLOG-1900 P0.4 — conservative
 * contact-source backfill).
 *
 * v49 reclassifies EXISTING `contacts` rows that are stuck at source='contacts_app'
 * (the pre-P0.2 collapse bucket) into the distinct per-origin values
 * ('iphone','android_sync','outlook','google_contacts') — but ONLY where the origin
 * is safely determinable from the `external_contacts` shadow table by an unambiguous
 * single-provider identity match (user_id + display_name == external_contacts.name).
 *
 * LOCKED conservative rule: never guess iPhone-vs-Gmail. When an identity resolves to
 * more than one distinct provider (or to no distinct provider), the existing value is
 * left UNCHANGED. A missed reclassification is acceptable; a wrong one is not.
 *
 * This test exercises the MIGRATED path (fixture seeded at schema_version=48 so ONLY
 * v49 runs) plus a fresh-install no-op guard. Follows the migration-v40..v48
 * convention: real better-sqlite3 driver via the node_modules require() bypass,
 * in-memory DB via createMigrationHarness.
 */

import path from "path";
import fs from "fs";
import { jest } from "@jest/globals";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — identical pattern to databaseService.migration-v48.test.ts
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

// The exact file the app reads on a fresh install.
const SCHEMA_SQL_PATH = path.join(__dirname, "..", "..", "database", "schema.sql");

function readSchemaSql(): string {
  return fs.readFileSync(SCHEMA_SQL_PATH, "utf8");
}

// ---------------------------------------------------------------------------
// FIXTURES / HELPERS
// ---------------------------------------------------------------------------

const USER_ID = "user-v49-test";
// A second user, to prove the backfill is user-scoped (an external row belonging
// to another user must NOT reclassify this user's contact).
const OTHER_USER_ID = "user-v49-other";

/**
 * Post-v48 shape: the widened source CHECK (all 9 values) + the external_contacts
 * shadow table (the backfill's only provenance signal) + the two child tables the
 * data-safety assertion needs. schema_version starts at 48 so ONLY v49 runs.
 */
const PRE_V49_FIXTURE = `
  CREATE TABLE users_local (id TEXT PRIMARY KEY);

  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    company TEXT,
    title TEXT,
    source TEXT DEFAULT 'manual' CHECK (source IN ('manual', 'email', 'sms', 'contacts_app', 'inferred', 'android_sync', 'iphone', 'outlook', 'google_contacts')),
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
    FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE,
    UNIQUE(user_id, source, external_record_id)
  );

  CREATE INDEX idx_contacts_user_id ON contacts(user_id);
  CREATE INDEX idx_contacts_display_name ON contacts(display_name);
  CREATE INDEX idx_contacts_is_imported ON contacts(is_imported);
  CREATE INDEX idx_contacts_user_imported ON contacts(user_id, is_imported);

  CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migrated_at TEXT DEFAULT (datetime('now'))
  );
`;

let contactCounter = 0;
/** Insert a contact and return its id. */
function insertContact(
  db: DatabaseType,
  opts: { userId?: string; name: string; source: string; isImported?: number },
): string {
  contactCounter += 1;
  const id = `contact-${contactCounter}`;
  db.prepare(
    "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, ?, ?)",
  ).run(id, opts.userId ?? USER_ID, opts.name, opts.source, opts.isImported ?? 1);
  return id;
}

let externalCounter = 0;
/** Insert an external_contacts shadow row. */
function insertExternal(
  db: DatabaseType,
  opts: { userId?: string; name: string | null; source: string | null },
): void {
  externalCounter += 1;
  db.prepare(
    "INSERT INTO external_contacts (id, user_id, name, source, external_record_id) VALUES (?, ?, ?, ?, ?)",
  ).run(
    `ext-${externalCounter}`,
    opts.userId ?? USER_ID,
    opts.name,
    opts.source,
    `rec-${externalCounter}`,
  );
}

function sourceOf(db: DatabaseType, contactId: string): string | undefined {
  const row = db
    .prepare("SELECT source FROM contacts WHERE id = ?")
    .get(contactId) as { source: string } | undefined;
  return row?.source;
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe("databaseService migration v49 (BACKLOG-1900 P0.4 — contact-source backfill)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    harness.db.exec(PRE_V49_FIXTURE);
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(OTHER_USER_ID);
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

  async function runV49(): Promise<void> {
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 48)").run();
    await harness.service._runVersionedMigrations();
  }

  it("sanity: real better-sqlite3 driver is wired (not the jest auto-mock)", () => {
    expect(typeof RealDatabase).toBe("function");
    expect(Array.isArray(harness.db.pragma("user_version"))).toBe(true);
  });

  it("advances schema_version to the latest migration (v51 after BACKLOG-2013)", async () => {
    const migrations = harness.service.constructor.MIGRATIONS as Array<{ version: number }>;
    const latest = migrations[migrations.length - 1].version;
    // BACKLOG-2006a added v50 (transaction_unlocks_cache); BACKLOG-2013 added
    // v51 (transactions.first_exported_at freeze marker) — now the latest.
    expect(latest).toBe(51);

    // runV49 seeds at 48 then runs ALL pending migrations, so v49 + v50 + v51 run.
    await runV49();

    const row = harness.db
      .prepare("SELECT version FROM schema_version WHERE id = 1")
      .get() as { version: number };
    expect(row.version).toBe(51);
  });

  // -------------------------------------------------------------------------
  // SAFE reclassification — single unambiguous provider.
  // -------------------------------------------------------------------------

  describe("safe single-provider reclassification", () => {
    it.each([
      ["iphone", "iphone"],
      ["android_sync", "android_sync"],
      ["outlook", "outlook"],
      ["google_contacts", "google_contacts"],
    ])(
      "reclassifies a contacts_app contact to '%s' when the sole external match is '%s'",
      async (externalSource, expected) => {
        const id = insertContact(harness.db, { name: "Alice Example", source: "contacts_app" });
        insertExternal(harness.db, { name: "Alice Example", source: externalSource });

        await runV49();

        expect(sourceOf(harness.db, id)).toBe(expected);
      },
    );

    it("matches case-sensitively — mirrors the app's own contacts<->external join", async () => {
      // A case-mismatched external name is a DIFFERENT identity to the app, so the
      // contact must be left unchanged (conservative: never broaden matching).
      const id = insertContact(harness.db, { name: "Bob Jones", source: "contacts_app" });
      insertExternal(harness.db, { name: "bob jones", source: "iphone" });

      await runV49();

      expect(sourceOf(harness.db, id)).toBe("contacts_app");
    });

    it("is user-scoped — another user's external row does not reclassify this contact", async () => {
      const id = insertContact(harness.db, { name: "Carol King", source: "contacts_app" });
      insertExternal(harness.db, {
        userId: OTHER_USER_ID,
        name: "Carol King",
        source: "iphone",
      });

      await runV49();

      expect(sourceOf(harness.db, id)).toBe("contacts_app");
    });
  });

  // -------------------------------------------------------------------------
  // AMBIGUOUS / no-signal cases — must be LEFT UNCHANGED (locked rule).
  // -------------------------------------------------------------------------

  describe("conservative: leaves rows unchanged when origin is not safely determinable", () => {
    it("leaves a contact unchanged when two distinct providers share the display name", async () => {
      // The exact locked-rule case: never guess iPhone-vs-Gmail.
      const id = insertContact(harness.db, { name: "Dana Smith", source: "contacts_app" });
      insertExternal(harness.db, { name: "Dana Smith", source: "iphone" });
      insertExternal(harness.db, { name: "Dana Smith", source: "google_contacts" });

      await runV49();

      expect(sourceOf(harness.db, id)).toBe("contacts_app");
    });

    it("leaves a contact as contacts_app when the only match is a macOS address-book row", async () => {
      // 'macos' maps back to 'contacts_app' (== current) — no distinct origin, no change.
      const id = insertContact(harness.db, { name: "Evan Poe", source: "contacts_app" });
      insertExternal(harness.db, { name: "Evan Poe", source: "macos" });

      await runV49();

      expect(sourceOf(harness.db, id)).toBe("contacts_app");
    });

    it("leaves a contact unchanged when it also has a macOS row alongside one iPhone row", async () => {
      // The most common real ambiguity: same person synced from both macOS and iPhone
      // (two external rows, distinct sources). Mapped set {contacts_app, iphone} => size 2.
      const id = insertContact(harness.db, { name: "Fran Kafka", source: "contacts_app" });
      insertExternal(harness.db, { name: "Fran Kafka", source: "macos" });
      insertExternal(harness.db, { name: "Fran Kafka", source: "iphone" });

      await runV49();

      expect(sourceOf(harness.db, id)).toBe("contacts_app");
    });

    it("leaves a contact unchanged when there is no external match at all", async () => {
      const id = insertContact(harness.db, { name: "Greta Green", source: "contacts_app" });

      await runV49();

      expect(sourceOf(harness.db, id)).toBe("contacts_app");
    });

    it("leaves a contact unchanged when the only external match has a NULL source", async () => {
      const id = insertContact(harness.db, { name: "Hank Hill", source: "contacts_app" });
      insertExternal(harness.db, { name: "Hank Hill", source: null });

      await runV49();

      expect(sourceOf(harness.db, id)).toBe("contacts_app");
    });
  });

  // -------------------------------------------------------------------------
  // SCOPE — only imported contacts_app rows are candidates.
  // -------------------------------------------------------------------------

  describe("scope", () => {
    it("does NOT touch a source='email' contact even if it name-collides with an iPhone external row", async () => {
      // Message-derived contact sharing a name with an address-book import must NOT
      // be rewritten — that would be a WRONG reclassification (out of scope).
      const id = insertContact(harness.db, { name: "Iris West", source: "email" });
      insertExternal(harness.db, { name: "Iris West", source: "iphone" });

      await runV49();

      expect(sourceOf(harness.db, id)).toBe("email");
    });

    it.each(["manual", "sms", "inferred", "outlook", "google_contacts", "android_sync", "iphone"])(
      "does NOT touch a contact already at source='%s'",
      async (existingSource) => {
        const id = insertContact(harness.db, { name: "Jax Teller", source: existingSource });
        // An external iphone row that would otherwise reclassify — but the contact
        // is not in the contacts_app bucket, so it is out of scope.
        insertExternal(harness.db, { name: "Jax Teller", source: "iphone" });

        await runV49();

        expect(sourceOf(harness.db, id)).toBe(existingSource);
      },
    );

    it("does NOT touch a manually-created contacts_app contact (is_imported=0)", async () => {
      const id = insertContact(harness.db, {
        name: "Kara Zorel",
        source: "contacts_app",
        isImported: 0,
      });
      insertExternal(harness.db, { name: "Kara Zorel", source: "iphone" });

      await runV49();

      expect(sourceOf(harness.db, id)).toBe("contacts_app");
    });
  });

  // -------------------------------------------------------------------------
  // DATA SAFETY — child rows untouched, idempotent.
  // -------------------------------------------------------------------------

  describe("data safety", () => {
    it("preserves child contact_emails / contact_phones rows through the backfill (no re-parenting)", async () => {
      const id = insertContact(harness.db, { name: "Lena Luthor", source: "contacts_app" });
      insertExternal(harness.db, { name: "Lena Luthor", source: "outlook" });
      harness.db
        .prepare("INSERT INTO contact_emails (id, contact_id, email) VALUES (?, ?, ?)")
        .run("email-1", id, "lena@example.com");
      harness.db
        .prepare("INSERT INTO contact_phones (id, contact_id, phone_e164) VALUES (?, ?, ?)")
        .run("phone-1", id, "+14155550123");

      await runV49();

      // Source reclassified...
      expect(sourceOf(harness.db, id)).toBe("outlook");
      // ...and children still linked to the SAME contact id, unchanged.
      const emails = harness.db
        .prepare("SELECT email FROM contact_emails WHERE contact_id = ?")
        .all(id) as Array<{ email: string }>;
      const phones = harness.db
        .prepare("SELECT phone_e164 FROM contact_phones WHERE contact_id = ?")
        .all(id) as Array<{ phone_e164: string }>;
      expect(emails).toEqual([{ email: "lena@example.com" }]);
      expect(phones).toEqual([{ phone_e164: "+14155550123" }]);
    });

    it("is idempotent — re-running the runner does not re-touch reclassified rows or error", async () => {
      const reclassified = insertContact(harness.db, {
        name: "Mona Vale",
        source: "contacts_app",
      });
      insertExternal(harness.db, { name: "Mona Vale", source: "iphone" });
      const leftAlone = insertContact(harness.db, {
        name: "Nate Archibald",
        source: "contacts_app",
      });
      insertExternal(harness.db, { name: "Nate Archibald", source: "iphone" });
      insertExternal(harness.db, { name: "Nate Archibald", source: "outlook" });

      await runV49();
      expect(sourceOf(harness.db, reclassified)).toBe("iphone");
      expect(sourceOf(harness.db, leftAlone)).toBe("contacts_app");

      // Second run: version is already at the latest (v51), so the runner selects
      // no pending migrations and no-ops. Values are unchanged either way.
      await expect(harness.service._runVersionedMigrations()).resolves.toBeUndefined();
      expect(sourceOf(harness.db, reclassified)).toBe("iphone");
      expect(sourceOf(harness.db, leftAlone)).toBe("contacts_app");
      const row = harness.db
        .prepare("SELECT version FROM schema_version WHERE id = 1")
        .get() as { version: number };
      expect(row.version).toBe(51);
    });

    it("re-invoking the v49 migrate() body directly on already-reclassified data is a no-op", async () => {
      // Guards the body itself (independent of the runner's version gate): once a row
      // has left the contacts_app bucket, the candidate scan cannot select it again.
      const id = insertContact(harness.db, { name: "Owen Grady", source: "contacts_app" });
      insertExternal(harness.db, { name: "Owen Grady", source: "google_contacts" });

      const migrations = harness.service.constructor.MIGRATIONS as Array<{
        version: number;
        migrate: (d: DatabaseType) => void;
      }>;
      const v49 = migrations.find((m) => m.version === 49);
      expect(v49).toBeDefined();

      v49!.migrate(harness.db);
      expect(sourceOf(harness.db, id)).toBe("google_contacts");
      // Second direct invocation — no throw, still google_contacts.
      expect(() => v49!.migrate(harness.db)).not.toThrow();
      expect(sourceOf(harness.db, id)).toBe("google_contacts");
    });
  });

  // -------------------------------------------------------------------------
  // FRESH-INSTALL path — v49 runs but must be a clean no-op on empty data.
  // -------------------------------------------------------------------------

  describe("fresh-install path (real schema.sql, then migrations)", () => {
    it("reaches the latest version (v51) and does not error on an empty install", async () => {
      await harness.cleanup();
      harness = createMigrationHarness({ seedV29Schema: false });
      harness.db.exec(readSchemaSql());
      await expect(harness.service._runVersionedMigrations()).resolves.toBeUndefined();

      const row = harness.db
        .prepare("SELECT version FROM schema_version WHERE id = 1")
        .get() as { version: number };
      expect(row.version).toBe(51);
    });
  });

  // -------------------------------------------------------------------------
  // DEFENSIVE GUARD — missing external_contacts table must not throw.
  // -------------------------------------------------------------------------

  it("skips cleanly (no throw) when the external_contacts table is absent", async () => {
    await harness.cleanup();
    harness = createMigrationHarness({ seedV29Schema: false });
    // Minimal partial schema: contacts + schema_version, but NO external_contacts.
    harness.db.exec(`
      CREATE TABLE users_local (id TEXT PRIMARY KEY);
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        source TEXT DEFAULT 'manual' CHECK (source IN ('manual', 'email', 'sms', 'contacts_app', 'inferred', 'android_sync', 'iphone', 'outlook', 'google_contacts')),
        is_imported INTEGER DEFAULT 1
      );
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        migrated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
    const id = insertContact(harness.db, { name: "Pat Null", source: "contacts_app" });
    harness.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, 48)").run();

    await expect(harness.service._runVersionedMigrations()).resolves.toBeUndefined();
    // The guard returned early — the contact is untouched.
    expect(sourceOf(harness.db, id)).toBe("contacts_app");
  });
});
