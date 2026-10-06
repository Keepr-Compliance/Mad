/**
 * SR (2026-10-02): per-chat Google Messages coverage and the deal chats.
 *
 * A chat on a live deal is read back to that deal's audit start, even when it
 * is older than the months setting; every other chat keeps the settings
 * floor. This file holds:
 *  - rcs_chat_coverage: how far back ONE chat is known to reach, keyed by its
 *    chat hash (never its conversation id). Effective coverage of a chat =
 *    the earlier of its own row and the source row (message_source_coverage),
 *    so a chat with no row is covered as far as the source says.
 *  - the deal chats: (a) gmweb2 threads linked to a live deal and (b) chats
 *    whose stored people (rcs_chat_people) have a number of a live deal's
 *    contact — with each deal's audit start.
 * Local only; nothing here is sent anywhere.
 */

import { dbAll, dbRun } from "./core/dbConnection";
import { sql } from "./core/sqlText";
import { LIVE_TRANSACTION_SQL_PREDICATE, withLiveTransactionParam } from "./core/transactionEligibilitySql";
import { computeTransactionDateRange } from "../../utils/emailDateRange";

const THREAD_PREFIX = "gmweb2-";

interface DealDatesRow {
  chatHash: string;
  started_at: string | null;
  created_at: string | null;
  closed_at: string | null;
}

/** Each chat's own coverage (ISO), for the given hashes (all of the user's when omitted). */
export function getChatCoverage(userId: string, chatHashes?: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const rows = chatHashes
    ? dbAll<{ chatHash: string; coveredSince: string }>(
      sql`SELECT chat_hash AS chatHash, covered_since AS coveredSince FROM rcs_chat_coverage
           WHERE user_id = ? AND chat_hash IN (SELECT value FROM json_each(?))`,
      [userId, JSON.stringify(chatHashes)],
    )
    : dbAll<{ chatHash: string; coveredSince: string }>(
      sql`SELECT chat_hash AS chatHash, covered_since AS coveredSince FROM rcs_chat_coverage WHERE user_id = ?`,
      [userId],
    );
  for (const r of rows) out.set(r.chatHash, r.coveredSince);
  return out;
}

/**
 * A chat's history was read down to `coveredSinceISO` (inside the commit's
 * transaction). Never moves a chat's coverage later: what is stored stays.
 */
export function recordChatCoverage(userId: string, chatHash: string, coveredSinceISO: string): void {
  dbRun(
    sql`INSERT INTO rcs_chat_coverage (user_id, chat_hash, covered_since, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, chat_hash) DO UPDATE SET
          covered_since = MIN(covered_since, excluded.covered_since),
          updated_at = CURRENT_TIMESTAMP`,
    [userId, chatHash, coveredSinceISO],
  );
}

/** Force re-import: the texts are gone, and so is every chat's coverage. */
export function clearChatCoverage(userId: string): void {
  dbRun(sql`DELETE FROM rcs_chat_coverage WHERE user_id = ?`, [userId]);
}

