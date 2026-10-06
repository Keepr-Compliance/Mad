/**
 * SQL for audit coverage floors — BACKLOG-3044.
 *
 * Moved out of `electron/services/auditCoverageService.ts` (3 sites), which answers
 * "how far back does our record actually go" for messages, email and a transaction's
 * own window.
 *
 * Text is byte-identical to what it replaced, verified by
 * `scripts/ci/sql-move-identity.mjs`. The interior indentation of
 * `MESSAGES_FLOOR_SQL` is the original's and is not to be tidied — see that file's
 * note; the whitespace is what the control hashes.
 */

import { sql } from "./core/sqlText";
import { reactionExclusion } from "./reactionExclusion";

/**
 * The oldest message we hold for a user, which is the floor of the audit window.
 *
 * Three exclusions, and each is doing distinct work:
 *   - `channel IN ('sms', 'imessage')` — this is the MESSAGE floor, not the email one.
 *   - `duplicate_of IS NULL` — a duplicate row is the same conversation twice; it must
 *     not be able to drag the floor earlier than the original.
 *   - `reactionExclusion("m")` — a tapback is not a message. Interpolated as a
 *     `SafeSql` fragment from `db/reactionExclusion.ts`, so the tag accepts it and the
 *     exclusion rule stays defined in exactly one place.
 *
 * One bound parameter: the user id. Returns `{ floor: null }` when nothing matches,
 * which the caller reads as "no floor" rather than as an error.
 */
export const MESSAGES_FLOOR_SQL = sql`SELECT MIN(m.sent_at) AS floor
         FROM messages m
        WHERE m.user_id = ?
          AND m.channel IN ('sms', 'imessage')
          AND m.duplicate_of IS NULL
          AND ${reactionExclusion("m")}
          AND m.sent_at IS NOT NULL`;

/**
 * How far back each ACTIVE email account has been cached. One bound parameter: user id.
 *
 * Returns one row per active account, not an aggregate, because the caller's rule is
 * "if ANY active account is unbounded there is a gap" — a MAX over the set would hide
 * exactly the account that makes the answer null.
 */
export const EMAIL_SYNC_FLOOR_SQL = sql`SELECT oldest_cached_at FROM email_sync_state WHERE user_id = ? AND phase = 'active'`;

/**
 * A transaction's own dates, for bounding its audit window. Two bound parameters:
 * transaction id, then user id.
 *
 * The `user_id = ?` half is an authorisation check, not a filter — it is what stops a
 * transaction id from another user resolving here.
 */
export const TRANSACTION_WINDOW_SQL = sql`SELECT started_at, created_at, closed_at, status FROM transactions WHERE id = ? AND user_id = ?`;

/**
 * BACKLOG-3663: the floor (oldest text) and the count per text SOURCE, from
 * messages.metadata.source — the same exclusions as MESSAGES_FLOOR_SQL. One
 * bound parameter: user id.
 */
export const MESSAGES_FLOOR_BY_SOURCE_SQL = sql`SELECT src AS source, MIN(sent_at) AS floor, COUNT(*) AS n
         FROM (
           SELECT m.sent_at AS sent_at,
                  CASE CASE WHEN json_valid(m.metadata) THEN json_extract(m.metadata, '$.source') END
                    WHEN 'iphone_sync' THEN 'iphone'
                    WHEN 'macos_messages' THEN 'mac'
                    WHEN 'android_wifi_sync' THEN 'android_companion'
                    WHEN 'gmweb-cache' THEN 'google_messages'
                    WHEN 'google_messages_web' THEN 'google_messages'
                  END AS src
             FROM messages m
            WHERE m.user_id = ?
              AND m.channel IN ('sms', 'imessage')
              AND m.duplicate_of IS NULL
              AND ${reactionExclusion("m")}
              AND m.sent_at IS NOT NULL
         )
        WHERE src IS NOT NULL
        GROUP BY src`;

/** One bound parameter: user id. The recorded coverage per source. */
export const SOURCE_COVERAGE_ROWS_SQL = sql`SELECT source, covered_since AS coveredSince, last_sync_at AS lastSyncAt
         FROM message_source_coverage WHERE user_id = ?`;

/**
 * Parameters: user id, source, covered_since (NULL = unchanged), last_sync_at.
 * covered_since only ever moves EARLIER (a run that did not reach its floor
 * passes NULL and leaves it as it was).
 */
export const SOURCE_COVERAGE_UPSERT_SQL = sql`INSERT INTO message_source_coverage (user_id, source, covered_since, last_sync_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, source) DO UPDATE SET
         last_sync_at = excluded.last_sync_at,
         covered_since = CASE
           WHEN excluded.covered_since IS NULL THEN message_source_coverage.covered_since
           WHEN message_source_coverage.covered_since IS NULL THEN excluded.covered_since
           WHEN excluded.covered_since < message_source_coverage.covered_since THEN excluded.covered_since
           ELSE message_source_coverage.covered_since
         END`;

/** Parameters: user id, source. Force re-import forgets a source's coverage. */
export const SOURCE_COVERAGE_DELETE_SQL = sql`DELETE FROM message_source_coverage WHERE user_id = ? AND source = ?`;
