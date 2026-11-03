/**
 * SQL for transaction checklists — BACKLOG-3475.
 *
 * ## The template is copied, never referenced
 *
 * `transaction_checklists.template_id` records which broker template a
 * checklist came from. **No statement in this file joins through it.** Every
 * title, required flag and expected document type is read from
 * `transaction_checklist_items`, which holds the values as they were when the
 * user picked the template. Editing or deleting the broker template therefore
 * cannot rewrite a checklist already in use, and cannot make an item the user
 * already ticked disappear.
 *
 * ## Evidence is a GROUP of ids, and there is no thread_id anywhere
 *
 * An email link is the SET of its members' `email_id`s; a single email is a
 * group of one. The obvious alternative — key the link on `emails.thread_id`
 * and expand it at read time — is wrong twice over. `thread_id` is nullable at
 * both producers (Gmail stores `threadId || ""` as NULL, Outlook's
 * `conversationId` likewise), so a thread-keyed link silently matches nothing
 * for those rows; and the conversation UI groups by SUBJECT while the database
 * keys on `thread_id`, so "the thread the user saw" and "the rows a thread_id
 * query returns" are not the same set.
 *
 * ## A target is verified against the transaction, never trusted
 *
 * `LINK_TARGETS_NOT_IN_TRANSACTION_SQL` is the one statement standing between
 * a renderer-supplied id and a link row. It returns the ids that are NOT
 * evidence of the item's transaction, and the caller refuses the whole write if
 * that list is non-empty. The email arm matches `communications.email_id`; the
 * attachment arm is the two joins of `submissionDbService.getTransactionAttachments`
 * (text attachments through `messages`, email attachments through `emails`)
 * **minus the audit-date filter and minus the `storage_path IS NOT NULL`
 * filter**: those two narrow an EXPORT to what can be uploaded, while this asks
 * only whether the attachment belongs to this transaction at all. An attachment
 * with no `storage_path` is still the user's evidence; it is the submission
 * snapshot's job to skip it later, not this one's.
 */

import { sql } from "./core/sqlText";
import { placeholderList } from "./core/sqlFragments";
import { NOT_PRIVATE_CHECKLIST_SQL } from "./checklistPrivacy";
import type { SafeSql } from "./core/sqlText";
import type { ChecklistLinkKind, ChecklistLinkWriteKind } from "../../types/checklist";

/** Does this transaction exist? One bound parameter. */
export const TRANSACTION_EXISTS_SQL = sql`
  SELECT id FROM transactions WHERE id = ?
`;

/**
 * Every checklist on one transaction, in display order (BACKLOG-3476). One
 * bound parameter.
 */
export const GET_CHECKLISTS_BY_TRANSACTION_SQL = sql`
  SELECT id, transaction_id, template_id, template_name, sort_order, selected_at
  FROM transaction_checklists
  WHERE transaction_id = ?
  ORDER BY sort_order, selected_at, id
`;

/**
 * BACKLOG-3966: as {@link GET_CHECKLISTS_BY_TRANSACTION_SQL}, without the
 * private checklist — what a broker-facing reader may see. One bound
 * parameter: the transaction id.
 */
export const GET_BROKER_CHECKLISTS_BY_TRANSACTION_SQL = sql`
  SELECT cl.id, cl.transaction_id, cl.template_id, cl.template_name, cl.sort_order, cl.selected_at
  FROM transaction_checklists cl
  WHERE cl.transaction_id = ? AND ${NOT_PRIVATE_CHECKLIST_SQL}
  ORDER BY cl.sort_order, cl.selected_at, cl.id
`;

/**
 * One checklist, only if it belongs to this transaction. Two bound
 * parameters, in order: checklist id, transaction id. The remove path goes
 * through this, so an id from another transaction is never acted on.
 */
export const GET_CHECKLIST_IN_TRANSACTION_SQL = sql`
  SELECT id, transaction_id, template_id, template_name, sort_order, selected_at
  FROM transaction_checklists
  WHERE id = ? AND transaction_id = ?
`;

