/**
 * @jest-environment node
 *
 * Integration test for migration v40 (BACKLOG-1727) — verifies that:
 *   1. The migration runner successfully takes a v39 DB to v40, adding the
 *      `phone_normalized` column on contact_phones, the
 *      `idx_contact_phones_normalized` index, and the `phones_normalized_json`
 *      column on external_contacts — with backfill of all existing rows.
 *   2. After v40 is applied, the PRODUCTION write paths
 *      (createContact, createContactsBatch, upsertFromMacOS, upsertFromiPhone)
 *      populate the new normalized columns end-to-end via the shared helper.
 *
 * Together this closes the gap left by databaseService.migration.test.ts
 * (which uses the Jest auto-mock for better-sqlite3 and therefore exercises
 * runner logic but not real SQL) and phoneNormalizedJoin.test.ts (which uses
 * the real driver but hand-builds INSERTs, not the production write
 * functions).
 *
 * Scope of this file is intentionally narrow: it covers the v40 ALTER + index
 * + backfill path, plus a smoke check on five primary insert call sites.
 * Comprehensive write-path parity (backfillContactPhones, updateContactPhones,
 * setContactPrimaryPhone, the worker-read path) is tracked in BACKLOG-1729.
 *
 * Bypasses the Jest auto-mock for better-sqlite3-multiple-ciphers via the
 * `require(path.join(__dirname, "..", "..", "..", "node_modules", ...))` trick
 * used in phoneNormalizedJoin.test.ts. The harness file does the equivalent
 * one level deeper (helpers/ → depth 4).
 */

import path from "path";
import crypto from "crypto";
import { jest } from "@jest/globals";

// ---------------------------------------------------------------------------
// MOCKS — keep minimal. The harness uses the REAL better-sqlite3 driver, but
// every other Electron-dependent import needs a stub so the module graph
// loads cleanly in a Node Jest environment.
// ---------------------------------------------------------------------------

jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => "/mock/user/data"),
  },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

jest.mock("../logService", () => {
  const mockFns = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return {
    __esModule: true,
    default: mockFns,
    logService: mockFns,
  };
});

// databaseEncryptionService is module-scoped state — mock it so importing
// databaseService does not pull in keychain / OS-keystore code paths.
jest.mock("../databaseEncryptionService", () => ({
  databaseEncryptionService: {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  },
  default: {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  },
}));

// contactsService pulls in node-mac-contacts on macOS — stub it so the
// contactDbService import does not crash on non-mac CI.
jest.mock("../contactsService", () => ({
  getContactNames: jest.fn(() => Promise.resolve([])),
}));

// Worker pool: contactDbService imports queryContacts / isPoolReady. The pool
// only activates if isPoolReady() is true, so returning false keeps writes on
// the synchronous main-thread path that we want to exercise.
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

// ---------------------------------------------------------------------------
// IMPORTS — only after the mocks above are in place.
// ---------------------------------------------------------------------------

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";
import { normalizePhoneLookupKey } from "../../utils/phoneLookupKey";

// Resolve the real better-sqlite3 once to assert the harness wired the same
// driver into the singleton (sanity check — guards against the auto-mock
// silently regaining control after a refactor).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
);

// ---------------------------------------------------------------------------
// SHARED FIXTURES
// ---------------------------------------------------------------------------

const USER_ID = "user-v40-test";

const TEST_PHONES = {
  usFormatted: {
    raw: "+1 (415) 555-1234",
    e164: "+14155551234",
    normalized: "4155551234",
  },
  ukFormatted: {
    // After normalizeToE164 (which strips non-digits then prefixes +) this becomes
    // +442079460958. normalizePhoneLookupKey then takes the last 10 digits → 2079460958.
    raw: "+44 20 7946 0958",
    normalized: "2079460958",
  },
  shortCode: {
    raw: "12345",
    normalized: "12345",
  },
} as const;

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function seedV29Row(
  harness: MigrationHarness,
  table: "contact_phones",
  row: { contact_id: string; phone_e164: string },
): string {
  const id = crypto.randomUUID();
  harness.db
    .prepare(
      `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display, is_primary, source)
       VALUES (?, ?, ?, ?, 1, 'import')`,
    )
    .run(id, row.contact_id, row.phone_e164, row.phone_e164);
  return id;
}

function seedV29Contact(
  harness: MigrationHarness,
  userId: string,
  displayName: string,
): string {
  const contactId = crypto.randomUUID();
  harness.db
    .prepare(
      `INSERT INTO contacts (id, user_id, display_name, is_imported)
       VALUES (?, ?, ?, 1)`,
    )
    .run(contactId, userId, displayName);
  return contactId;
}

