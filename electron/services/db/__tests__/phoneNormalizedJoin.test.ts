/**
 * @jest-environment node
 *
 * Integration test for BACKLOG-1727 — verifies that contact_phones.phone_normalized
 * and external_contacts.phones_normalized_json are populated via the shared helper
 * at write time AND that the reader JOIN matches phone_last_message regardless of
 * how the raw phone was formatted on the contact side.
 *
 * Uses an in-memory better-sqlite3-multiple-ciphers database with a minimal subset
 * of the production schema — no Electron, no migrations runner, just SQL.
 */

// The default Jest moduleNameMapper rewrites "better-sqlite3-multiple-ciphers"
// to a stub; require the real package via an explicit node_modules path so
// this integration test exercises actual SQL.
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers")
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";
import crypto from "crypto";
import { normalizePhoneLookupKey } from "../../../utils/phoneLookupKey";

function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE users_local (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      display_name TEXT,
      is_imported INTEGER DEFAULT 0,
      last_inbound_at DATETIME,
      last_outbound_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
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
      is_primary INTEGER DEFAULT 0
    );

    CREATE TABLE external_contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT,
      phones_json TEXT,
      phones_normalized_json TEXT,
      emails_json TEXT,
      last_message_at DATETIME,
      external_record_id TEXT,
      source TEXT,
      synced_at DATETIME
    );

    CREATE TABLE phone_last_message (
      phone_normalized TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_message_at DATETIME NOT NULL,
      PRIMARY KEY (phone_normalized, user_id)
    );
  `);
}

function insertContactWithPhone(
  db: DatabaseType,
  userId: string,
  displayName: string,
  rawPhone: string,
): string {
  const contactId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 0)"
  ).run(contactId, userId, displayName);

  db.prepare(
    `INSERT INTO contact_phones
       (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source)
     VALUES (?, ?, ?, ?, ?, 1, 'import')`
  ).run(
    crypto.randomUUID(),
    contactId,
    rawPhone,
    rawPhone,
    normalizePhoneLookupKey(rawPhone),
    /* is_primary handled via positional */
  );
  return contactId;
}

function insertExternalContact(
  db: DatabaseType,
  userId: string,
  name: string,
  rawPhones: string[],
): string {
  const id = crypto.randomUUID();
  const normalized = rawPhones
    .map(normalizePhoneLookupKey)
    .filter((k) => k.length > 0);
  db.prepare(
    `INSERT INTO external_contacts
       (id, user_id, name, phones_json, phones_normalized_json, source, external_record_id)
     VALUES (?, ?, ?, ?, ?, 'iphone', ?)`
  ).run(id, userId, name, JSON.stringify(rawPhones), JSON.stringify(normalized), id);
  return id;
}

const READER_SQL = `
  SELECT
    c.id,
    c.display_name,
    (
      SELECT MAX(plm.last_message_at)
      FROM contact_phones cp
      JOIN phone_last_message plm
        ON plm.user_id = c.user_id
       AND plm.phone_normalized = cp.phone_normalized
      WHERE cp.contact_id = c.id
        AND cp.phone_normalized IS NOT NULL
    ) as last_communication_at
  FROM contacts c
  WHERE c.user_id = ? AND c.is_imported = 0
`;

const EXTERNAL_READER_SQL = `
  SELECT id, name, last_message_at FROM external_contacts WHERE user_id = ?