/**
 * The checklist on this transaction that came from this template, if any. Two
 * bound parameters, in order: transaction id, template id. A template may be
 * on a transaction once.
 */
export const GET_CHECKLIST_BY_TEMPLATE_SQL = sql`
  SELECT id FROM transaction_checklists
  WHERE transaction_id = ? AND template_id = ?
`;

/** Next free display position on one transaction. One bound parameter. */
export const NEXT_CHECKLIST_SORT_ORDER_SQL = sql`
  SELECT COALESCE(MAX(sort_order) + 1, 0) AS next_sort_order
  FROM transaction_checklists
  WHERE transaction_id = ?
`;

/**
 * Insert one checklist. Five bound parameters: id, transaction id, template id,
 * template name, sort_order.
 */
export const INSERT_CHECKLIST_SQL = sql`
  INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name, sort_order)
  VALUES (?, ?, ?, ?, ?)
`;

/**
 * Insert one copied item. Seven bound parameters, in order: id, checklist id,
 * title, description, is_required, expected_document_type, sort_order.
 *
 * `is_checked` and `checked_at` take their defaults (0 / NULL), which is the
 * only combination the paired CHECK accepts for a fresh row.
 */
export const INSERT_CHECKLIST_ITEM_SQL = sql`
  INSERT INTO transaction_checklist_items
    (id, checklist_id, title, description, is_required, expected_document_type, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Delete ONE checklist of one transaction; its items, links and members follow
 * by cascade. Two bound parameters, in order: checklist id, transaction id.
 *
 * BACKLOG-3966: never the private checklist ("My items"). The agent takes his
 * own items off one at a time; neither `checklists:remove` nor a review pull
 * may delete the row. Its only other way out is the deal itself being deleted
 * (the transactions FK cascade).
 * There is deliberately no statement that deletes by transaction alone: every
 * other checklist on the transaction must survive a remove. This is the ONLY
 * statement in this file that deletes a `transaction_checklists` row
 * (BACKLOG-3476 round 2: Change is gone, so `selectChecklistTemplate` never
 * deletes).
 */
export const DELETE_CHECKLIST_IN_TRANSACTION_SQL = sql`
  DELETE FROM transaction_checklists AS cl
  WHERE cl.id = ? AND cl.transaction_id = ? AND ${NOT_PRIVATE_CHECKLIST_SQL}
`;

// ---------------------------------------------------------------------------
// The private checklist ("My items") — BACKLOG-3966 PR-2
// ---------------------------------------------------------------------------
//
// The reserved template id is BOUND as a parameter in every statement below
// (the caller passes MY_ITEMS_TEMPLATE_ID), so `checklistPrivacy.ts` stays the
// only file that spells it.

/**
 * Create the private checklist of one deal unless it already has one. Five
 * bound parameters: id, transaction id, reserved template id, template name,
 * sort_order. UNIQUE (transaction_id, template_id) makes a second call change
 * nothing; the caller then reads the existing row's id.
 */
export const INSERT_PRIVATE_CHECKLIST_SQL = sql`
  INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name, sort_order)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (transaction_id, template_id) DO NOTHING
`;

/** Next free sort_order among one checklist's items. One bound parameter: checklist id. */
export const NEXT_ITEM_SORT_ORDER_SQL = sql`
  SELECT COALESCE(MAX(sort_order) + 1, 0) AS next_sort_order
  FROM transaction_checklist_items
  WHERE checklist_id = ?
`;

/**
 * Rename one item, only if it is on THIS deal's private checklist. Four bound
 * parameters, in order: title, item id, transaction id, reserved template id.
 * Aimed at a template item, it changes nothing.
 */
export const RENAME_PRIVATE_ITEM_SQL = sql`
  UPDATE transaction_checklist_items SET title = ?
  WHERE id = ?
    AND checklist_id IN (
      SELECT id FROM transaction_checklists WHERE transaction_id = ? AND template_id = ?
    )