function seedV29ExternalContact(
  harness: MigrationHarness,
  userId: string,
  name: string,
  phones: string[],
  source = "macos",
): string {
  const id = crypto.randomUUID();
  harness.db
    .prepare(
      `INSERT INTO external_contacts (id, user_id, name, phones_json, emails_json, external_record_id, source, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      id,
      userId,
      name,
      JSON.stringify(phones),
      JSON.stringify([]),
      "rec-" + id,
      source,
    );
  return id;
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

describe("databaseService migration v40 (BACKLOG-1727)", () => {
  let harness: MigrationHarness;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: true });
    harness.seedSchemaVersion(39);

    // Every test inserts the user_id used by seeded rows.
    harness.db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  // -------------------------------------------------------------------------
  // Block 1: runner behaviour — ALTER, INDEX, backfill, version, idempotency
  // -------------------------------------------------------------------------

  describe("runner behaviour", () => {
    it("sanity: harness wired the real better-sqlite3 driver, not the auto-mock", () => {
      // The mock at tests/__mocks__/better-sqlite3-multiple-ciphers.js does
      // NOT support db.pragma('user_version') returning a real list. The
      // real driver does. This is a cheap probe that catches a regression
      // where the require(path.join(...)) bypass stops working.
      const result = harness.db.pragma("user_version");
      expect(Array.isArray(result)).toBe(true);
    });

    it("adds contact_phones.phone_normalized column", async () => {
      // Pre-condition: column does NOT exist at v39.
      const colsBefore = harness.db
        .prepare("PRAGMA table_info(contact_phones)")
        .all() as Array<{ name: string }>;
      expect(colsBefore.some((c) => c.name === "phone_normalized")).toBe(false);

      await harness.service._runVersionedMigrations();

      const colsAfter = harness.db
        .prepare("PRAGMA table_info(contact_phones)")
        .all() as Array<{ name: string }>;
      expect(colsAfter.some((c) => c.name === "phone_normalized")).toBe(true);
    });

    it("creates idx_contact_phones_normalized index", async () => {
      await harness.service._runVersionedMigrations();

      const idx = harness.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_contact_phones_normalized'",
        )
        .get() as { name: string } | undefined;
      expect(idx?.name).toBe("idx_contact_phones_normalized");
    });

    it("backfills phone_normalized for US-formatted, UK, and short-code phones", async () => {
      const contactId = seedV29Contact(harness, USER_ID, "Backfill Test");

      const usPhoneId = seedV29Row(harness, "contact_phones", {
        contact_id: contactId,
        phone_e164: TEST_PHONES.usFormatted.e164,
      });
      const ukPhoneId = seedV29Row(harness, "contact_phones", {
        contact_id: contactId,
        phone_e164: "+442079460958",
      });
      const shortPhoneId = seedV29Row(harness, "contact_phones", {
        contact_id: contactId,
        phone_e164: TEST_PHONES.shortCode.raw,
      });

      await harness.service._runVersionedMigrations();

      const rows = harness.db
        .prepare(
          "SELECT id, phone_e164, phone_normalized FROM contact_phones WHERE contact_id = ?",
        )
        .all(contactId) as Array<{ id: string; phone_e164: string; phone_normalized: string | null }>;

      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(usPhoneId)?.phone_normalized).toBe(
        TEST_PHONES.usFormatted.normalized,
      );
      expect(byId.get(ukPhoneId)?.phone_normalized).toBe(
        TEST_PHONES.ukFormatted.normalized,
      );
      expect(byId.get(shortPhoneId)?.phone_normalized).toBe(
        TEST_PHONES.shortCode.normalized,
      );
    });

    it("backfills external_contacts.phones_normalized_json as JSON arrays", async () => {
      const extId = seedV29ExternalContact(harness, USER_ID, "Ext Backfill", [
        TEST_PHONES.usFormatted.raw,
        "+442079460958",
      ]);

      await harness.service._runVersionedMigrations();

      const row = harness.db
        .prepare(
          "SELECT phones_normalized_json FROM external_contacts WHERE id = ?",
        )
        .get(extId) as { phones_normalized_json: string };
      expect(row.phones_normalized_json).toBeTruthy();

      const parsed = JSON.parse(row.phones_normalized_json) as string[];
      expect(parsed).toEqual([
        TEST_PHONES.usFormatted.normalized,
        TEST_PHONES.ukFormatted.normalized,
      ]);
    });

    it("advances schema_version.version to 40", async () => {
      await harness.service._runVersionedMigrations();

      const row = harness.db
        .prepare("SELECT version FROM schema_version WHERE id = 1")
        .get() as { version: number };
      expect(row.version).toBe(40);
    });

    it("is idempotent — running the runner twice keeps version at 40 and does not error", async () => {
      await harness.service._runVersionedMigrations();
      // Second invocation: nothing pending; runner short-circuits without
      // throwing. Verifies the migration is safe to re-apply (matters because
      // app startup runs migrations on every launch).
      await expect(
        harness.service._runVersionedMigrations(),
      ).resolves.toBeUndefined();

      const row = harness.db
        .prepare("SELECT version FROM schema_version WHERE id = 1")
        .get() as { version: number };
      expect(row.version).toBe(40);
    });
  });

  // -------------------------------------------------------------------------
  // Block 2: post-migration insert smoke — production write paths populate
  // phone_normalized / phones_normalized_json end-to-end.
  // -------------------------------------------------------------------------

  describe("post-migration insert smoke", () => {
    beforeEach(async () => {
      // Bring the DB to v40 BEFORE every insert test.
      await harness.service._runVersionedMigrations();
    });

    it.each([
      ["US-formatted", TEST_PHONES.usFormatted.raw, TEST_PHONES.usFormatted.normalized],
      ["UK international", TEST_PHONES.ukFormatted.raw, TEST_PHONES.ukFormatted.normalized],
    ])(
      "createContact populates phone_normalized for %s phones",
      async (_label, rawPhone, expectedNormalized) => {
        // Re-require so the createContact import resolves AFTER our mocks
        // and after the harness has wired up the in-memory DB.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { createContact } = require("../db/contactDbService");

        const created = await createContact({
          user_id: USER_ID,
          display_name: `Alice ${_label}`,
          phone: rawPhone,
          is_imported: true,
        });

        const stored = harness.db
          .prepare(
            "SELECT phone_e164, phone_normalized FROM contact_phones WHERE contact_id = ?",
          )
          .get(created.id) as { phone_e164: string; phone_normalized: string };

        expect(stored.phone_normalized).toBe(expectedNormalized);
      },
    );

    it("createContactsBatch populates phone_normalized", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createContactsBatch } = require("../db/contactDbService");

      const [id] = createContactsBatch([
        {
          user_id: USER_ID,
          display_name: "Batch Alice",
          phone: TEST_PHONES.usFormatted.raw,
          is_imported: true,
        },
      ]);
      expect(id).toBeTruthy();

      const stored = harness.db
        .prepare(
          "SELECT phone_normalized FROM contact_phones WHERE contact_id = ?",
        )
        .get(id) as { phone_normalized: string };
      expect(stored.phone_normalized).toBe(TEST_PHONES.usFormatted.normalized);
    });

    it("upsertFromMacOS populates phones_normalized_json with US + UK phones", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { upsertFromMacOS } = require("../db/externalContactDbService");

      const count = upsertFromMacOS(USER_ID, [
        {
          name: "Mac Alice",
          phones: [TEST_PHONES.usFormatted.raw, "+442079460958"],
          recordId: "mac-rec-1",
        },
      ]);
      expect(count).toBe(1);

      const row = harness.db
        .prepare(
          "SELECT phones_normalized_json FROM external_contacts WHERE user_id = ? AND external_record_id = ?",
        )
        .get(USER_ID, "mac-rec-1") as { phones_normalized_json: string };
      const parsed = JSON.parse(row.phones_normalized_json) as string[];
      expect(parsed).toEqual([
        TEST_PHONES.usFormatted.normalized,
        TEST_PHONES.ukFormatted.normalized,
      ]);
    });

    it("upsertFromiPhone populates phones_normalized_json for short codes", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { upsertFromiPhone } = require("../db/externalContactDbService");

      const count = upsertFromiPhone(USER_ID, [
        {
          name: "iPhone ShortCode",
          phones: [TEST_PHONES.shortCode.raw],
          recordId: "iphone-rec-1",
        },
      ]);
      expect(count).toBe(1);

      const row = harness.db
        .prepare(
          "SELECT phones_normalized_json FROM external_contacts WHERE user_id = ? AND external_record_id = ?",
        )
        .get(USER_ID, "iphone-rec-1") as { phones_normalized_json: string };
      const parsed = JSON.parse(row.phones_normalized_json) as string[];
      expect(parsed).toEqual([TEST_PHONES.shortCode.normalized]);
    });
  });
});

// Module-level sanity: confirm `normalizePhoneLookupKey` and the real driver
// are both reachable from this file's module graph. Cheap guards against
// import regressions.
test("module wiring sanity", () => {
  expect(typeof normalizePhoneLookupKey).toBe("function");
  expect(typeof realDatabase).toBe("function");
});
