/**
 * SQL for matching messages to a transaction — BACKLOG-3044 PR 4.
 *
 * Moved out of `electron/services/messageMatchingService.ts` (15 sites), the largest
 * single block remaining outside the layer after `autoLinkService`.
 *
 * ## The three-way exclusion these candidate reads all share
 *
 * A message is offered as a candidate only when it is none of: already linked to THIS
 * transaction, previously REJECTED for it, or part of a thread rejected for it. That is
 * the meaning of the three `NOT IN` blocks — against `communications`, against
 * `ignored_communications.original_communication_id`, and against
 * `ignored_communications.thread_id`. BACKLOG-1560 added them as SQL-level suppression
 * on top of the JavaScript filter that runs afterwards, deliberately belt-and-braces:
 * re-offering something the user has already turned down is the failure that makes a
 * review queue feel broken.
 *
 * The thread arm carries `m.thread_id IS NULL OR m.thread_id = ''` in front of its
 * `NOT IN`, because `NOT IN` against a set containing NULL yields NULL — not TRUE — and
 * a one-to-one message with no thread would otherwise vanish from every candidate list.
 *
 * ## `messagesForPhoneMatchingSql` takes BOOLEANS, and that is the whole design
 *
 * Its statement ends with an optional date filter that the caller assembles beside its
 * `params.push(...)` calls:
 *
 *     if (options?.startDate) { dateFilter += " AND m.sent_at >= ?"; params.push(startDate); }
 *     if (options?.endDate)   { dateFilter += " AND m.sent_at <= ?"; params.push(end); }
 *
 * **The clause and its bound value are one contract, and the ORDER is the contract.**
 * BACKLOG-3103's body states the hazard exactly: a fragment carrying its own bound
 * parameter has to compose into the caller's params array in the right position, and
 * getting it wrong silently shifts every later `?`.
 *
 * So this builder takes the two BOOLEANS and returns finished text. The `params` array
 * stays in the caller, in its existing order, untouched — only the TEXT moved. The
 * alternative, exporting ` AND m.sent_at >= ?` for the caller to concatenate, does not
 * work: two `SafeSql` values concatenated are a `string`, so the caller would need the
 * tag, and would be authoring SQL outside the layer again — invisible to both the
 * ratchet and the gate. A green number bought by moving the problem.
 *
 * **Required parameter order**, stated here because the statement is here:
 * `[userId, transactionId, transactionId, transactionId, transactionId]`, then the
 * start bound if `hasStart`, then the end bound if `hasEnd`.
 *
 * All four combinations of the two booleans are asserted byte-identical against the
 * pre-move text by `__tests__/messageMatchingSql.dateFilter.test.ts` — a builder is
 * byte-identical only if EVERY branch is, and testing one branch tests one branch.
 *
 * ## Separators
 *
 * This module's callers built placeholder lists with `.join(",")` — comma, no space —
 * so every list here passes `sql`,`` rather than taking `placeholderList`'s `, `
 * default. One character per placeholder, and the difference between byte-identical and
 * not.
 */

import { sql } from "./core/sqlText";
import type { SafeSql } from "./core/sqlText";
import { placeholderList } from "./core/sqlFragments";

/** Comma with no space — what this module's callers' `.join(",")` produced. */
const COMMA = sql`,`;

/** The optional date bounds on the text-message candidate read. */
export interface MessageDateWindow {
  /** A lower bound was supplied; its value is bound after the transaction ids. */
  hasStart: boolean;
  /** An upper bound was supplied; its value is bound last. */
  hasEnd: boolean;
}

const SENT_AT_FROM = sql` AND m.sent_at >= ?`;
const SENT_AT_TO = sql` AND m.sent_at <= ?`;
const NO_DATE_FILTER = sql``;