`;

/**
 * Delete one item, only if it is on THIS deal's private checklist; its links
 * and members follow by cascade. Three bound parameters, in order: item id,
 * transaction id, reserved template id. Aimed at a template item, it deletes
 * nothing.
 */
export const DELETE_PRIVATE_ITEM_SQL = sql`
  DELETE FROM transaction_checklist_items
  WHERE id = ?
    AND checklist_id IN (
      SELECT id FROM transaction_checklists WHERE transaction_id = ? AND template_id = ?
    )
`;

/**
 * The items of THIS deal's private checklist, in display order. Two bound
 * parameters, in order: transaction id, reserved template id.
 */
export const GET_PRIVATE_ITEM_IDS_SQL = sql`
  SELECT i.id, i.checklist_id
  FROM transaction_checklist_items i
  JOIN transaction_checklists c ON c.id = i.checklist_id
  WHERE c.transaction_id = ? AND c.template_id = ?
  ORDER BY i.sort_order, i.id
`;

/**
 * Move one item of a checklist. Three bound parameters, in order: sort_order,
 * item id, checklist id.
 */
export const SET_ITEM_SORT_ORDER_SQL = sql`
  UPDATE transaction_checklist_items SET sort_order = ? WHERE id = ? AND checklist_id = ?
`;

/** Every item of one checklist, in display order. One bound parameter. */
export const GET_CHECKLIST_ITEMS_SQL = sql`
  SELECT id, checklist_id, title, description, is_required,
         expected_document_type, is_checked, checked_at, note, sort_order
  FROM transaction_checklist_items
  WHERE checklist_id = ?
  ORDER BY sort_order, id
`;

/**
 * Every evidence group of one checklist, in display order. One bound parameter
 * (the checklist id).
 */
export const GET_CHECKLIST_LINKS_SQL = sql`
  SELECT l.id, l.item_id, l.kind, l.label, l.sort_order, l.include_outside_dates
  FROM transaction_checklist_links l
  JOIN transaction_checklist_items i ON i.id = l.item_id
  WHERE i.checklist_id = ?
  ORDER BY l.item_id, l.sort_order, l.id
`;

/**
 * Every member of one checklist's groups, each carrying whether its target is
 * STILL linked to the transaction. Two bound parameters, in order: checklist
 * id, checklist id.
 *
 * `in_transaction` is 0 when the email or attachment survives but was unlinked
 * from the transaction — stale, not broken, and the surface above renders it as
 * such. A member whose target was DELETED does not appear at all: it cascaded
 * away with the row, which is the force-re-cache behaviour this schema chose
 * deliberately.
 *
 * A text member (BACKLOG-3968) is in the transaction when `communications`
 * names its message by id, or names its thread for the message's own user —
 * the two arms `getTransactionMessages` reads texts by.
 *
 * The attachment arm's second EXISTS carries the same Apple-id fallback as
 * `targetsInTransactionSql` below (BACKLOG-3733): a photo attachment can live
 * on one signed-in user's message copy while the thread link scopes to
 * another user's copy of the same provider thread. `msg.external_id =
 * a.external_message_id` picks up the attachment through the shared Apple
 * guid when `msg` itself owns no direct attachment row.
 */
export const GET_CHECKLIST_LINK_MEMBERS_SQL = sql`
  SELECT m.id, m.link_id, m.kind, m.attachment_id, m.email_id, m.message_id,
         CASE
           WHEN m.email_id IS NOT NULL THEN EXISTS (
             SELECT 1 FROM communications c
             WHERE c.transaction_id = cl.transaction_id AND c.email_id = m.email_id
           )
           WHEN m.message_id IS NOT NULL THEN EXISTS (
             SELECT 1 FROM messages tm
             JOIN communications c4 ON (
               (c4.message_id IS NOT NULL AND c4.message_id = tm.id)
               OR (c4.message_id IS NULL AND c4.thread_id IS NOT NULL AND c4.thread_id = tm.thread_id AND tm.user_id = c4.user_id)
             )
             WHERE tm.id = m.message_id AND c4.transaction_id = cl.transaction_id
           )
           ELSE EXISTS (
             SELECT 1 FROM attachments a
             WHERE a.id = m.attachment_id
               AND (
                 EXISTS (
                   SELECT 1 FROM emails e
                   JOIN communications c2 ON c2.email_id = e.id
                   WHERE e.id = a.email_id AND c2.transaction_id = cl.transaction_id
                 )
                 OR EXISTS (
                   SELECT 1 FROM messages msg
                   JOIN communications c3 ON (
                     (c3.message_id IS NOT NULL AND c3.message_id = msg.id)
                     OR (c3.message_id IS NULL AND c3.thread_id IS NOT NULL AND c3.thread_id = msg.thread_id AND msg.user_id = c3.user_id)
                   )
                   WHERE c3.transaction_id = cl.transaction_id
                     AND (
                       msg.id = a.message_id
                       OR (
                         a.email_id IS NULL
                         AND a.external_message_id IS NOT NULL
                         AND msg.external_id = a.external_message_id
                         AND NOT EXISTS (SELECT 1 FROM attachments d WHERE d.message_id = msg.id)
                       )
                     )
                 )
               )
           )
         END AS in_transaction
  FROM transaction_checklist_link_members m
  JOIN transaction_checklist_links l ON l.id = m.link_id
  JOIN transaction_checklist_items i ON i.id = l.item_id
  JOIN transaction_checklists cl ON cl.id = i.checklist_id
  WHERE i.checklist_id = ? AND cl.id = ?
  ORDER BY m.link_id, m.id