`;

describe("BACKLOG-1727 phone_normalized JOIN behaviour", () => {
  let db: DatabaseType;
  const userId = "user-1";

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    db.prepare("INSERT INTO users_local (id) VALUES (?)").run(userId);
  });

  afterEach(() => {
    db.close();
  });

  describe("contact_phones JOIN to phone_last_message", () => {
    it("matches US-formatted contact phone against clean writer key", () => {
      // Writer stored a clean E.164 key: messages came in as "+14155551234".
      // normalizePhoneLookupKey("+14155551234") === "4155551234".
      db.prepare(
        "INSERT INTO phone_last_message (phone_normalized, user_id, last_message_at) VALUES (?, ?, ?)"
      ).run("4155551234", userId, "2026-05-15T10:00:00Z");

      // Contact came in formatted: "+1 (415) 555-1234"
      insertContactWithPhone(db, userId, "Alice", "+1 (415) 555-1234");

      const row = db.prepare(READER_SQL).get(userId) as { last_communication_at: string | null };
      expect(row.last_communication_at).toBe("2026-05-15T10:00:00Z");
    });

    it("matches UK international with spaces", () => {
      db.prepare(
        "INSERT INTO phone_last_message (phone_normalized, user_id, last_message_at) VALUES (?, ?, ?)"
      ).run("2079460958", userId, "2026-04-01T09:00:00Z");

      insertContactWithPhone(db, userId, "Bob", "+44 20 7946 0958");

      const row = db.prepare(READER_SQL).get(userId) as { last_communication_at: string | null };
      expect(row.last_communication_at).toBe("2026-04-01T09:00:00Z");
    });

    it("returns NULL when no message exists for the phone", () => {
      insertContactWithPhone(db, userId, "Carol", "+1 (415) 555-9999");

      const row = db.prepare(READER_SQL).get(userId) as { last_communication_at: string | null };
      expect(row.last_communication_at).toBeNull();
    });

    it("matches a short code (5-digit) without truncation", () => {
      db.prepare(
        "INSERT INTO phone_last_message (phone_normalized, user_id, last_message_at) VALUES (?, ?, ?)"
      ).run("12345", userId, "2026-03-01T08:00:00Z");

      insertContactWithPhone(db, userId, "ShortCode", "12345");

      const row = db.prepare(READER_SQL).get(userId) as { last_communication_at: string | null };
      expect(row.last_communication_at).toBe("2026-03-01T08:00:00Z");
    });

    it("returns the MAX timestamp across multiple matching phones", () => {
      const contactId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 0)"
      ).run(contactId, userId, "Multi");

      const insertPhone = db.prepare(
        `INSERT INTO contact_phones
           (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source)
         VALUES (?, ?, ?, ?, ?, 0, 'import')`
      );
      insertPhone.run(crypto.randomUUID(), contactId, "+14155551111", "+1 (415) 555-1111", normalizePhoneLookupKey("+14155551111"));
      insertPhone.run(crypto.randomUUID(), contactId, "+14155552222", "+1 (415) 555-2222", normalizePhoneLookupKey("+14155552222"));

      const insertPLM = db.prepare(
        "INSERT INTO phone_last_message (phone_normalized, user_id, last_message_at) VALUES (?, ?, ?)"
      );
      insertPLM.run("4155551111", userId, "2026-01-01T00:00:00Z");
      insertPLM.run("4155552222", userId, "2026-06-01T00:00:00Z");

      const row = db.prepare(READER_SQL).get(userId) as { last_communication_at: string };
      expect(row.last_communication_at).toBe("2026-06-01T00:00:00Z");
    });
  });

  describe("external_contacts JOIN via phones_normalized_json", () => {
    function refreshExternalLastMessageAt(): number {
      return db.prepare(`
        UPDATE external_contacts
        SET last_message_at = (
          SELECT MAX(plm.last_message_at)
          FROM phone_last_message plm, json_each(external_contacts.phones_normalized_json) AS p
          WHERE plm.user_id = external_contacts.user_id
            AND plm.phone_normalized = p.value
        )
        WHERE user_id = ?
          AND phones_normalized_json IS NOT NULL
      `).run(userId).changes;
    }

    it("populates last_message_at for US-formatted phones in phones_json", () => {
      db.prepare(
        "INSERT INTO phone_last_message (phone_normalized, user_id, last_message_at) VALUES (?, ?, ?)"
      ).run("4155551234", userId, "2026-05-15T10:00:00Z");

      insertExternalContact(db, userId, "Alice", ["+1 (415) 555-1234"]);

      refreshExternalLastMessageAt();
      const row = db.prepare(EXTERNAL_READER_SQL).get(userId) as { last_message_at: string | null };
      expect(row.last_message_at).toBe("2026-05-15T10:00:00Z");
    });

    it("handles multiple phones, picks MAX timestamp", () => {
      const insertPLM = db.prepare(
        "INSERT INTO phone_last_message (phone_normalized, user_id, last_message_at) VALUES (?, ?, ?)"
      );
      insertPLM.run("4155551111", userId, "2026-01-01T00:00:00Z");
      insertPLM.run("4155552222", userId, "2026-08-01T00:00:00Z");

      insertExternalContact(db, userId, "MultiPhone", ["+1 (415) 555-1111", "+1-415-555-2222"]);

      refreshExternalLastMessageAt();
      const row = db.prepare(EXTERNAL_READER_SQL).get(userId) as { last_message_at: string | null };
      expect(row.last_message_at).toBe("2026-08-01T00:00:00Z");
    });

    it("leaves last_message_at NULL when no phone matches", () => {
      db.prepare(
        "INSERT INTO phone_last_message (phone_normalized, user_id, last_message_at) VALUES (?, ?, ?)"
      ).run("9999999999", userId, "2026-05-15T10:00:00Z");

      insertExternalContact(db, userId, "Lonely", ["+1 (415) 555-1234"]);

      refreshExternalLastMessageAt();
      const row = db.prepare(EXTERNAL_READER_SQL).get(userId) as { last_message_at: string | null };
      expect(row.last_message_at).toBeNull();
    });
  });
});
