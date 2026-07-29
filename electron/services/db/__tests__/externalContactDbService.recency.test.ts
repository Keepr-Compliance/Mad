/**
 * @jest-environment node
 *
 * BACKLOG-2355 — the select-jump root cause: external (address-book) contact
 * recency was PHONE-ONLY while the imported path used PHONE + EMAIL, so an
 * email-only external contact read NULL, sorted to the bottom, and jumped up the
 * instant it was imported (null -> real recency).
 *
 * These tests execute the SHARED recency SQL against a real in-memory
 * better-sqlite3 database (mocked jest can't run SQL) and assert:
 *   1. an email-only external contact now surfaces its REAL last-contacted date,
 *   2. the ANTI-JUMP INVARIANT: an external contact and its imported twin
 *      compute the SAME recency value (so importing changes nothing to sort on),
 *   3. phone-only and phone+email (MAX across channels) parity,
 *   4. the batch UPDATE populates the stored column with the same value.
 *
 * Uses a minimal subset of the production schema — no Electron, no migrations
 * runner, just SQL — mirroring phoneNormalizedJoin.test.ts.
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers")
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";
import crypto from "crypto";
import {
  EXTERNAL_CONTACTS_GET_ALL_SQL,
  EXTERNAL_CONTACT_RECENCY_UPDATE_SQL,
  IMPORTED_CONTACT_LAST_COMMUNICATION_SQL,
} from "../contactRecencySql";

const USER_ID = "user-1";

function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE users_local (id TEXT PRIMARY KEY);

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
      synced_at DATETIME
    );

    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      display_name TEXT,
      is_imported INTEGER DEFAULT 0,
      last_inbound_at DATETIME,
      last_outbound_at DATETIME
    );

    CREATE TABLE contact_phones (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      phone_e164 TEXT NOT NULL,
      phone_normalized TEXT,
      is_primary INTEGER DEFAULT 0
    );

    CREATE TABLE contact_emails (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      email TEXT NOT NULL,
      is_primary INTEGER DEFAULT 0
    );

    CREATE TABLE phone_last_message (
      phone_normalized TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_message_at DATETIME NOT NULL,
      PRIMARY KEY (phone_normalized, user_id)
    );

    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      sent_at DATETIME,
      received_at DATETIME
    );

    CREATE TABLE email_participants (
      email_id TEXT NOT NULL,
      role TEXT NOT NULL,
      position INTEGER NOT NULL,
      email_address TEXT NOT NULL,
      PRIMARY KEY (email_id, role, position)
    );
    CREATE INDEX idx_email_participants_email_address ON email_participants(email_address);
  `);
}

// --- fixture builders ------------------------------------------------------

/** An email addressed to `address`, dated `sentAt` (or `receivedAt` when sentAt null). */
function insertEmail(
  db: DatabaseType,
  address: string,
  opts: { sentAt?: string | null; receivedAt?: string | null },
): void {
  const emailId = crypto.randomUUID();
  db.prepare("INSERT INTO emails (id, user_id, sent_at, received_at) VALUES (?, ?, ?, ?)").run(
    emailId,
    USER_ID,
    opts.sentAt ?? null,
    opts.receivedAt ?? null,
  );
  db.prepare(
    "INSERT INTO email_participants (email_id, role, position, email_address) VALUES (?, 'from', 0, ?)",
  ).run(emailId, address);
}

function insertPhoneMessage(db: DatabaseType, normalized: string, at: string): void {
  db.prepare(
    "INSERT INTO phone_last_message (phone_normalized, user_id, last_message_at) VALUES (?, ?, ?)",
  ).run(normalized, USER_ID, at);
}