`;

/**
 * Tick or untick one item. Three bound parameters, in order: is_checked (0/1),
 * is_checked again, item id.
 *
 * `checked_at` is written in the SAME statement as `is_checked` and derived
 * from it, so the paired CHECK in schema.sql cannot be reached with the two
 * disagreeing. A second statement setting `checked_at` separately would be a
 * window in which the row is invalid; there is no such window here.
 */
export const SET_CHECKLIST_ITEM_CHECKED_SQL = sql`
  UPDATE transaction_checklist_items
  SET is_checked = ?,
      checked_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END
  WHERE id = ?
`;

/** Set or clear one item's note. Two bound parameters, in order: note, item id. */
export const SET_CHECKLIST_ITEM_NOTE_SQL = sql`
  UPDATE transaction_checklist_items SET note = ? WHERE id = ?
`;

/**
 * The item's checklist and that checklist's transaction (and, BACKLOG-3966,
 * that checklist's template id, which says whether it is the private one).
 * One bound parameter.
 */
export const GET_ITEM_CONTEXT_SQL = sql`
  SELECT i.id AS item_id, c.id AS checklist_id, c.transaction_id, c.template_id
  FROM transaction_checklist_items i
  JOIN transaction_checklists c ON c.id = i.checklist_id
  WHERE i.id = ?
`;

/** Next free sort_order for an item's groups. One bound parameter. */
export const NEXT_LINK_SORT_ORDER_SQL = sql`
  SELECT COALESCE(MAX(sort_order) + 1, 0) AS next_sort_order
  FROM transaction_checklist_links
  WHERE item_id = ?
`;

/**
 * Insert one evidence group. Six bound parameters: id, item id, kind, label,
 * sort_order, include_outside_dates (0/1, BACKLOG-3764).
 */
export const INSERT_CHECKLIST_LINK_SQL = sql`
  INSERT INTO transaction_checklist_links (id, item_id, kind, label, sort_order, include_outside_dates)
  VALUES (?, ?, ?, ?, ?, ?)
`;

/** BACKLOG-3764: the deal's audit dates as stored. One bound parameter. */
export const GET_TRANSACTION_AUDIT_DATES_SQL = sql`
  SELECT started_at, closed_at FROM transactions WHERE id = ?
`;

/**
 * BACKLOG-3764: the agent answered "Include it" at the submit pre-flight. Sets
 * the flag on ONE group, only if it belongs to this transaction. Two bound
 * parameters, in order: link id, transaction id.
 *
 * BACKLOG-3968: never on a text link. The message upload has no
 * outside-the-dates arm, so the flag could not bring a text in; the pre-flight
 * never asks about one.
 */
export const SET_LINK_INCLUDE_OUTSIDE_DATES_SQL = sql`
  UPDATE transaction_checklist_links SET include_outside_dates = 1
  WHERE id = ?
    AND kind <> 'text'
    AND item_id IN (
      SELECT i.id FROM transaction_checklist_items i
      JOIN transaction_checklists c ON c.id = i.checklist_id
      WHERE c.transaction_id = ?
    )