/** The phone numbers on a transaction's contacts. One bound parameter: transaction id. */
export const TRANSACTION_CONTACT_PHONES_SQL = sql`
    SELECT
      tc.contact_id as contactId,
      cp.phone_e164 as phone
    FROM transaction_contacts tc
    JOIN contact_phones cp ON tc.contact_id = cp.contact_id
    WHERE tc.transaction_id = ? AND tc.removed_at IS NULL
  `;

/**
 * Text-message candidates for a transaction. See this file's header for the parameter
 * order — it is not inferable from the text, because the trailing bounds are optional.
 */
export function messagesForPhoneMatchingSql(window: MessageDateWindow): SafeSql {
  let dateFilter = NO_DATE_FILTER;
  if (window.hasStart) dateFilter = sql`${dateFilter}${SENT_AT_FROM}`;
  if (window.hasEnd) dateFilter = sql`${dateFilter}${SENT_AT_TO}`;
  return sql`
    SELECT
      m.id,
      m.participants,
      m.participants_flat,
      m.direction,
      m.channel
    FROM messages m
    WHERE m.user_id = ?
      AND m.channel IN ('sms', 'imessage')
      AND m.duplicate_of IS NULL
      AND (
        m.transaction_id IS NULL
        OR m.transaction_id != ?
      )
      AND m.id NOT IN (
        SELECT message_id FROM communications
        WHERE transaction_id = ? AND message_id IS NOT NULL
      )
      AND m.id NOT IN (
        SELECT ic.original_communication_id FROM ignored_communications ic
        WHERE ic.transaction_id = ? AND ic.original_communication_id IS NOT NULL
      )
      AND (m.thread_id IS NULL OR m.thread_id = '' OR m.thread_id NOT IN (
        SELECT ic.thread_id FROM ignored_communications ic
        WHERE ic.transaction_id = ? AND ic.thread_id IS NOT NULL
      ))${dateFilter}
  `;
}

/** Is this message already linked to this transaction? Bound: message id, transaction id. */
export const EXISTING_COMMUNICATION_SQL = sql`
    SELECT id FROM communications
    WHERE message_id = ? AND transaction_id = ?
  `;

/**
 * Does this message exist? One bound parameter: message id.
 *
 * `MESSAGE_ID_EXISTS_SQL`, not `MESSAGE_EXISTS_SQL`: `db/messageImportSql.ts:92` already
 * exports that name for `SELECT 1 FROM messages WHERE id = ?` — a DIFFERENT statement.
 * Two statements under one name is a reader trap, so this one is qualified by what it
 * selects.
 */
export const MESSAGE_ID_EXISTS_SQL = sql`SELECT id FROM messages WHERE id = ?`;

/**
 * Link a message to a transaction. Bound, in order: id, user id, transaction id,
 * message id, link source, link confidence. `linked_at` is the database clock.
 */
export const INSERT_COMMUNICATION_SQL = sql`
    INSERT INTO communications (
      id, user_id, transaction_id, message_id,
      link_source, link_confidence, linked_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `;

/** Subjects and bodies for a batch of messages. Bound: one message id per placeholder. */
export function messageBodiesSql(idCount: number): SafeSql {
  const placeholders = placeholderList(idCount, COMMA);
  return sql`
      SELECT id, subject, body_text
      FROM messages
      WHERE id IN (${placeholders})
    `;
}

/**
 * A transaction's window, for the text path. One bound parameter: transaction id.
 *
 * `TRANSACTION_TEXT_WINDOW_SQL`, not `TRANSACTION_WINDOW_SQL`: `db/auditCoverageSql.ts:55`
 * already exports that name for a different statement (it also selects `created_at` and
 * `status`, and scopes by `user_id`). Same name, two statements, is exactly the trap
 * BACKLOG-3044 PR 3 was sent back for.
 */
export const TRANSACTION_TEXT_WINDOW_SQL = sql`SELECT user_id, started_at, closed_at FROM transactions WHERE id = ?`;

