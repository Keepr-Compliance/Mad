/**
 * @jest-environment node
 *
 * BACKLOG-1729 write-path integration tests.
 *
 * Verifies that every production INSERT/UPDATE path which persists a phone
 * lookup key uses the canonical `toLookupKey` from the consolidated module.
 * For each function, the test:
 *   1. Calls the production function with a formatted phone input
 *   2. Reads back the persisted row
 *   3. Asserts the stored `phone_normalized` (or array element of
 *      `phones_normalized_json`) === `toLookupKey(input)`
 *
 * Critical invariant: this MUST stay byte-equivalent to what
 * `normalizePhoneLookupKey` produced before the consolidation, because
 * production databases were backfilled by migration v40 using that helper.
 *
 * Strategy: load the real `better-sqlite3-multiple-ciphers` package via
 * an explicit node_modules path (default Jest moduleNameMapper rewrites to
 * a stub) and inject the in-memory database into `dbConnection.setDb()`.
 * Production functions use the injected DB transparently.
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";
import crypto from "crypto";

import { legacyDigitKey, toLookupKey } from "../phoneNormalization";
import { setDb } from "../../services/db/core/dbConnection";
import {
  createContact,
  createContactsBatch,
  backfillContactPhones,
  syncContactPhones,
  setContactPrimaryPhone,
  getContactPhoneEntries,
} from "../../services/db/contactDbService";
import {
  upsertFromMacOS,
  upsertFromiPhone,
  upsertExternalContacts,
} from "../../services/db/externalContactDbService";
import {
  CONTACT_SOURCE_LINKS_TABLE_SQL,
  CONTACT_SOURCE_LINKS_INDEX_SQL,
} from "../../services/db/contactIdentitySchemaSql";

// ---------------------------------------------------------------------------
// Schema — subset sufficient for the write paths under test.
// Matches production columns (post-v40 + post-v41) and the unique constraint
// `external_contacts (user_id, source, external_record_id)` used by the
// upsert ON CONFLICT clauses.
// ---------------------------------------------------------------------------
function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      display_name TEXT,
      company TEXT,
      title TEXT,
      source TEXT,
      is_imported INTEGER DEFAULT 0,
      last_inbound_at DATETIME,
      last_outbound_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE contact_phones (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      phone_e164 TEXT NOT NULL,
      phone_display TEXT,
      phone_normalized TEXT,
      is_primary INTEGER DEFAULT 0,
      source TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_contact_phones_normalized ON contact_phones(phone_normalized);

    CREATE TABLE contact_emails (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      email TEXT NOT NULL,
      is_primary INTEGER DEFAULT 0,
      source TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
      source TEXT,
      synced_at DATETIME,
      sync_session_id TEXT,
      -- BACKLOG-2401: ZEXTERNALUUID capture. Added by migration v57; declared
      -- here because these fixtures hand-roll the table rather than run the
      -- chain, and the macOS upsert now writes this column.
      external_uuid TEXT,
      -- BACKLOG-2407: per-source identity capture. Added by migration v58;
      -- declared here for the same reason as the line above — the iPhone and
      -- generic upserts exercised by this file now name this column, so a
      -- fixture without it fails with "no such column" rather than testing
      -- anything about phone normalization.
      source_identity_json TEXT,
      UNIQUE (user_id, source, external_record_id)
    );
  `);

  /**
   * BACKLOG-2496 — the crosswalk table, from the CANONICAL constant rather than
   * a hand-written copy, so this fixture cannot drift from the real schema.
   *
   * It is needed here now because creating a contact WRITES ITS ORIGIN in the
   * same transaction. A fixture without this table does not model a database
   * the app could ever run against: every create would roll back on
   * "no such table: contact_source_links".
   */
  db.exec(CONTACT_SOURCE_LINKS_TABLE_SQL);
  db.exec(CONTACT_SOURCE_LINKS_INDEX_SQL);

}

const USER_ID = "user-1";

function makeDb(): DatabaseType {
  const db = new Database(":memory:");
  createSchema(db);
  return db;
}

// Helper: read a contact's stored phone rows directly (bypasses any caching).
function readPhoneRows(
  db: DatabaseType,
  contactId: string,
): Array<{ phone_e164: string; phone_normalized: string | null; is_primary: number }> {
  return db
    .prepare(
      `SELECT phone_e164, phone_normalized, is_primary
         FROM contact_phones WHERE contact_id = ? ORDER BY created_at, id`,
    )
    .all(contactId) as Array<{
    phone_e164: string;
    phone_normalized: string | null;
    is_primary: number;
  }>;
}