`;

/**
 * BACKLOG-3764 — which of these targets are dated OUTSIDE the deal's audit
 * dates, with the date that puts them there. One `id, sent_at` row per such
 * target.
 *
 * "Inside" is the submit's own test, term for term
 * (`submissionDbService.getTransactionEmails` / `getTransactionAttachments`):
 * `sent_at >= start` when there is a start, `sent_at <= end` when there is an
 * end, with the same bound strings (`auditWindowStart`, `auditWindowEnd`,
 * `toISOString`). A row with no date fails the test the way the submit's
 * filter fails it, so it counts as outside. An email attachment takes its
 * email's date; a text attachment its text's, through `message_id` or, for
 * an Apple-id row, `external_message_id`.
 *
 * Bound parameters, in order: the N target ids, then start, start, end, end
 * (each NULL when the deal has no such date).
 */
export function outsideAuditDatesSql(kind: ChecklistLinkWriteKind, count: number): SafeSql {
  const ids = placeholderList(count);
  if (kind === "email") {
    return sql`
      SELECT id, sent_at FROM (
        SELECT e.id AS id, e.sent_at AS sent_at FROM emails e WHERE e.id IN (${ids})
      ) t
      WHERE NOT COALESCE((? IS NULL OR t.sent_at >= ?) AND (? IS NULL OR t.sent_at <= ?), 0)
      ORDER BY t.sent_at, t.id
    `;
  }
  return sql`
    SELECT id, sent_at FROM (
      SELECT a.id AS id,
             CASE
               WHEN a.email_id IS NOT NULL THEN (SELECT e.sent_at FROM emails e WHERE e.id = a.email_id)
               ELSE COALESCE(
                 (SELECT m.sent_at FROM messages m WHERE m.id = a.message_id),
                 (SELECT mx.sent_at FROM messages mx
                   WHERE a.external_message_id IS NOT NULL AND mx.external_id = a.external_message_id
                   ORDER BY mx.sent_at LIMIT 1)
               )
             END AS sent_at
      FROM attachments a
      WHERE a.id IN (${ids})
    ) t
    WHERE NOT COALESCE((? IS NULL OR t.sent_at >= ?) AND (? IS NULL OR t.sent_at <= ?), 0)
    ORDER BY t.sent_at, t.id
  `;
}

/** Insert one attachment member. Three bound parameters: id, link id, attachment id. */
export const INSERT_ATTACHMENT_MEMBER_SQL = sql`
  INSERT INTO transaction_checklist_link_members (id, link_id, kind, attachment_id)
  VALUES (?, ?, 'attachment', ?)
`;

/** Insert one email member. Three bound parameters: id, link id, email id. */
export const INSERT_EMAIL_MEMBER_SQL = sql`
  INSERT INTO transaction_checklist_link_members (id, link_id, kind, email_id)
  VALUES (?, ?, 'email', ?)
`;

/**
 * Insert one text member (BACKLOG-3968 PR-4b). Three bound parameters: id,
 * link id, `messages.id`.
 */
export const INSERT_TEXT_MEMBER_SQL = sql`
  INSERT INTO transaction_checklist_link_members (id, link_id, kind, message_id)
  VALUES (?, ?, 'text', ?)
`;

/** Delete one evidence group; its members follow by cascade. One bound parameter. */
export const DELETE_CHECKLIST_LINK_SQL = sql`
  DELETE FROM transaction_checklist_links WHERE id = ?
