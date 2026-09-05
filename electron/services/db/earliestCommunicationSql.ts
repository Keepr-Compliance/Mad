/**
 * SQL for a transaction's earliest communication — BACKLOG-3044 PR 4.
 *
 * Moved out of `electron/services/transactionService/getEarliestCommunicationDate.ts`
 * (4 sites). The answer sets the FLOOR of a transaction's audit window: how far back
 * the record of this deal actually goes.
 *
 * ## Why the floor matters more than it looks
 *
 * This is an audit product. A floor that is too LATE silently narrows the window and
 * drops real correspondence out of the export — the failure the user cannot see,
 * because what is missing leaves no trace on screen. So every read here reaches for the
 * earliest thing it can legitimately find, and each exclusion below has to earn itself.
 *
 * Two channels, asked separately: email through `email_participants`, text through
 * `messages`. The caller takes the earlier of the two.
 *
 * ## The separators are `, ` here and `,` in the sibling modules
 *
 * These callers built their placeholder lists with `.join(", ")`; `messageMatchingSql`
 * and `exportHandleSql` used `.join(",")`. `placeholderList`'s default is `, `, so this
 * module takes the default and those pass `sql`,``. It is one character per placeholder
 * and it is the difference between byte-identical and not.
 *
 * Text is byte-identical to what it replaced, verified by
 * `scripts/ci/sql-move-identity.mjs`; all four texts occur exactly once in the tree, so
 * that check's exit code is load-bearing for each.
 */

import { sql } from "./core/sqlText";
import type { SafeSql } from "./core/sqlText";
import { joinFragments, placeholderList } from "./core/sqlFragments";
import { reactionExclusion } from "./reactionExclusion";

/**
 * The distinct email addresses held by a set of contacts. Bound parameters: one contact
 * id per placeholder.
 *
 * `LOWER(email)` because every address comparison in this app is case-folded on both
 * sides; `DISTINCT` because two contacts on the same deal often share an address and
 * the caller wants the address set, not a row count.
 */
export function contactEmailsForContactsSql(contactCount: number): SafeSql {
  const emailPlaceholders = placeholderList(contactCount);
  return sql`SELECT DISTINCT LOWER(email) as email FROM contact_emails WHERE contact_id IN (${emailPlaceholders})`;
}

/**
 * The distinct phone numbers held by a set of contacts, in E.164. Bound parameters: one
 * contact id per placeholder.
 */
export function contactPhonesForContactsSql(contactCount: number): SafeSql {
  const emailPlaceholders = placeholderList(contactCount);
  return sql`SELECT DISTINCT phone_e164 FROM contact_phones WHERE contact_id IN (${emailPlaceholders})`;
}

/**
 * The earliest email involving any of a set of addresses. Bound parameters: the user
 * id, then one address per placeholder.
 *
 * `e.sent_at IS NOT NULL` excludes rows with no timestamp — `MIN` would ignore them
 * anyway, but stating it keeps the floor's definition in the statement rather than in
 * SQLite's aggregate semantics.
 */
export function earliestEmailSql(addressCount: number): SafeSql {
  const placeholders = placeholderList(addressCount);
  return sql`SELECT MIN(e.sent_at) as earliest
       FROM email_participants ep
       JOIN emails e ON e.id = ep.email_id
       WHERE e.user_id = ?
         AND ep.email_address IN (${placeholders})
         AND e.sent_at IS NOT NULL`;
}

/** One `LIKE` arm of the phone predicate. The number itself is BOUND, not spliced. */
const PHONE_LIKE = sql`m.participants_flat LIKE '%' || ? || '%'`;

/**
 * The earliest text message involving any of a set of phone numbers. Bound parameters:
 * the user id, then one phone per `LIKE` arm.
 *
 * The predicate is `n` copies of `PHONE_LIKE` joined by ` OR ` — a placeholder per
 * number, with the numbers in the params array. It reads as a substring match on
 * `participants_flat` because a group text lists several handles in one column.
 *
 * `reactionExclusion("m")` keeps a tapback from setting the floor: a thumbs-up is not
 * the start of a correspondence. `duplicate_of IS NULL` keeps a re-imported copy from
 * doing the same.
 */
export function earliestMessageSql(phoneCount: number): SafeSql {
  const phoneConditions = joinFragments(Array.from({ length: phoneCount }, () => PHONE_LIKE), sql` OR `);
  return sql`SELECT MIN(m.sent_at) as earliest
         FROM messages m
         WHERE m.user_id = ?
           AND m.channel IN ('sms', 'imessage')
           AND m.duplicate_of IS NULL
           AND ${reactionExclusion("m")}
           AND (${phoneConditions})
           AND m.sent_at IS NOT NULL`;
}