function readExternalPhones(
  db: DatabaseType,
  recordId: string,
): { phones_normalized_json: string | null } | undefined {
  return db
    .prepare(
      `SELECT phones_normalized_json FROM external_contacts WHERE external_record_id = ?`,
    )
    .get(recordId) as { phones_normalized_json: string | null } | undefined;
}

describe("BACKLOG-1729 write-path: phone_normalized === toLookupKey(input)", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = makeDb();
    setDb(db);
  });

  afterEach(() => {
    db.close();
    // Reset injected connection so other suites don't see a closed DB.
    setDb(undefined as unknown as DatabaseType);
  });

  // -------------------------------------------------------------------------
  // contactDbService.createContact
  // -------------------------------------------------------------------------
  describe("contactDbService.createContact", () => {
    it("persists toLookupKey-equivalent phone_normalized for formatted US phone", async () => {
      const input = "+1 (415) 555-0109";
      await createContact({
        user_id: USER_ID,
        display_name: "Alice",
        phone: input,
        is_imported: false,
      } as Parameters<typeof createContact>[0], { kind: "derived" });

      const contact = db
        .prepare("SELECT id FROM contacts WHERE user_id = ? LIMIT 1")
        .get(USER_ID) as { id: string };
      const rows = readPhoneRows(db, contact.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].phone_normalized).toBe(toLookupKey(input));
      expect(rows[0].phone_normalized).toBe("14155550109"); // BACKLOG-2630: key now carries the country code
    });

    it("persists toLookupKey-equivalent phone_normalized for UK international", async () => {
      const input = "+44 20 7946 0958";
      await createContact({
        user_id: USER_ID,
        display_name: "Bob",
        phone: input,
        is_imported: false,
      } as Parameters<typeof createContact>[0], { kind: "derived" });

      const contact = db
        .prepare("SELECT id FROM contacts WHERE user_id = ? LIMIT 1")
        .get(USER_ID) as { id: string };
      const rows = readPhoneRows(db, contact.id);
      expect(rows[0].phone_normalized).toBe(toLookupKey(input));
      expect(rows[0].phone_normalized).toBe("442079460958"); // BACKLOG-2630: +44 kept, not amputated
    });
  });

  // -------------------------------------------------------------------------
  // contactDbService.createContactsBatch
  // -------------------------------------------------------------------------
  describe("contactDbService.createContactsBatch", () => {
    it("persists toLookupKey for every contact in the batch", () => {
      const inputs = [
        { phone: "+1 (415) 555-0109", expected: "14155550109" },
        { phone: "+44 20 7946 0958", expected: "442079460958" },
        { phone: "12345", expected: "12345" },
      ];
      const ids = createContactsBatch(
        inputs.map((i, idx) => ({
          user_id: USER_ID,
          display_name: `Batch-${idx}`,
          phone: i.phone,
          is_imported: false,
          origin: { kind: "derived" } as const,
        })),
      );
      expect(ids).toHaveLength(inputs.length);
      for (let i = 0; i < inputs.length; i++) {
        const rows = readPhoneRows(db, ids[i]);
        expect(rows).toHaveLength(1);
        expect(rows[0].phone_normalized).toBe(toLookupKey(inputs[i].phone));
        expect(rows[0].phone_normalized).toBe(inputs[i].expected);
      }
    });
  });

  // -------------------------------------------------------------------------
  // contactDbService.backfillContactPhones
  // -------------------------------------------------------------------------
  describe("contactDbService.backfillContactPhones", () => {
    it("persists toLookupKey for newly backfilled phones", async () => {
      const contactId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 0)",
      ).run(contactId, USER_ID, "Carol");

      const input = "+1 (415) 555-9876";
      const added = await backfillContactPhones(contactId, [input]);
      expect(added).toBeGreaterThan(0);

      const rows = readPhoneRows(db, contactId);
      expect(rows[0].phone_normalized).toBe(toLookupKey(input));
      expect(rows[0].phone_normalized).toBe("14155559876");
    });
  });

  // -------------------------------------------------------------------------
  // contactDbService.syncContactPhones (the "updateContactPhones" path)
  // -------------------------------------------------------------------------
  describe("contactDbService.syncContactPhones", () => {
    it("persists toLookupKey on INSERT path (new entry)", () => {
      const contactId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 0)",
      ).run(contactId, USER_ID, "Dan");

      const input = "+1 415 555 3333";
      syncContactPhones(contactId, [{ phone: input, is_primary: true }]);

      const rows = readPhoneRows(db, contactId);
      expect(rows[0].phone_normalized).toBe(toLookupKey(input));
      expect(rows[0].phone_normalized).toBe("14155553333");
    });

    it("persists toLookupKey on UPDATE path (existing entry id)", () => {
      const contactId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 0)",
      ).run(contactId, USER_ID, "Eve");
      const phoneId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary, source) VALUES (?, ?, ?, ?, 1, 'manual')",
      ).run(phoneId, contactId, "+15550000000", toLookupKey("+15550000000"));

      const input = "+44 20 7946 0212";
      const entries = getContactPhoneEntries(contactId).map((e) => ({
        id: e.id,
        phone: input,
        is_primary: true,
      }));
      syncContactPhones(contactId, entries);

      const rows = readPhoneRows(db, contactId);
      expect(rows[0].phone_normalized).toBe(toLookupKey(input));
      expect(rows[0].phone_normalized).toBe("442079460212");
    });
  });

  // -------------------------------------------------------------------------
  // contactDbService.setContactPrimaryPhone
  // -------------------------------------------------------------------------
  describe("contactDbService.setContactPrimaryPhone", () => {
    it("persists toLookupKey on the INSERT branch (no existing phone)", () => {
      const contactId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 0)",
      ).run(contactId, USER_ID, "Frank");

      const input = "+1 415 555 7777";
      setContactPrimaryPhone(contactId, input);

      const rows = readPhoneRows(db, contactId);
      expect(rows).toHaveLength(1);
      expect(rows[0].phone_normalized).toBe(toLookupKey(input));
      expect(rows[0].phone_normalized).toBe("14155557777");
    });

    it("persists toLookupKey on the UPDATE branch (existing top phone)", () => {
      const contactId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 0)",
      ).run(contactId, USER_ID, "Gina");
      const phoneId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary, source) VALUES (?, ?, ?, ?, 1, 'manual')",
      ).run(phoneId, contactId, "+15550000000", toLookupKey("+15550000000"));

      const input = "+1 (415) 555-0115";
      setContactPrimaryPhone(contactId, input);

      const rows = readPhoneRows(db, contactId);
      expect(rows).toHaveLength(1);
      expect(rows[0].phone_normalized).toBe(toLookupKey(input));
      expect(rows[0].phone_normalized).toBe("14155550115");
    });
  });

  // -------------------------------------------------------------------------
  // contactQueryWorker SQL pattern
  //
  // The worker runs in a separate thread harness which is out of scope.
  // Per SR-approved plan, test the SQL string the worker emits using the
  // exact same INSERT pattern + `toLookupKey` call.
  // -------------------------------------------------------------------------
  describe("contactQueryWorker INSERT pattern (SQL parity)", () => {
    it("emitted INSERT pattern persists toLookupKey-equivalent phone_normalized", () => {
      const contactId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 0)",
      ).run(contactId, USER_ID, "Worker");

      const phoneE164 = "+15555550112";
      const phone = "+1 (555) 555-0112";
      const id = crypto.randomUUID();
      // EXACT SQL pattern from electron/workers/contactQueryWorker.ts:163
      db.prepare(
        `INSERT OR IGNORE INTO contact_phones (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'import', CURRENT_TIMESTAMP)`,
      ).run(id, contactId, phoneE164, phone, toLookupKey(phoneE164), 1);

      const rows = readPhoneRows(db, contactId);
      expect(rows[0].phone_normalized).toBe(toLookupKey(phoneE164));
      // DELIBERATE 555-555 FALLBACK FIXTURE (BACKLOG-2630). Area code 555 is not
      // assignable, so libphonenumber declines it and `toLookupKey` routes it
      // through `legacyDigitKey` — the key is unchanged by this item, which is
      // the property this case exists to pin.
      expect(rows[0].phone_normalized).toBe("5555550112");

      // ...and the SAME write path on the LIBRARY path, because a suite that
      // only ever feeds it 555 numbers never exercises the parser at all. That
      // blindness is what hid the Android promotion defect (SR blocker B1):
      // under a 555 corpus the parsed key and the legacy key coincide, so a
      // caller computing the old key looks correct. 415 with a 555-01xx line is
      // parseable AND inside the reserved fictional range.
      const parsedE164 = "+14155550112";
      const parsedId = crypto.randomUUID();
      db.prepare(
        `INSERT OR IGNORE INTO contact_phones (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'import', CURRENT_TIMESTAMP)`,
      ).run(parsedId, contactId, parsedE164, "+1 (415) 555-0112", toLookupKey(parsedE164), 0);

      // `readPhoneRows` projects phone_e164, not id — match on the value.
      const parsedRow = readPhoneRows(db, contactId).find((r) => r.phone_e164 === parsedE164)!;
      expect(parsedRow.phone_normalized).toBe(toLookupKey(parsedE164));
      expect(parsedRow.phone_normalized).toBe("14155550112");
      // The two paths genuinely differ — without this the case above could be
      // passing for the wrong reason.
      expect(toLookupKey(parsedE164)).not.toBe(legacyDigitKey(parsedE164));
      expect(toLookupKey(phoneE164)).toBe(legacyDigitKey(phoneE164));
    });
  });

  // -------------------------------------------------------------------------
  // externalContactDbService.upsertFromMacOS
  // -------------------------------------------------------------------------
  describe("externalContactDbService.upsertFromMacOS", () => {
    it("persists toLookupKey-equivalent phones_normalized_json array", () => {
      const recordId = "macos-record-1";
      upsertFromMacOS(USER_ID, [
        {
          recordId,
          name: "Helen",
          phones: ["+1 (415) 555-0109", "+44 20 7946 0958"],
          emails: [],
          company: null,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ]);

      const row = readExternalPhones(db, recordId);
      const persisted = JSON.parse(row!.phones_normalized_json!);
      expect(persisted).toEqual([
        toLookupKey("+1 (415) 555-0109"),
        toLookupKey("+44 20 7946 0958"),
      ]);
      expect(persisted).toEqual(["14155550109", "442079460958"]);
    });

    it("filters out empty-key inputs (whitespace, empty)", () => {
      const recordId = "macos-record-2";
      upsertFromMacOS(USER_ID, [
        {
          recordId,
          name: "Ivy",
          phones: ["", "   ", "+14155550109"],
          emails: [],
          company: null,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ]);

      const row = readExternalPhones(db, recordId);
      const persisted = JSON.parse(row!.phones_normalized_json!);
      expect(persisted).toEqual([toLookupKey("+14155550109")]);
    });
  });

  // -------------------------------------------------------------------------
  // externalContactDbService.upsertFromiPhone
  // -------------------------------------------------------------------------
  describe("externalContactDbService.upsertFromiPhone", () => {
    it("persists toLookupKey-equivalent phones_normalized_json array", () => {
      const recordId = "iphone-record-1";
      upsertFromiPhone(USER_ID, [
        {
          recordId,
          name: "Jake",
          phones: ["+1-415-555-2222"],
          emails: [],
          company: null,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ]);

      const row = readExternalPhones(db, recordId);
      const persisted = JSON.parse(row!.phones_normalized_json!);
      expect(persisted).toEqual([toLookupKey("+1-415-555-2222")]);
      expect(persisted).toEqual(["14155552222"]);
    });
  });

  // -------------------------------------------------------------------------
  // externalContactDbService.upsertExternalContacts (generic: outlook/google)
  // -------------------------------------------------------------------------
  describe("externalContactDbService.upsertExternalContacts", () => {
    it("persists toLookupKey-equivalent phones_normalized_json for outlook source", () => {
      const recordId = "outlook-record-1";
      upsertExternalContacts(USER_ID, "outlook", [
        {
          external_record_id: recordId,
          name: "Kara",
          phones: ["+1.415.555.5555"],
          emails: [],
          company: null,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ]);

      const row = readExternalPhones(db, recordId);
      const persisted = JSON.parse(row!.phones_normalized_json!);
      expect(persisted).toEqual([toLookupKey("+1.415.555.5555")]);
      expect(persisted).toEqual(["14155555555"]);
    });

    it("persists toLookupKey-equivalent phones_normalized_json for google_contacts source", () => {
      const recordId = "google-record-1";
      upsertExternalContacts(USER_ID, "google_contacts", [
        {
          external_record_id: recordId,
          name: "Liam",
          phones: ["+44 20 7946 0123"],
          emails: [],
          company: null,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ]);

      const row = readExternalPhones(db, recordId);
      const persisted = JSON.parse(row!.phones_normalized_json!);
      expect(persisted).toEqual([toLookupKey("+44 20 7946 0123")]);
      expect(persisted).toEqual(["442079460123"]);
    });
  });
});