`;

/**
 * The label for an email group: the subject of the EARLIEST member, so a group
 * is named after the message that started it. One bound parameter list.
 */
export function emailLabelSql(count: number): SafeSql {
  return sql`
    SELECT subject FROM emails
    WHERE id IN (${placeholderList(count)})
    ORDER BY COALESCE(sent_at, received_at), id
    LIMIT 1
  `;
}

/**
 * BACKLOG-3968 PR-4b — the date for a text group's label: the EARLIEST
 * member's, as the email label takes the earliest member's subject. A text has
 * no subject; the label is "Text · <date>" (the PDF export's own wording).
 */
export function textLabelSql(count: number): SafeSql {
  return sql`
    SELECT COALESCE(sent_at, received_at) AS sent_at FROM messages
    WHERE id IN (${placeholderList(count)})
    ORDER BY COALESCE(sent_at, received_at), id
    LIMIT 1
  `;
}

/** The label for an attachment group: the first target's filename. */
export function attachmentLabelSql(count: number): SafeSql {
  return sql`
    SELECT filename FROM attachments
    WHERE id IN (${placeholderList(count)})
    ORDER BY created_at, id
    LIMIT 1
  `;
}

/**
 * **The guard on renderer-supplied ids**, stated positively: returns one `id`
 * row for each of these targets that IS evidence of this transaction.
 *
 * The caller subtracts the result from what it was asked for, so an id
 * belonging to another transaction, an id that was unlinked and an id that
 * never existed are all rejected by the same subtraction — no shape of missing
 * row can pass as valid. A "which ones are NOT evidence" query would have to
 * synthesise a row per input id to have something to return, and an input the
 * query failed to synthesise would silently read as accepted.
 *
 * Bound parameters, in order: the N target ids, then the transaction id — once
 * for `email` and `text`, twice for `attachment` (its two arms are independent
 * EXISTS).
 *
 * The text arm (BACKLOG-3968 PR-4b) accepts a `messages` row when
 * `communications` links it to THIS transaction by its id, or links its
 * thread for the message's own user — the same two arms the submit reads texts
 * by (`submissionDbService.getTransactionMessages`) — AND the message belongs
 * to the deal's own user. A text on another deal, another user's copy of a
 * linked thread, or an email-channel row is refused.
 *
 * The email arm is an email attachment's own email linked to the transaction.
 * The text arm accepts an attachment when a message linked to the transaction
 * owns it under the shared text-attachment rule
 * (`textAttachmentLookupSql.ts`, `selectTextAttachmentsForMessages`):
 *   - its `message_id` is that message, or
 *   - it is not an email attachment, its `external_message_id` is that
 *     message's `external_id`, and that message has no attachment row of its
 *     own.
 * The second case is the row whose `message_id` names a message that no longer
 * exists; the Attachments tab lists it under the text, so linking it must pass.
 * Unlike the submit, there is no audit-date or `storage_path` filter: those
 * narrow an EXPORT to what can be uploaded, while this asks only whether the
 * attachment belongs to this transaction at all.
 */
export function targetsInTransactionSql(kind: ChecklistLinkKind, count: number): SafeSql {
  const ids = placeholderList(count);
  if (kind === "text") {
    return sql`
      SELECT DISTINCT tm.id AS id
      FROM messages tm
      JOIN communications c ON (
        (c.message_id IS NOT NULL AND c.message_id = tm.id)
        OR (c.message_id IS NULL AND c.email_id IS NULL AND c.thread_id IS NOT NULL
            AND c.thread_id = tm.thread_id AND tm.user_id = c.user_id)
      )
      JOIN transactions t ON t.id = c.transaction_id
      WHERE tm.id IN (${ids})
        AND c.transaction_id = ?
        AND tm.user_id = t.user_id
        AND COALESCE(tm.channel, '') <> 'email'
    `;
  }
  if (kind === "email") {
    return sql`
      SELECT DISTINCT c.email_id AS id
      FROM communications c
      WHERE c.email_id IN (${ids}) AND c.transaction_id = ?
    `;
  }
  return sql`
    SELECT DISTINCT a.id AS id
    FROM attachments a
    WHERE a.id IN (${ids})
      AND (
        EXISTS (
          SELECT 1 FROM emails e
          JOIN communications c ON c.email_id = e.id
          WHERE e.id = a.email_id AND c.transaction_id = ?
        )
        OR EXISTS (
          SELECT 1 FROM messages m
          JOIN communications c2 ON (
            (c2.message_id IS NOT NULL AND c2.message_id = m.id)
            OR (c2.message_id IS NULL AND c2.thread_id IS NOT NULL AND c2.thread_id = m.thread_id AND m.user_id = c2.user_id)
          )
          WHERE c2.transaction_id = ?
            AND (
              m.id = a.message_id
              OR (
                a.email_id IS NULL
                AND a.external_message_id IS NOT NULL
                AND m.external_id = a.external_message_id
                AND NOT EXISTS (SELECT 1 FROM attachments d WHERE d.message_id = m.id)
              )
            )
        )
      )
  `;
}

/**
 * BACKLOG-3767 — the rows behind a checklist's attachment members, for the PDF
 * export's checklist block. One row per attachment id in the JSON array `?2`.
 *
 * `hidden` is tested against the transaction's WHOLE hide list (`?1`), not the
 * export's in-window subset, matched on the message id and on the Apple guid
 * (either the attachment's own `external_message_id` or the owning message's
 * `external_id`) — the same two arms as the `hidden_from_export` marker in
 * communicationDbService. Email attachments are never hidden.
 */
export const GET_CHECKLIST_EXPORT_ATTACHMENTS_SQL = sql`
  SELECT a.id, a.filename, a.email_id, a.message_id, a.external_message_id,
         msg.external_id AS message_external_id,
         CASE WHEN a.email_id IS NULL AND EXISTS (
           SELECT 1 FROM transaction_hidden_texts h
           WHERE h.transaction_id = ?
             AND (
               (a.message_id IS NOT NULL AND h.message_id = a.message_id)
               OR (h.message_external_id IS NOT NULL
                   AND (h.message_external_id = a.external_message_id
                        OR h.message_external_id = msg.external_id))
             )
         ) THEN 1 ELSE 0 END AS hidden
  FROM json_each(?) j
  JOIN attachments a ON a.id = j.value
  LEFT JOIN messages msg ON msg.id = a.message_id
