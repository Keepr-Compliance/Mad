/**
 * SQL for the "removed from this deal" lists — BACKLOG-3044 PR 4.
 *
 * Moved out of `electron/handlers/emailLinkingHandlers.ts` (2 sites). These back the
 * screen that shows what a user has taken OFF a transaction, so they can put it back.
 *
 * ## Both reach a removal through TWO routes, and that is the load-bearing part
 *
 * `ignored_communications` records a removal either by the thing itself
 * (`thread_id` / `email_id`) or by the communication row that used to link it
 * (`original_communication_id`). A row removed before that column existed has only the
 * first; a row removed through the review queue has the second. Each `JOIN` below
 * therefore carries an `OR` over both, and dropping either arm makes a class of
 * removed items **invisible on the restore screen** — the user cannot restore what the
 * list does not show, and nothing errors.
 *
 * The two inline comments about `(user_id, thread_id)` being the primary key are the
 * original's and are kept verbatim: joining `message_thread_names` on `thread_id` alone
 * would put one user's group name on another user's conversation.
 *
 * Text is byte-identical to what it replaced, verified by
 * `scripts/ci/sql-move-identity.mjs`. Both statements' text occurs exactly once in the
 * tree, so that check's exit code is load-bearing for both.
 */

import { sql } from "./core/sqlText";

/**
 * Text messages removed from a transaction, newest removal first. One bound parameter:
 * the transaction id.
 *
 * `AND m.id IS NOT NULL` turns the `LEFT JOIN` into an inner one at the point of use.
 * The join stays LEFT so the two-route `OR` above it can be read on its own terms; the
 * predicate then drops removals whose message no longer exists, which cannot be
 * restored and must not be offered.
 */
export const REMOVED_MESSAGES_SQL = sql`
        SELECT DISTINCT
          ic.id as ignored_id,
          ic.thread_id as ic_thread_id,
          ic.reason,
          ic.ignored_at,
          m.id as message_id,
          m.body_text as body,
          m.subject,
          m.channel,
          m.thread_id,
          m.sent_at,
          m.received_at,
          m.participants,
          m.participants_flat,
          m.direction,
          -- BACKLOG-2814: the group's user-visible name, so a removed group
          -- conversation is identified the same way it was before removal.
          tn.display_name as thread_display_name
        FROM ignored_communications ic
        LEFT JOIN messages m ON (
          (ic.thread_id IS NOT NULL AND ic.thread_id != '' AND m.thread_id = ic.thread_id)
          OR (ic.original_communication_id IS NOT NULL AND m.id = ic.original_communication_id)
        )
        -- BACKLOG-2814: (user_id, thread_id) is the table's PK; joining on
        -- thread_id alone would leak one user's group name onto another's.
        LEFT JOIN message_thread_names tn ON (
          tn.thread_id = m.thread_id AND tn.user_id = m.user_id
        )
        WHERE ic.transaction_id = ?
        AND m.id IS NOT NULL
        ORDER BY ic.ignored_at DESC, m.sent_at DESC
      `;

/**
 * Emails removed from a transaction, newest removal first. One bound parameter: the
 * transaction id.
 *
 * `SUBSTR(e.body_plain, 1, 200) as body_preview` is computed in SQLite rather than in
 * JavaScript, and the full `body_plain` is selected beside it — the card shows the
 * preview, the reading modal needs the whole body, and one read serves both.
 *
 * `ic.match_reason` is selected because `classifyRemoval` reads it to decide where a
 * Restore puts the email back; it is part of the removal's identity, not decoration.
 */
export const REMOVED_EMAILS_SQL = sql`
        SELECT DISTINCT
          ic.id as ignored_id,
          ic.email_id as ic_email_id,
          ic.reason,
          -- BACKLOG-2831: part of the identity a duplicate is collapsed on, and
          -- half of what classifyRemoval reads to decide where a Restore goes.
          ic.match_reason,
          ic.ignored_at,
          e.id as email_id,
          e.subject,
          e.sender,
          e.recipients,
          e.cc,
          e.sent_at,
          e.thread_id,
          SUBSTR(e.body_plain, 1, 200) as body_preview,
          e.body_plain,
          e.has_attachments,
          e.source
        FROM ignored_communications ic
        JOIN emails e ON (
          (ic.email_id IS NOT NULL AND ic.email_id = e.id)
          OR (ic.original_communication_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM communications c
                          WHERE c.id = ic.original_communication_id AND c.email_id = e.id))
        )
        WHERE ic.transaction_id = ?
        AND e.id IS NOT NULL
        ORDER BY ic.ignored_at DESC
      `;
