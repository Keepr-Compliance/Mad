/**
 * BACKLOG-3892 S2 — iPhone text coverage rows (schema.sql: iphone_device_coverage,
 * iphone_chat_coverage, iphone_handle_coverage). Local only.
 *
 * Every row is per phone (udid): a replacement or restored phone reuses sms.db
 * chat ROWIDs, so a row from one phone must never describe another's chat (SR D6).
 * The rules that decide WHAT is written live in iphoneCoverageService.ts; this file
 * is the SQL.
 */
import { dbAll, dbGet, dbRun } from "./core/dbConnection";
import { sql } from "./core/sqlText";

export interface IphoneDeviceCoverageRow {
  udid: string;
  coveredSince: string;
  lastSyncAt: string;
  approximate: number;
}

export interface IphoneScanRow {
  key: string;
  coveredSince: string;
  scannedAt: string;
}

/** Every phone's interval for this user. */
export function iphoneDeviceRows(userId: string): IphoneDeviceCoverageRow[] {
  return dbAll<IphoneDeviceCoverageRow>(
    sql`SELECT udid, covered_since AS coveredSince, last_sync_at AS lastSyncAt, approximate
          FROM iphone_device_coverage WHERE user_id = ?`,
    [userId],
  );
}

export function upsertIphoneDevice(userId: string, row: IphoneDeviceCoverageRow): void {
  dbRun(
    sql`INSERT INTO iphone_device_coverage (user_id, udid, covered_since, last_sync_at, approximate, updated_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, udid) DO UPDATE SET
          covered_since = excluded.covered_since,
          last_sync_at = excluded.last_sync_at,
          approximate = excluded.approximate,
          updated_at = CURRENT_TIMESTAMP`,
    [userId, row.udid, row.coveredSince, row.lastSyncAt, row.approximate],
  );
}

/** One phone's per-chat rows (key = chat ROWID as text). */
export function iphoneChatRows(userId: string, udid: string): IphoneScanRow[] {
  return dbAll<IphoneScanRow>(
    sql`SELECT CAST(chat_rowid AS TEXT) AS key, covered_since AS coveredSince, scanned_at AS scannedAt
          FROM iphone_chat_coverage WHERE user_id = ? AND udid = ?`,
    [userId, udid],
  );
}

export function upsertIphoneChat(userId: string, udid: string, chatRowid: number, coveredSince: string, scannedAt: string): void {
  dbRun(
    sql`INSERT INTO iphone_chat_coverage (user_id, udid, chat_rowid, covered_since, scanned_at)
          VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, udid, chat_rowid) DO UPDATE SET
          covered_since = excluded.covered_since, scanned_at = excluded.scanned_at`,
    [userId, udid, chatRowid, coveredSince, scannedAt],
  );
}

/** One phone's per-handle rows (key = handleKeys() key). */
export function iphoneHandleRows(userId: string, udid: string): IphoneScanRow[] {
  return dbAll<IphoneScanRow>(
    sql`SELECT handle_key AS key, covered_since AS coveredSince, scanned_at AS scannedAt
          FROM iphone_handle_coverage WHERE user_id = ? AND udid = ?`,
    [userId, udid],
  );
}

export function upsertIphoneHandle(userId: string, udid: string, handleKey: string, coveredSince: string, scannedAt: string): void {
  dbRun(
    sql`INSERT INTO iphone_handle_coverage (user_id, udid, handle_key, covered_since, scanned_at)
          VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, udid, handle_key) DO UPDATE SET
          covered_since = excluded.covered_since, scanned_at = excluded.scanned_at`,
    [userId, udid, handleKey, coveredSince, scannedAt],
  );
}

/**
 * The one-time upgrader seed (SR D4): the oldest and newest stored iPhone text
 * (`ios-chat-<ROWID>` threads). The thread range reads idx_messages_thread_sent;
 * the caller reads it BEFORE the run's inserts.
 */
export function iphoneStoredTextSpan(userId: string): { floor: string | null; last: string | null; n: number } | undefined {
  return dbGet<{ floor: string | null; last: string | null; n: number }>(
    sql`SELECT MIN(sent_at) AS floor, MAX(sent_at) AS last, COUNT(*) AS n
          FROM messages
         WHERE thread_id >= 'ios-chat-' AND thread_id < 'ios-chat.'
           AND user_id = ? AND sent_at IS NOT NULL`,
    [userId],
  );
}

/** Phones and emails of the contacts on ONE transaction (the D2 members). */
export function transactionContactHandles(userId: string, transactionId: string): string[] {
  const rows = dbAll<{ handle: string }>(
    sql`SELECT cp.phone_e164 AS handle
          FROM transaction_contacts tc
          JOIN transactions t ON t.id = tc.transaction_id
          JOIN contacts c ON c.id = tc.contact_id
          JOIN contact_phones cp ON cp.contact_id = tc.contact_id
         WHERE t.id = ? AND t.user_id = ?
           AND tc.removed_at IS NULL AND c.removed_at IS NULL
           AND cp.phone_e164 IS NOT NULL AND cp.phone_e164 != ''
        UNION
        SELECT LOWER(ce.email) AS handle
          FROM transaction_contacts tc
          JOIN transactions t ON t.id = tc.transaction_id
          JOIN contacts c ON c.id = tc.contact_id
          JOIN contact_emails ce ON ce.contact_id = tc.contact_id
         WHERE t.id = ? AND t.user_id = ?
           AND tc.removed_at IS NULL AND c.removed_at IS NULL
           AND ce.email IS NOT NULL AND ce.email != ''`,
    [transactionId, userId, transactionId, userId],
  );
  return rows.map((r) => r.handle);
}

/** iPhone threads (`ios-chat-<ROWID>`) linked to ONE transaction, as chat ROWIDs. */
export function transactionLinkedIosChats(userId: string, transactionId: string): number[] {
  const rows = dbAll<{ threadId: string }>(
    sql`SELECT DISTINCT COALESCE(m.thread_id, co.thread_id) AS threadId
          FROM communications co
          LEFT JOIN messages m ON m.id = co.message_id
         WHERE co.user_id = ? AND co.transaction_id = ?
           AND COALESCE(m.thread_id, co.thread_id) LIKE 'ios-chat-%'`,
    [userId, transactionId],
  );
  const out: number[] = [];
  for (const r of rows) {
    const id = Number(r.threadId.slice("ios-chat-".length));
    if (Number.isInteger(id)) out.push(id);
  }
  return out;
}