`;

/**
 * BACKLOG-3968 — the texts behind a checklist's text members, for the PDF
 * export's checklist block. One row per message id in the JSON array `?2`.
 *
 * `hidden` is tested against the transaction's WHOLE hide list (`?1`), on the
 * message id and on the Apple guid (`messages.external_id`) — the same two
 * arms as GET_CHECKLIST_EXPORT_ATTACHMENTS_SQL, so a text re-imported under a
 * new id stays hidden.
 */
export const GET_CHECKLIST_EXPORT_TEXTS_SQL = sql`
  SELECT msg.id, msg.external_id, msg.sent_at,
         CASE WHEN EXISTS (
           SELECT 1 FROM transaction_hidden_texts h
           WHERE h.transaction_id = ?
             AND (
               h.message_id = msg.id
               OR (h.message_external_id IS NOT NULL AND h.message_external_id = msg.external_id)
             )
         ) THEN 1 ELSE 0 END AS hidden
  FROM json_each(?) j
  JOIN messages msg ON msg.id = j.value
`;

/** BACKLOG-3767 — subjects for a checklist's email members (JSON array of ids). */
export const GET_CHECKLIST_EXPORT_EMAIL_SUBJECTS_SQL = sql`
  SELECT e.id, e.subject
  FROM json_each(?) j
  JOIN emails e ON e.id = j.value