function insertExternal(
  db: DatabaseType,
  opts: { id: string; name: string; emails?: string[]; phonesNormalized?: string[] },
): void {
  db.prepare(
    `INSERT INTO external_contacts
       (id, user_id, name, emails_json, phones_normalized_json, source, external_record_id, synced_at)
     VALUES (?, ?, ?, ?, ?, 'macos', ?, '2026-01-01T00:00:00Z')`,
  ).run(
    opts.id,
    USER_ID,
    opts.name,
    opts.emails ? JSON.stringify(opts.emails) : null,
    opts.phonesNormalized ? JSON.stringify(opts.phonesNormalized) : null,
    opts.id,
  );
}

/** Import a twin: a real `contacts` row + its child email/phone rows. */
function insertImported(
  db: DatabaseType,
  opts: { id: string; name: string; emails?: string[]; phonesNormalized?: string[] },
): void {
  db.prepare(
    "INSERT INTO contacts (id, user_id, display_name, is_imported) VALUES (?, ?, ?, 1)",
  ).run(opts.id, USER_ID, opts.name);
  for (const email of opts.emails ?? []) {
    db.prepare(
      "INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES (?, ?, ?, 0)",
    ).run(crypto.randomUUID(), opts.id, email);
  }
  for (const phone of opts.phonesNormalized ?? []) {
    db.prepare(
      "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary) VALUES (?, ?, ?, ?, 0)",
    ).run(crypto.randomUUID(), opts.id, `+1${phone}`, phone);
  }
}

// --- readers ---------------------------------------------------------------

/** External recency via the shared load query -> map of id -> computed last_message_at. */
function externalRecency(db: DatabaseType): Map<string, string | null> {
  const rows = db.prepare(EXTERNAL_CONTACTS_GET_ALL_SQL).all(USER_ID) as {
    id: string;
    last_message_at: string | null;
  }[];
  return new Map(rows.map((r) => [r.id, r.last_message_at]));
}

/** Imported recency via the shared imported fragment (channels: phone+email+denorm). */
function importedRecency(db: DatabaseType, contactId: string): string | null {
  const row = db
    .prepare(
      `SELECT c.id, ${IMPORTED_CONTACT_LAST_COMMUNICATION_SQL}
       FROM contacts c WHERE c.user_id = ? AND c.id = ?`,
    )
    .get(USER_ID, contactId) as { last_communication_at: string | null };
  return row.last_communication_at;
}

