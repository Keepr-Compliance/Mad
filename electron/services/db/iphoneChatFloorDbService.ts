/**
 * BACKLOG-3892 S1 — the live deals an iPhone sync must read back to (SR D7).
 *
 * Read-only. Each row carries the deal's date columns so the caller computes the
 * audit start with the ONE producer the export gate uses
 * (computeTransactionDateRange); deals are filtered with the shared live-deal
 * predicate (non-rejected), as the gate does.
 *
 *  - phones / emails: every handle of a contact on a live deal (D7b — email
 *    handles are iMessage chats too);
 *  - linked chats: iPhone threads (`ios-chat-<ROWID>`) already linked to a live
 *    deal, by the communication's thread or its message's thread (D7e).
 */
import { dbAll } from "./core/dbConnection";
import { sql } from "./core/sqlText";
import { LIVE_TRANSACTION_SQL_PREDICATE, withLiveTransactionParam } from "./core/transactionEligibilitySql";

export interface DealDates {
  started_at: string | null;
  created_at: string | null;
  closed_at: string | null;
}

export interface DealHandleRow extends DealDates {
  handle: string;
}

export interface DealThreadRow extends DealDates {
  threadId: string;
}

/** The iPhone thread id prefix (iPhoneSyncStorageService: `ios-chat-<chat ROWID>`). */
export const IOS_CHAT_THREAD_PREFIX = "ios-chat-";

const DEAL_PHONES_SQL = sql`
    SELECT DISTINCT cp.phone_e164 AS handle, t.started_at, t.created_at, t.closed_at
    FROM transaction_contacts tc
    JOIN transactions t ON t.id = tc.transaction_id
    JOIN contacts c ON c.id = tc.contact_id
    JOIN contact_phones cp ON cp.contact_id = tc.contact_id
    WHERE t.user_id = ?
      AND tc.removed_at IS NULL AND c.removed_at IS NULL
      AND cp.phone_e164 IS NOT NULL AND cp.phone_e164 != ''
      AND ${LIVE_TRANSACTION_SQL_PREDICATE}`;

const DEAL_EMAILS_SQL = sql`
    SELECT DISTINCT LOWER(ce.email) AS handle, t.started_at, t.created_at, t.closed_at
    FROM transaction_contacts tc
    JOIN transactions t ON t.id = tc.transaction_id
    JOIN contacts c ON c.id = tc.contact_id
    JOIN contact_emails ce ON ce.contact_id = tc.contact_id
    WHERE t.user_id = ?
      AND tc.removed_at IS NULL AND c.removed_at IS NULL
      AND ce.email IS NOT NULL AND ce.email != ''
      AND ${LIVE_TRANSACTION_SQL_PREDICATE}`;

const LINKED_IOS_THREADS_SQL = sql`
    SELECT DISTINCT COALESCE(m.thread_id, co.thread_id) AS threadId,
           t.started_at, t.created_at, t.closed_at
    FROM communications co
    JOIN transactions t ON t.id = co.transaction_id
    LEFT JOIN messages m ON m.id = co.message_id
    WHERE co.user_id = ? AND t.user_id = ?
      AND COALESCE(m.thread_id, co.thread_id) LIKE 'ios-chat-%'
      AND ${LIVE_TRANSACTION_SQL_PREDICATE}`;

/** Phones and emails of every contact on a live deal, with that deal's dates. */
export function dealHandleRows(userId: string): DealHandleRow[] {
  return [
    ...dbAll<DealHandleRow>(DEAL_PHONES_SQL, withLiveTransactionParam([userId])),
    ...dbAll<DealHandleRow>(DEAL_EMAILS_SQL, withLiveTransactionParam([userId])),
  ];
}

/** iPhone threads linked to a live deal, with that deal's dates. */
export function linkedIosThreadRows(userId: string): DealThreadRow[] {
  return dbAll<DealThreadRow>(LINKED_IOS_THREADS_SQL, withLiveTransactionParam([userId, userId]));
}