/** A message's thread. One bound parameter: message id. */
export const MESSAGE_THREAD_ID_SQL = sql`SELECT thread_id FROM messages WHERE id = ?`;

/**
 * Claim a batch of messages for a transaction at PATTERN confidence 0.9. Bound: the
 * transaction id, then one message id per placeholder.
 *
 * `AND transaction_id IS NULL` makes the write a claim rather than a reassignment — a
 * message already attached to another deal is left alone. That is what stops a
 * pattern match from silently moving correspondence between transactions.
 *
 * Kept separate from `claimMessagesForTransactionSql085` below rather than taking the
 * confidence as a parameter: the two texts differ (`0.9` vs `0.85`), and parameterising
 * would change both statements to save one constant.
 */
export function claimMessagesForTransactionSql09(idCount: number): SafeSql {
  const placeholders = placeholderList(idCount, COMMA);
  return sql`
        UPDATE messages
        SET transaction_id = ?, transaction_link_source = 'pattern', transaction_link_confidence = 0.9
        WHERE id IN (${placeholders}) AND transaction_id IS NULL
      `;
}

/** The email addresses on a transaction's contacts. One bound parameter: transaction id. */
export const TRANSACTION_CONTACT_EMAILS_SQL = sql`
    SELECT
      tc.contact_id as contactId,
      ce.email as email
    FROM transaction_contacts tc
    JOIN contact_emails ce ON tc.contact_id = ce.contact_id
    WHERE tc.transaction_id = ? AND tc.removed_at IS NULL
  `;

/**
 * Email-channel candidates for a transaction. Bound: user id, then the transaction id
 * twice.
 *
 * Note this one carries only the `communications` exclusion, not the two
 * `ignored_communications` arms the text read has. That asymmetry is the base's and is
 * preserved rather than tidied — evening it up would change the statement and alter
 * which emails are offered.
 */
export const EMAIL_CHANNEL_CANDIDATES_SQL = sql`
    SELECT
      m.id,
      m.sender,
      m.recipients,
      m.direction,
      m.channel
    FROM messages m
    WHERE m.user_id = ?
      AND m.channel = 'email'
      AND m.duplicate_of IS NULL
      AND (
        m.transaction_id IS NULL
        OR m.transaction_id != ?
      )
      AND m.id NOT IN (
        SELECT message_id FROM communications
        WHERE transaction_id = ? AND message_id IS NOT NULL
      )
  `;

/**
 * A transaction's address fields, for the email path's address filter. One bound
 * parameter: transaction id.
 *
 * `skip_address_filter` is selected because a deal can opt out of address matching
 * entirely; the caller must be able to see that rather than infer it.
 */
export const TRANSACTION_ADDRESS_SQL = sql`SELECT user_id, property_address, property_street, skip_address_filter FROM transactions WHERE id = ?`;

/**
 * Which of a set of already-rejected emails carries this provider id. Bound: the
 * external id, then one email id per placeholder.
 *
 * The base spelled this with `+` concatenation rather than a template. The text is
 * unchanged; only the way it is assembled is.
 */
export function ignoredEmailsByExternalIdSql(idCount: number): SafeSql {
  const placeholders = placeholderList(idCount, COMMA);
  return sql`SELECT id FROM emails WHERE external_id = ? AND id IN (${placeholders})`;
}

/**
 * Claim a batch of messages at PATTERN confidence 0.85 — the email path's lower bar.
 * Bound: transaction id, then one message id per placeholder. See the 0.9 twin above
 * on why `AND transaction_id IS NULL` is load-bearing and why these are two constants.
 */
export function claimMessagesForTransactionSql085(idCount: number): SafeSql {
  const placeholders = placeholderList(idCount, COMMA);
  return sql`
        UPDATE messages
        SET transaction_id = ?, transaction_link_source = 'pattern', transaction_link_confidence = 0.85
        WHERE id IN (${placeholders}) AND transaction_id IS NULL
      `;
}
