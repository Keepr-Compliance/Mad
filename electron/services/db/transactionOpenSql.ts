/**
 * SQL for "last opened" — BACKLOG-3965 PR-2.
 *
 * `transaction_opens` holds one row per deal: when it was last opened on THIS
 * device. Local only — not synced, not exported. It is a separate table, not a
 * column on `transactions`, because the AFTER UPDATE trigger
 * `update_transactions_timestamp` would bump `transactions.updated_at` on every
 * open, and every reader of `updated_at` would see an open as an edit.
 * Nothing here writes `transactions`.
 */

import { sql } from "./core/sqlText";

/**
 * Record that a deal was opened. Two bound parameters, in order: opened_at
 * (ISO 8601 UTC), transaction id.
 *
 * Writes nothing when no deal has that id (`changes` = 0), rather than failing
 * the foreign key. An existing row keeps its place and takes the new time.
 */
export const RECORD_TRANSACTION_OPEN_SQL = sql`
  INSERT INTO transaction_opens (transaction_id, opened_at)
  SELECT id, ? FROM transactions WHERE id = ?
  ON CONFLICT(transaction_id) DO UPDATE SET opened_at = excluded.opened_at
`;

/**
 * The deals one user opened most recently, newest first. Two bound
 * parameters, in order: user id, row limit.
 *
 * Left out (BACKLOG-3965 SR plan review, change 1), NULL-safe because
 * `status` and `detection_status` have defaults but no NOT NULL:
 *   - status 'rejected'
 *   - detection_status 'pending' or 'rejected' (awaiting review, or dismissed)
 *
 * The required counts are summed across EVERY checklist on the deal, the same
 * rule as `getChecklistsForTransaction` (checklistDbService.ts), so the number
 * shown for a deal on the Dashboard is the number its Checklist tab shows.
 *
 * Reads `idx_transaction_opens_opened_at` in order and stops at the limit; the
 * counts use the `transaction_checklists` (transaction_id, template_id) and
 * `idx_checklist_items_checklist` indexes.
 */
export const GET_RECENTLY_OPENED_TRANSACTIONS_SQL = sql`
  SELECT
    o.transaction_id AS transactionId,
    t.property_address AS propertyAddress,
    t.status AS status,
    o.opened_at AS openedAt,
    (SELECT COUNT(*)
       FROM transaction_checklists c
       JOIN transaction_checklist_items i ON i.checklist_id = c.id
      WHERE c.transaction_id = o.transaction_id AND i.is_required = 1 AND i.is_checked = 1
    ) AS requiredDone,
    (SELECT COUNT(*)
       FROM transaction_checklists c
       JOIN transaction_checklist_items i ON i.checklist_id = c.id
      WHERE c.transaction_id = o.transaction_id AND i.is_required = 1
    ) AS requiredTotal
  FROM transaction_opens o
  JOIN transactions t ON t.id = o.transaction_id
  WHERE t.user_id = ?
    AND (t.status IS NULL OR t.status <> 'rejected')
    AND (t.detection_status IS NULL OR t.detection_status NOT IN ('pending', 'rejected'))
  ORDER BY o.opened_at DESC, o.transaction_id
  LIMIT ?
`;
