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
import type { SafeSql } from "./core/sqlText";
import type { ChecklistLinkKind } from "../../types/checklist";

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
 * There is deliberately no statement that deletes by transaction alone: every
 * other checklist on the transaction must survive a remove. This is the ONLY
 * statement in this file that deletes a `transaction_checklists` row
 * (BACKLOG-3476 round 2: Change is gone, so `selectChecklistTemplate` never
 * deletes).
 */
export const DELETE_CHECKLIST_IN_TRANSACTION_SQL = sql`
  DELETE FROM transaction_checklists WHERE id = ? AND transaction_id = ?
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
  SELECT l.id, l.item_id, l.kind, l.label, l.sort_order
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
 */
export const GET_CHECKLIST_LINK_MEMBERS_SQL = sql`
  SELECT m.id, m.link_id, m.kind, m.attachment_id, m.email_id,
         CASE
           WHEN m.email_id IS NOT NULL THEN EXISTS (
             SELECT 1 FROM communications c
             WHERE c.transaction_id = cl.transaction_id AND c.email_id = m.email_id
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
                     OR (c3.message_id IS NULL AND c3.thread_id IS NOT NULL AND c3.thread_id = msg.thread_id)
                   )
                   WHERE msg.id = a.message_id AND c3.transaction_id = cl.transaction_id
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

/** The item's checklist and that checklist's transaction. One bound parameter. */
export const GET_ITEM_CONTEXT_SQL = sql`
  SELECT i.id AS item_id, c.id AS checklist_id, c.transaction_id
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

/** Insert one evidence group. Five bound parameters: id, item id, kind, label, sort_order. */
export const INSERT_CHECKLIST_LINK_SQL = sql`
  INSERT INTO transaction_checklist_links (id, item_id, kind, label, sort_order)
  VALUES (?, ?, ?, ?, ?)
`;

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
 * for `email`, twice for `attachment` (its two arms are independent EXISTS).
 *
 * The attachment arms are `submissionDbService.getTransactionAttachments`'s two
 * joins with the audit-date filter and the `storage_path IS NOT NULL` filter
 * removed: those narrow an EXPORT to what can be uploaded, while this asks only
 * whether the attachment belongs to this transaction at all.
 */
export function targetsInTransactionSql(kind: ChecklistLinkKind, count: number): SafeSql {
  const ids = placeholderList(count);
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
            OR (c2.message_id IS NULL AND c2.thread_id IS NOT NULL AND c2.thread_id = m.thread_id)
          )
          WHERE m.id = a.message_id AND c2.transaction_id = ?
        )
      )
  `;
}