describe("BACKLOG-2355 external contact recency (phone + email, real SQLite)", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    db.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER_ID);
  });

  afterEach(() => {
    db.close();
  });

  it("email-only external contact surfaces its REAL last-contacted date (was NULL)", () => {
    insertEmail(db, "hd@berkeley.edu", { sentAt: "2026-05-01T10:00:00Z" });
    insertExternal(db, { id: "ext-hd", name: "Daniel Haim", emails: ["hd@berkeley.edu"] });

    const recency = externalRecency(db);
    expect(new Set(recency.keys())).toEqual(new Set(["ext-hd"]));
    expect(recency.get("ext-hd")).toBe("2026-05-01T10:00:00Z");
  });

  it("email match is case-insensitive and falls back to received_at when sent_at is null", () => {
    insertEmail(db, "HD@Berkeley.EDU", { sentAt: null, receivedAt: "2026-04-02T08:00:00Z" });
    insertExternal(db, { id: "ext-hd", name: "Daniel Haim", emails: ["hd@berkeley.edu"] });

    expect(externalRecency(db).get("ext-hd")).toBe("2026-04-02T08:00:00Z");
  });

  it("ANTI-JUMP INVARIANT: an external contact and its imported twin compute the SAME value", () => {
    // Email-only person — the exact founder case (hd@berkeley.edu).
    insertEmail(db, "hd@berkeley.edu", { sentAt: "2026-05-01T10:00:00Z" });
    insertExternal(db, { id: "ext-hd", name: "Daniel Haim", emails: ["hd@berkeley.edu"] });
    // The imported twin: fresh import -> last_inbound_at / last_outbound_at NULL.
    insertImported(db, { id: "imp-hd", name: "Daniel Haim", emails: ["hd@berkeley.edu"] });

    const ext = externalRecency(db).get("ext-hd");
    const imp = importedRecency(db, "imp-hd");
    expect(ext).toBe("2026-05-01T10:00:00Z");
    expect(imp).toBe("2026-05-01T10:00:00Z");
    // The invariant that kills the jump: value is identical across the two paths,
    // so importing does not change what the row sorts on.
    expect(ext).toBe(imp);
  });

  it("ANTI-JUMP INVARIANT holds for a phone-only person too", () => {
    insertPhoneMessage(db, "4155551234", "2026-03-15T12:00:00Z");
    insertExternal(db, { id: "ext-ph", name: "Phone Only", phonesNormalized: ["4155551234"] });
    insertImported(db, { id: "imp-ph", name: "Phone Only", phonesNormalized: ["4155551234"] });

    const ext = externalRecency(db).get("ext-ph");
    const imp = importedRecency(db, "imp-ph");
    expect(ext).toBe("2026-03-15T12:00:00Z");
    expect(ext).toBe(imp);
  });

  it("takes the MAX across phone and email channels", () => {
    insertPhoneMessage(db, "4155551234", "2026-01-01T00:00:00Z");
    insertEmail(db, "both@x.com", { sentAt: "2026-06-01T00:00:00Z" });
    insertExternal(db, {
      id: "ext-both",
      name: "Both Channels",
      emails: ["both@x.com"],
      phonesNormalized: ["4155551234"],
    });
    insertImported(db, {
      id: "imp-both",
      name: "Both Channels",
      emails: ["both@x.com"],
      phonesNormalized: ["4155551234"],
    });

    const ext = externalRecency(db).get("ext-both");
    expect(ext).toBe("2026-06-01T00:00:00Z"); // email is newer -> wins
    expect(ext).toBe(importedRecency(db, "imp-both"));
  });

  it("stays NULL when the person has no phone and no email activity", () => {
    insertExternal(db, { id: "ext-cold", name: "Never Contacted", emails: ["cold@x.com"] });
    expect(externalRecency(db).get("ext-cold")).toBeNull();
  });

  it("computes the correct value for a MIXED batch (exact id -> date map)", () => {
    insertEmail(db, "hd@berkeley.edu", { sentAt: "2026-05-01T10:00:00Z" });
    insertPhoneMessage(db, "4155550000", "2026-02-02T02:00:00Z");

    insertExternal(db, { id: "ext-email", name: "Email Person", emails: ["hd@berkeley.edu"] });
    insertExternal(db, { id: "ext-phone", name: "Phone Person", phonesNormalized: ["4155550000"] });
    insertExternal(db, { id: "ext-none", name: "Cold Person", emails: ["nope@x.com"] });

    const recency = externalRecency(db);
    expect(new Set(recency.keys())).toEqual(new Set(["ext-email", "ext-phone", "ext-none"]));
    expect(recency.get("ext-email")).toBe("2026-05-01T10:00:00Z");
    expect(recency.get("ext-phone")).toBe("2026-02-02T02:00:00Z");
    expect(recency.get("ext-none")).toBeNull();
  });

  it("batch UPDATE writes the same phone+email value into the stored column", () => {
    insertEmail(db, "hd@berkeley.edu", { sentAt: "2026-05-01T10:00:00Z" });
    insertExternal(db, { id: "ext-hd", name: "Daniel Haim", emails: ["hd@berkeley.edu"] });

    // Pre-condition: stored column starts NULL (email-only never got a phone date).
    const before = db
      .prepare("SELECT last_message_at FROM external_contacts WHERE id = 'ext-hd'")
      .get() as { last_message_at: string | null };
    expect(before.last_message_at).toBeNull();

    db.prepare(EXTERNAL_CONTACT_RECENCY_UPDATE_SQL).run(USER_ID);

    const after = db
      .prepare("SELECT last_message_at FROM external_contacts WHERE id = 'ext-hd'")
      .get() as { last_message_at: string | null };
    expect(after.last_message_at).toBe("2026-05-01T10:00:00Z");
  });
});