`;

// ---------------------------------------------------------------------------
// Dashboard "Todo" — BACKLOG-3965 PR-3
// ---------------------------------------------------------------------------

/**
 * INTERNAL. The rows the Todo list is made of: every REQUIRED item not yet
 * ticked, on a checklist of one of this user's deals that is
 *   - active: `status = 'active'` and `detection_status` neither 'pending' nor
 *     'rejected' — the transaction list's own "Active" filter
 *     (useTransactionList.ts:199-203). `detection_status` has a default but no
 *     NOT NULL, so NULL counts as confirmed, as it does there;
 *   - not locked: `submission_status` not one of the LOCKING statuses. NULL is
 *     open (`dealLockReason` reads it so), and a bare `NOT IN` would drop it.
 *
 * Bound parameters, in order: user id, then each locked status. The locked
 * statuses are passed in (`db/` does not import from `services/`); the caller
 * passes `LOCKED_SUBMISSION_STATUSES`, the list DERIVED from the lock map.
 * Never the map's keys: every submission status is a key, so that filter
 * excludes every deal (BACKLOG-3965 SR plan review, change 1).
 */
/**
 * BACKLOG-3966: which checklists the Todo list may draw from. `all` when the
 * plan includes checklists; `private` (the agent's own items only) when it
 * does not. A `private` read takes ONE extra bound parameter after the locked
 * statuses: the reserved template id.
 */
export type OpenRequiredItemsScope = "all" | "private";

function openRequiredItemsFrom(lockedStatusCount: number, scope: OpenRequiredItemsScope): SafeSql {
  const scopeFilter = scope === "private" ? sql`
    AND c.template_id = ?` : sql``;
  return sql`
  FROM transaction_checklist_items i
  JOIN transaction_checklists c ON c.id = i.checklist_id
  JOIN transactions t ON t.id = c.transaction_id
  WHERE t.user_id = ?
    AND t.status = 'active'
    AND (t.detection_status IS NULL OR t.detection_status NOT IN ('pending', 'rejected'))
    AND (t.submission_status IS NULL OR t.submission_status NOT IN (${placeholderList(lockedStatusCount)}))
    AND i.is_required = 1
    AND i.is_checked = 0${scopeFilter}`;
}

/**
 * How many Todo items exist in all (the "N required" header — not capped by
 * the row limit). Bound parameters: user id, each locked status.
 */
export function countOpenRequiredItemsSql(
  lockedStatusCount: number,
  scope: OpenRequiredItemsScope,
): SafeSql {
  return sql`
  SELECT COUNT(*) AS total
  ${openRequiredItemsFrom(lockedStatusCount, scope)}
`;
}

/**
 * The Todo items in display order. Bound parameters: user id, each locked
 * status, row limit.
 *
 * Order: Closing Date soonest first (by its calendar-date part, since the
 * column admits both `YYYY-MM-DD` and an ISO timestamp), deals with no Closing
 * Date last; then the deal (address, then id); then the checklist in the
 * deal's own display order (as GET_CHECKLISTS_BY_TRANSACTION_SQL); then the
 * item's `sort_order`, then id. Every tie ends on a key, so the order is total.
 *
 * The deal's required done / total are summed across EVERY checklist on it,
 * the same rule as `getChecklistsForTransaction` and the Recent read
 * (transactionOpenSql.ts), so the ring a deal shows here is the one its
 * Checklist tab shows.
 */
export function listOpenRequiredItemsSql(
  lockedStatusCount: number,
  scope: OpenRequiredItemsScope,
): SafeSql {
  return sql`
  SELECT
    i.id AS itemId,
    i.checklist_id AS checklistId,
    i.title AS title,
    t.id AS transactionId,
    t.property_address AS propertyAddress,
    NULLIF(t.closing_deadline, '') AS closingDeadline,
    (SELECT COUNT(*)
       FROM transaction_checklists dc
       JOIN transaction_checklist_items di ON di.checklist_id = dc.id
      WHERE dc.transaction_id = t.id AND di.is_required = 1 AND di.is_checked = 1
    ) AS dealRequiredDone,
    (SELECT COUNT(*)
       FROM transaction_checklists dc
       JOIN transaction_checklist_items di ON di.checklist_id = dc.id
      WHERE dc.transaction_id = t.id AND di.is_required = 1
    ) AS dealRequiredTotal
  ${openRequiredItemsFrom(lockedStatusCount, scope)}
  ORDER BY
    (NULLIF(t.closing_deadline, '') IS NULL),
    substr(t.closing_deadline, 1, 10),
    t.property_address,
    t.id,
    c.sort_order,
    c.selected_at,
    c.id,
    i.sort_order,
    i.id
  LIMIT ?
`;
}
