/**
 * BACKLOG-4017: hide a chat from ONE deal's attach-texts picker once that chat is
 * linked to that deal at thread level.
 *
 * A thread-level link is a `communications` row with `thread_id` set and both
 * `message_id` and `email_id` NULL (written by
 * `createThreadCommunicationReference`, the auto-link of a whole chat). It never
 * sets `messages.transaction_id`, so the picker's `transaction_id IS NULL` test
 * alone keeps offering texts the deal already shows — including every text a later
 * sync adds to that chat.
 *
 * Scope (founder decision, BACKLOG-4017): PER DEAL. The row must name the deal the
 * picker is open on; a chat linked to deal A stays attachable to deal B. The
 * contact roster is deliberately NOT filtered (it is cached per user, not per deal).
 *
 * Each term matches the partial unique index `idx_comm_thread_txn`
 * (thread_id, transaction_id) WHERE thread_id IS NOT NULL AND message_id IS NULL
 * AND email_id IS NULL. A text with `thread_id` NULL is never hidden (NULL never
 * equals anything). `email_id IS NULL` keeps an email link row carrying the same
 * thread id from hiding texts.
 *
 * The fragment carries ONE positional parameter, the open deal's id. Callers put it
 * last in the WHERE clause and bind the deal id last.
 */

import { sql, type SafeSql } from "./core/sqlText";

/**
 * The `messages` qualifiers this predicate is written for. A CLOSED set, not a
 * `string`: an alias is an identifier and cannot be bound. The qualifier is
 * REQUIRED — an unqualified `thread_id` inside the subquery would resolve to
 * `c.thread_id` and silently match every thread row of the deal.
 */
export type TextThreadLinkAlias = "m" | "messages";

const QUALIFIER: Record<TextThreadLinkAlias, SafeSql> = {
  m: sql`m.`,
  messages: sql`messages.`,
};

/**
 * `NOT EXISTS (...)`: TRUE when the row's chat has no thread-level link to the
 * deal bound at the single `?`.
 */
export function notInDealTextThread(alias: TextThreadLinkAlias): SafeSql {
  const q = QUALIFIER[alias];
  return sql`NOT EXISTS (SELECT 1 FROM communications c WHERE c.thread_id = ${q}thread_id AND c.message_id IS NULL AND c.email_id IS NULL AND +c.user_id = ${q}user_id AND c.transaction_id = ?)`;
}
