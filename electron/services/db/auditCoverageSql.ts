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
