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
import { LIVE_TRANSACTION_SQL_PREDICATE, withLiveTransactionParam } from "./core/transactionEligibilitySql";

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

/** BACKLOG-3892 W3b: the oldest text each phone holds, per udid (no row = unknown). */
export function iphoneDeviceSpanRows(userId: string): Array<{ udid: string; oldestTextAt: string }> {
  return dbAll<{ udid: string; oldestTextAt: string }>(
    sql`SELECT udid, oldest_text_at AS oldestTextAt FROM iphone_device_span WHERE user_id = ?`,
    [userId],
  );
}

export function upsertIphoneDeviceSpan(userId: string, udid: string, oldestTextAt: string, recordedAt: string): void {
  dbRun(
    sql`INSERT INTO iphone_device_span (user_id, udid, oldest_text_at, recorded_at)
          VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, udid) DO UPDATE SET
          oldest_text_at = excluded.oldest_text_at, recorded_at = excluded.recorded_at`,
    [userId, udid, oldestTextAt, recordedAt],
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
 * (`ios-chat-<ROWID>` threads). The caller reads it BEFORE the run's inserts.
 *
 * BACKLOG-3892 R3: no `user_id` term on purpose. With it the planner on a large table picks
 * a full SCAN of messages (every table page, on the main thread); without it the range is
 * answered from idx_messages_thread_sent alone (COVERING INDEX, index pages only). `user_id`
 * is not in that index, so the result is only this user's when the database holds one user:
 * with more than one local user no seed is returned (no seed = under-claim, the safe side).
 */
export function iphoneStoredTextSpan(userId: string): { floor: string | null; last: string | null; n: number } | undefined {
  const users = dbGet<{ n: number }>(sql`SELECT COUNT(*) AS n FROM (SELECT 1 FROM users_local LIMIT 2)`, []);
  if (!users || users.n !== 1) return undefined;
  const only = dbGet<{ id: string }>(sql`SELECT id FROM users_local LIMIT 1`, []);
  if (!only || only.id !== userId) return undefined;
  return dbGet<{ floor: string | null; last: string | null; n: number }>(
    sql`SELECT MIN(sent_at) AS floor, MAX(sent_at) AS last, COUNT(*) AS n
          FROM messages
         WHERE thread_id >= 'ios-chat-' AND thread_id < 'ios-chat.'
           AND sent_at IS NOT NULL`,
    [],
  );
}

/**
 * BACKLOG-3892 W4: the D2 members of ONE transaction with the contact's name — the same
 * rows as transactionContactHandles, plus contacts.display_name (may be "Unknown" or
 * empty: the caller falls back to the handle).
 */
export function transactionContactMembers(userId: string, transactionId: string): Array<{ handle: string; name: string | null }> {
  return dbAll<{ handle: string; name: string | null }>(
    sql`SELECT cp.phone_e164 AS handle, c.display_name AS name
          FROM transaction_contacts tc
          JOIN transactions t ON t.id = tc.transaction_id
          JOIN contacts c ON c.id = tc.contact_id
          JOIN contact_phones cp ON cp.contact_id = tc.contact_id
         WHERE t.id = ? AND t.user_id = ?
           AND tc.removed_at IS NULL AND c.removed_at IS NULL
           AND cp.phone_e164 IS NOT NULL AND cp.phone_e164 != ''
        UNION
        SELECT LOWER(ce.email) AS handle, c.display_name AS name
          FROM transaction_contacts tc
          JOIN transactions t ON t.id = tc.transaction_id
          JOIN contacts c ON c.id = tc.contact_id
          JOIN contact_emails ce ON ce.contact_id = tc.contact_id
         WHERE t.id = ? AND t.user_id = ?
           AND tc.removed_at IS NULL AND c.removed_at IS NULL
           AND ce.email IS NOT NULL AND ce.email != ''`,
    [transactionId, userId, transactionId, userId],
  );
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

/**
 * BACKLOG-3892 S5: one live deal's dates and lock state, for the backfill. undefined =
 * no such live deal for this user (rejected, not this user's, or not there).
 */
export function liveDealBackfillRow(
  userId: string,
  transactionId: string,
): { started_at: string | null; created_at: string | null; closed_at: string | null; submission_status: string | null } | undefined {
  return dbGet(
    sql`SELECT t.started_at, t.created_at, t.closed_at, t.submission_status
          FROM transactions t
         WHERE t.id = ? AND t.user_id = ?
           AND ${LIVE_TRANSACTION_SQL_PREDICATE}`,
    withLiveTransactionParam([transactionId, userId]),
  );
}
