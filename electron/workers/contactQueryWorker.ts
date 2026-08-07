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
import {
  EXTERNAL_CONTACTS_GET_ALL_SQL,
} from "../services/db/contactRecencySql";
import {
  CONTACT_SOURCE_RECORDS_SQL,
  type ContactSourceRecordRow,
} from "../services/db/contactSourceLinkSql";
import { IMPORTED_CONTACTS_SELECT_SQL } from "../services/db/contactProjectionSql";

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
  /**
   * BACKLOG-2536 — READ-ONLY BY CONSTRUCTION, NOT BY DISCIPLINE.
   *
   * This connection was writable, and the backfill below used it to INSERT.
   * That made a SECOND writer: two connections competing for the one SQLite
   * write lock, and — worse than the contention — a check-then-write race that
   * no retry can fix. The backfill decided `is_primary` from a read ("does this
   * contact have any email yet?") and then wrote; the main process could insert
   * into that gap, leaving two primaries or none. Nothing failed. Both writes
   * succeeded and disagreed.
   *
   * The worker still does all the scanning — that is why it exists, and the
   * 3.7s freeze it was built for (BACKLOG-661) was a READ of 1000+ address-book
   * rows. It now returns a PLAN and the main process applies it.
   */
  db = new Database(dbPath, { readonly: true });
  db.pragma(`key = "x'${encryptionKey}'"`);
  db.pragma("cipher_compatibility = 4");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
}

function runImportedQuery(userId: string): unknown[] {
  if (!db) throw new Error("Database not initialized");
  // BACKLOG-2514: the SAME constant the main-thread producer runs. This was a
  // hand-kept copy that a comment required to stay byte-identical with
  // contactDbService's; sharing the string is what that comment was asking for.
  const sql = IMPORTED_CONTACTS_SELECT_SQL;;
  return db.prepare(sql).all(userId);
}

function runExternalQuery(userId: string): unknown[] {
  if (!db) throw new Error("Database not initialized");
  // BACKLOG-2355: recency (`last_message_at`) is computed INLINE — phone + email,
  // identical to the imported path — via the shared EXTERNAL_CONTACTS_GET_ALL_SQL
  // so an email-only external contact reads its real date (not NULL) and no
  // select-jump occurs on import. Kept byte-for-byte identical to the sync
  // fallback (externalContactDbService.getAllForUser).
  return db.prepare(EXTERNAL_CONTACTS_GET_ALL_SQL).all(userId);
}

/**
 * PLAN the backfill. Writes nothing (BACKLOG-2536).
 *
 * Returns one row per contact that has something to gain, carrying the values
 * to add. `is_primary` is deliberately NOT decided here: it depends on what the
 * contact holds at the moment of the write, and only the writer can see that.
 */
function runBackfillQuery(userId: string): unknown[] {
  if (!db) throw new Error("Database not initialized");

  const importedContacts = db.prepare(
    `SELECT id FROM contacts WHERE user_id = ? AND is_imported = 1`
  ).all(userId) as Array<{ id: string }>;

  const plan: Array<{ contactId: string; emails: string[]; phones: string[] }> = [];

  for (const contact of importedContacts) {
    // BACKLOG-2401 — this lookup used to be display-name equality, so a rename
    // in Contacts.app permanently orphaned the saved record: no phone or email
    // update ever reached it again.
    //
    // CONTACT_SOURCE_RECORDS_SQL is shared VERBATIM with the main-thread twin in
    // contactHandlers.ts. Order: source id, then email, then phone. Never name.
    const externals = db
      .prepare(CONTACT_SOURCE_RECORDS_SQL)
      .all({ userId, contactId: contact.id }) as ContactSourceRecordRow[];

    if (externals.length === 0) continue;

    // One person can be in several sources at once. Backfill is additive and
    // dedupes below, so every linked record contributes instead of one winning.
    const emails: string[] = [];
    const phones: string[] = [];
    for (const external of externals) {
      if (external.emails_json) emails.push(...(JSON.parse(external.emails_json) as string[]));
      if (external.phones_json) phones.push(...(JSON.parse(external.phones_json) as string[]));
    }

    // Everything the contact already holds is filtered out HERE, where the
    // reads are cheap and off the main thread. The writer re-checks with
    // INSERT OR IGNORE, because this plan is a snapshot and the contact may
    // have changed between the scan and the write.
    const existingEmails = new Set(
      (db.prepare(
        `SELECT LOWER(email) as email FROM contact_emails WHERE contact_id = ?`
      ).all(contact.id) as Array<{ email: string }>).map((r) => r.email)
    );
    const existingPhoneKeys = new Set(
      (db.prepare(
        `SELECT phone_e164 FROM contact_phones WHERE contact_id = ?`
      ).all(contact.id) as Array<{ phone_e164: string }>).map((r) =>
        r.phone_e164.replace(/\D/g, "").slice(-10)
      )
    );

    const missingEmails: string[] = [];
    for (const email of emails) {
      if (!email) continue;
      const normalized = email.toLowerCase().trim();
      if (existingEmails.has(normalized)) continue;
      existingEmails.add(normalized);
      missingEmails.push(normalized);
    }

    const missingPhones: string[] = [];
    for (const phone of phones) {
      if (!phone) continue;
      const key = phone.replace(/\D/g, "").slice(-10);
      if (!key || existingPhoneKeys.has(key)) continue;
      existingPhoneKeys.add(key);
      missingPhones.push(phone);
    }

    if (missingEmails.length > 0 || missingPhones.length > 0) {
      plan.push({ contactId: contact.id, emails: missingEmails, phones: missingPhones });
    }
  }

  return plan;
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
