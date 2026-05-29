/**
 * Contact Query Worker (TASK-1956, BACKLOG-661)
 *
 * Persistent worker that runs contact queries in a separate thread to avoid
 * blocking the Electron main process. Synchronous better-sqlite3 queries
 * block the main thread, freezing window dragging and all UI.
 *
 * Message protocol:
 * - Parent → Worker: { type: "init", dbPath, encryptionKey }
 * - Worker → Parent: { type: "ready" }
 * - Parent → Worker: { id, type: "external"|"imported"|"backfill", userId }
 * - Worker → Parent: { id, success, data?, error? }
 * - Parent → Worker: { type: "shutdown" }
 *
 * Security: The encryption key is passed via postMessage (same-process,
 * never crosses an IPC boundary).
 */

import { parentPort } from "worker_threads";
import Database from "better-sqlite3-multiple-ciphers";
import type { Database as DatabaseType } from "better-sqlite3";
import { normalizePhoneLookupKey } from "../utils/phoneLookupKey";

type QueryType = "external" | "imported" | "backfill";

interface InitMessage {
  type: "init";
  dbPath: string;
  encryptionKey: string;
}

interface QueryMessage {
  id: string;
  type: QueryType;
  userId: string;
}

interface ShutdownMessage {
  type: "shutdown";
}

type WorkerMessage = InitMessage | QueryMessage | ShutdownMessage;

let db: DatabaseType | null = null;

function openDatabase(dbPath: string, encryptionKey: string): void {
  db = new Database(dbPath);
  db.pragma(`key = "x'${encryptionKey}'"`);
  db.pragma("cipher_compatibility = 4");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
}

function runImportedQuery(userId: string): unknown[] {
  if (!db) throw new Error("Database not initialized");
  const sql = `
    SELECT
      c.*,
      c.display_name as name,
      COALESCE(
        (SELECT email FROM contact_emails WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT email FROM contact_emails WHERE contact_id = c.id LIMIT 1)
      ) as email,
      COALESCE(
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id LIMIT 1)
      ) as phone,
      (SELECT json_group_array(email) FROM contact_emails WHERE contact_id = c.id) as all_emails_json,
      (SELECT json_group_array(phone_e164) FROM contact_phones WHERE contact_id = c.id) as all_phones_json,
      0 as is_message_derived
    FROM contacts c
    WHERE c.user_id = ? AND c.is_imported = 1
    ORDER BY c.display_name ASC
  `;
  return db.prepare(sql).all(userId);
}

function runExternalQuery(userId: string): unknown[] {
  if (!db) throw new Error("Database not initialized");
  const sql = `
    SELECT id, user_id, name, phones_json, emails_json, company,
           last_message_at, external_record_id, source, synced_at
    FROM external_contacts
    WHERE user_id = ?
    ORDER BY last_message_at IS NULL, last_message_at DESC, name ASC
  `;
  return db.prepare(sql).all(userId);
}

function runBackfillQuery(userId: string): unknown[] {
  if (!db) throw new Error("Database not initialized");

  // Get all imported contacts
  const importedContacts = db.prepare(
    `SELECT id, display_name FROM contacts WHERE user_id = ? AND is_imported = 1`
  ).all(userId) as Array<{ id: string; display_name: string }>;

  let updated = 0;

  for (const contact of importedContacts) {
    // Find matching external contact by name
    const external = db.prepare(
      `SELECT emails_json, phones_json FROM external_contacts WHERE user_id = ? AND name = ?`
    ).get(userId, contact.display_name) as { emails_json: string; phones_json: string } | undefined;

    if (!external) continue;

    const emails: string[] = external.emails_json ? JSON.parse(external.emails_json) : [];
    const phones: string[] = external.phones_json ? JSON.parse(external.phones_json) : [];

    let contactUpdated = false;

    // Backfill emails
    if (emails.length > 0) {
      const existingEmails = db.prepare(
        `SELECT LOWER(email) as email FROM contact_emails WHERE contact_id = ?`
      ).all(contact.id) as Array<{ email: string }>;
      const existingSet = new Set(existingEmails.map(r => r.email));

      for (const email of emails) {
        if (!email) continue;
        const normalized = email.toLowerCase().trim();
        if (existingSet.has(normalized)) continue;
        existingSet.add(normalized);

        const isPrimary = existingEmails.length === 0 && !contactUpdated ? 1 : 0;
        const id = crypto.randomUUID();
        const result = db.prepare(
          `INSERT OR IGNORE INTO contact_emails (id, contact_id, email, is_primary, source, created_at)
           VALUES (?, ?, ?, ?, 'import', CURRENT_TIMESTAMP)`
        ).run(id, contact.id, normalized, isPrimary);
        if (result.changes > 0) contactUpdated = true;
      }
    }

    // Backfill phones
    if (phones.length > 0) {
      const existingPhones = db.prepare(
        `SELECT phone_e164 FROM contact_phones WHERE contact_id = ?`
      ).all(contact.id) as Array<{ phone_e164: string }>;
      const existingSet = new Set(
        existingPhones.map(r => r.phone_e164.replace(/\D/g, '').slice(-10))
      );

      for (const phone of phones) {
        if (!phone) continue;
        // Normalize to E.164
        const digits = phone.replace(/\D/g, '');
        let phoneE164: string;
        if (digits.length === 10) phoneE164 = `+1${digits}`;
        else if (digits.length === 11 && digits.startsWith('1')) phoneE164 = `+${digits}`;
        else if (phone.startsWith('+')) phoneE164 = phone;
        else phoneE164 = `+${digits}`;

        const normalizedKey = phoneE164.replace(/\D/g, '').slice(-10);
        if (existingSet.has(normalizedKey)) continue;
        existingSet.add(normalizedKey);

        const isPrimary = existingPhones.length === 0 && !contactUpdated ? 1 : 0;
        const id = crypto.randomUUID();
        const result = db.prepare(
          `INSERT OR IGNORE INTO contact_phones (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'import', CURRENT_TIMESTAMP)`
        ).run(id, contact.id, phoneE164, phone, normalizePhoneLookupKey(phoneE164), isPrimary);
        if (result.changes > 0) contactUpdated = true;
      }
    }

    if (contactUpdated) updated++;
  }

  return [{ updated }];
}

// Listen for messages from the pool
parentPort?.on("message", (msg: WorkerMessage) => {
  if (msg.type === "init") {
    try {
      openDatabase(msg.dbPath, msg.encryptionKey);
      parentPort?.postMessage({ type: "ready" });
    } catch (error) {
      parentPort?.postMessage({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (msg.type === "shutdown") {
    if (db) {
      try { db.close(); } catch { /* ignore close errors */ }
      db = null;
    }
    process.exit(0);
    return;
  }

  // Query message
  const queryMsg = msg as QueryMessage;
  try {
    let rows: unknown[];
    if (queryMsg.type === "imported") {
      rows = runImportedQuery(queryMsg.userId);
    } else if (queryMsg.type === "external") {
      rows = runExternalQuery(queryMsg.userId);
    } else if (queryMsg.type === "backfill") {
      rows = runBackfillQuery(queryMsg.userId);
    } else {
      throw new Error(`Unknown query type: ${queryMsg.type}`);
    }

    parentPort?.postMessage({
      id: queryMsg.id,
      success: true,
      data: rows,
    });
  } catch (error) {
    parentPort?.postMessage({
      id: queryMsg.id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