/** The audit start of a deal row (the one producer every audit reader uses). */
function dealStartMs(row: { started_at: string | null; created_at: string | null; closed_at: string | null }): number | null {
  const ms = computeTransactionDateRange(row).start.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function earliestByChat(rows: readonly DealDatesRow[], into: Map<string, number>): void {
  for (const r of rows) {
    if (!r.chatHash) continue;
    const ms = dealStartMs(r);
    if (ms === null) continue;
    const prev = into.get(r.chatHash);
    if (prev === undefined || ms < prev) into.set(r.chatHash, ms);
  }
}

const LINKED_THREAD_DEALS_SQL = sql`
    SELECT DISTINCT substr(COALESCE(m.thread_id, co.thread_id), 8) AS chatHash,
           t.started_at, t.created_at, t.closed_at
    FROM communications co
    JOIN transactions t ON t.id = co.transaction_id
    LEFT JOIN messages m ON m.id = co.message_id
    WHERE co.user_id = ? AND t.user_id = ?
      AND COALESCE(m.thread_id, co.thread_id) LIKE 'gmweb2-%'
      AND ${LIVE_TRANSACTION_SQL_PREDICATE}`;

const PEOPLE_DEALS_SQL = sql`
    SELECT DISTINCT p.chat_hash AS chatHash, t.started_at, t.created_at, t.closed_at
    FROM rcs_chat_people p
    JOIN contact_phones cp ON cp.phone_e164 = p.number_e164
    JOIN transaction_contacts tc ON tc.contact_id = cp.contact_id
    JOIN contacts c ON c.id = tc.contact_id
    JOIN transactions t ON t.id = tc.transaction_id
    WHERE p.user_id = ? AND t.user_id = ?
      AND tc.removed_at IS NULL AND c.removed_at IS NULL
      AND ${LIVE_TRANSACTION_SQL_PREDICATE}`;

/**
 * Every deal chat Keepr already has, with the earliest audit start of its
 * live deals (epoch ms): (a) threads linked to a live deal, (b) chats whose
 * stored numbers belong to a live deal's contact.
 */
export function dealChatStarts(userId: string): Map<string, number> {
  const out = new Map<string, number>();
  earliestByChat(dbAll<DealDatesRow>(LINKED_THREAD_DEALS_SQL, withLiveTransactionParam([userId, userId])), out);
  earliestByChat(dbAll<DealDatesRow>(PEOPLE_DEALS_SQL, withLiveTransactionParam([userId, userId])), out);
  return out;
}

const NUMBER_DEALS_SQL = sql`
    SELECT DISTINCT '' AS chatHash, t.started_at, t.created_at, t.closed_at
    FROM transaction_contacts tc
    JOIN transactions t ON t.id = tc.transaction_id
    JOIN contacts c ON c.id = tc.contact_id
    JOIN contact_phones cp ON cp.contact_id = tc.contact_id
    WHERE t.user_id = ?
      AND tc.removed_at IS NULL AND c.removed_at IS NULL
      AND cp.phone_e164 IN (SELECT value FROM json_each(?))
      AND ${LIVE_TRANSACTION_SQL_PREDICATE}`;

const THREAD_DEALS_SQL = sql`
    SELECT DISTINCT '' AS chatHash, t.started_at, t.created_at, t.closed_at
    FROM communications co
    JOIN transactions t ON t.id = co.transaction_id
    LEFT JOIN messages m ON m.id = co.message_id
    WHERE co.user_id = ? AND t.user_id = ?
      AND (co.thread_id = ? OR m.thread_id = ?)
      AND ${LIVE_TRANSACTION_SQL_PREDICATE}`;

/**
 * One chat at /match: the earliest audit start of the live deals it belongs
 * to — by the numbers this job saw (a live deal's contact), or by its thread
 * being linked to a live deal. null = no live deal.
 */
export function dealStartForChat(userId: string, chatHash: string, numbers: readonly string[]): number | null {
  let min: number | null = null;
  const take = (rows: readonly DealDatesRow[]): void => {
    for (const r of rows) {
      const ms = dealStartMs(r);
      if (ms !== null && (min === null || ms < min)) min = ms;
    }
  };
  if (numbers.length > 0) {
    take(dbAll<DealDatesRow>(NUMBER_DEALS_SQL, withLiveTransactionParam([userId, JSON.stringify(numbers.slice(0, 50))])));
  }
  const threadId = `${THREAD_PREFIX}${chatHash}`;
  take(dbAll<DealDatesRow>(THREAD_DEALS_SQL, withLiveTransactionParam([userId, userId, threadId, threadId])));
  return min;
}

/**
 * The page's conversation id of each chat (its latest stored text's), for
 * the claim's must-see list. Conversation ids only.
 */
export function latestConversationIds(userId: string, chatHashes: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (chatHashes.length === 0) return out;
  const threads = chatHashes.map((h) => `${THREAD_PREFIX}${h}`);
  const rows = dbAll<{ threadId: string; conversationId: string | null }>(
    sql`SELECT m.thread_id AS threadId,
               json_extract(m.metadata, '$.conversationId') AS conversationId
        FROM messages m
        WHERE m.user_id = ? AND m.thread_id IN (SELECT value FROM json_each(?))
          AND json_valid(m.metadata)
          AND m.sent_at = (SELECT MAX(m2.sent_at) FROM messages m2 WHERE m2.user_id = m.user_id AND m2.thread_id = m.thread_id)`,
    [userId, JSON.stringify(threads)],
  );
  for (const r of rows) {
    if (typeof r.conversationId === "string" && r.conversationId.length > 0) {
      out.set(r.threadId.slice(THREAD_PREFIX.length), r.conversationId);
    }
  }
  return out;
}

/** The gmweb2 chats linked to one transaction (for its coverage). */
export function linkedChatHashes(transactionId: string, userId: string): string[] {
  return dbAll<{ chatHash: string }>(
    sql`SELECT DISTINCT substr(COALESCE(m.thread_id, co.thread_id), 8) AS chatHash
        FROM communications co
        LEFT JOIN messages m ON m.id = co.message_id
        WHERE co.transaction_id = ? AND co.user_id = ?
          AND COALESCE(m.thread_id, co.thread_id) LIKE 'gmweb2-%'`,
    [transactionId, userId],
  ).map((r) => r.chatHash).filter((h) => h.length > 0);
}

// ============================================
// 3671 P3: per-chat read records and the failed run ("Try again")
// ============================================

/** A saved chat was read at `readAtISO` (and down to its floor, or not). Inside the chat's commit. */
export function recordChatRead(userId: string, chatHash: string, readAtISO: string, reachedFloor: boolean): void {
  dbRun(
    sql`INSERT INTO rcs_chat_reads (user_id, chat_hash, read_at, reached_floor) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, chat_hash) DO UPDATE SET read_at = excluded.read_at, reached_floor = excluded.reached_floor`,
    [userId, chatHash, readAtISO, reachedFloor ? 1 : 0],
  );
}

export function getChatRead(userId: string, chatHash: string): { readAt: string; reachedFloor: boolean } | null {
  const rows = dbAll<{ readAt: string; reachedFloor: number }>(
    sql`SELECT read_at AS readAt, reached_floor AS reachedFloor FROM rcs_chat_reads WHERE user_id = ? AND chat_hash = ?`,
    [userId, chatHash],
  );
  return rows.length > 0 ? { readAt: rows[0].readAt, reachedFloor: rows[0].reachedFloor === 1 } : null;
}

/** The user's last run failed (its finished chats were saved): the next run is "Try again". */
export function setFailedRun(userId: string, startedAtISO: string): void {
  dbRun(sql`INSERT OR REPLACE INTO rcs_cache_failed_run (user_id, started_at) VALUES (?, ?)`, [userId, startedAtISO]);
}

export function getFailedRun(userId: string): string | null {
  try {
    const rows = dbAll<{ startedAt: string }>(sql`SELECT started_at AS startedAt FROM rcs_cache_failed_run WHERE user_id = ?`, [userId]);
    return rows.length > 0 ? rows[0].startedAt : null;
  } catch {
    return null; // never blocks a Sync: no "Try again" skipping then
  }
}

export function clearFailedRun(userId: string): void {
  dbRun(sql`DELETE FROM rcs_cache_failed_run WHERE user_id = ?`, [userId]);
}

/** Force re-import: the read records go with the texts. */
export function clearChatReads(userId: string): void {
  dbRun(sql`DELETE FROM rcs_chat_reads WHERE user_id = ?`, [userId]);
}

/**
 * "Try again" (SR): skip a chat read at or after the failed run's start that
 * reached its own floor. Partial / not settled / gap / unrecovered chats are
 * read again.
 */
export function chatDoneInFailedRun(read: { readAt: string; reachedFloor: boolean } | null, failedRunStartISO: string | null): boolean {
  if (!read || !failedRunStartISO || !read.reachedFloor) return false;
  const at = Date.parse(read.readAt);
  const start = Date.parse(failedRunStartISO);
  return Number.isFinite(at) && Number.isFinite(start) && at >= start;
}
