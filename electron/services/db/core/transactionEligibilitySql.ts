/**
 * The SQL form of "is this deal live?" — BACKLOG-3103.
 *
 * ## Why this fragment moved here, and why it now binds
 *
 * The rule itself is BACKLOG-2562's and still lives once, in
 * `electron/services/transactionEligibility.ts`: `REJECTED_TRANSACTION_STATUS`
 * is the value, `isLiveTransactionStatus` is the JS form. What moved is only the
 * SQL SPELLING of it, and it moved because of what it used to be — this line, as
 * it stood in `transactionEligibility.ts:59` before BACKLOG-3103:
 *
 *     export const LIVE_TRANSACTION_SQL_PREDICATE =
 *       `t.status != '${REJECTED_TRANSACTION_STATUS}'`;   // <- the defect
 *
 * A status VALUE hand-quoted into SQL text, authored outside `db/**`. Not a live
 * injection hole — the constant is a module-level literal with no path from user
 * input, which is exactly why it survived review — but text where a bound
 * parameter belongs. `sqlText.ts`'s tag takes `SafeSql[]` and correctly refuses a
 * `string`, so the four statements that splice this fragment could not be moved
 * into the layer by BACKLOG-3044 while it stayed text. Binding is what unblocks
 * them; BACKLOG-3044 PR 5 does the moving.
 *
 * ## The placeholder is ALWAYS LAST, and that is the contract
 *
 * A fragment carrying its own bound parameter has to land in the right slot of
 * the caller's params array, and position is the whole contract — get it wrong
 * and every later `?` in the statement silently shifts. Rather than leave four
 * callers to each remember their own index, there is ONE rule:
 *
 *   **the eligibility fragment is the last placeholder in the statement, and
 *   `withLiveTransactionParam` appends its value to the end of the params array.**
 *
 * Three of the four sites already had the predicate last. The fourth
 * (`getOtherCandidateTransactionAddresses`) had `t.id != ?` after it and was
 * reordered — `AND` is commutative over these terms, and the reorder is covered
 * by an exact-row-id control rather than asserted to be safe.
 *
 * ## NULL status
 *
 * `t.status != 'rejected'` and `t.status != ?` are identical under SQLite's
 * three-valued logic: both evaluate to NULL against a NULL status, which is not
 * TRUE, so a NULL-status row is EXCLUDED either way. That is the one input where
 * a reader might expect the two forms to differ, so it is shown by execution in
 * `__tests__/transactionEligibilitySql.boundStatus-3103.test.ts` rather than
 * claimed here.
 */
import { REJECTED_TRANSACTION_STATUS } from "../../transactionEligibility";
import { sql } from "./sqlText";

/**
 * SQL fragment selecting LIVE transactions, for a WHERE clause where the
 * `transactions` table is aliased `t`.
 *
 * Carries ONE placeholder. See the module docblock: it must be the LAST
 * placeholder in the statement, and its value comes from
 * `withLiveTransactionParam`.
 */
export const LIVE_TRANSACTION_SQL_PREDICATE = sql`t.status != ?`;

/**
 * The same fragment for queries that read `transactions` unaliased.
 */
export const LIVE_TRANSACTION_SQL_PREDICATE_UNALIASED = sql`status != ?`;

/**
 * The params array a statement splicing either fragment must pass.
 *
 * This is the ONLY spelling of the position rule. A caller that writes the array
 * by hand can put the value in the wrong slot; a caller that calls this cannot.
 */
export function withLiveTransactionParam(params: readonly unknown[]): unknown[] {
  return [...params, REJECTED_TRANSACTION_STATUS];
}

/**
 * BACKLOG-3910: a deal's submission status, for the locked-deal check
 * (`transactionEligibility.dealLockReason`). One bound parameter: transaction id.
 * Read by `dealLockState.getDealLockReason`, the backstop at every automatic
 * writer. The sweeps read the same column through queries they already run.
 */
export const TRANSACTION_SUBMISSION_STATUS_SQL = sql`SELECT submission_status FROM transactions WHERE id = ?`;

/** BACKLOG-3910: the deal a linked communication row belongs to. One parameter: communication id. */
export const COMMUNICATION_TRANSACTION_ID_SQL = sql`SELECT transaction_id FROM communications WHERE id = ?`;

/** BACKLOG-3910: the deal a text message is linked to. One parameter: message id. */
export const MESSAGE_TRANSACTION_ID_SQL = sql`SELECT transaction_id FROM messages WHERE id = ?`;

/**
 * BACKLOG-3910 (slice d): the deal a checklist item belongs to. One parameter: item id.
 * BACKLOG-3966: also the checklist's `template_id`, so the per-checklist plan
 * gate can tell the private checklist from a template one in the same read.
 */
export const CHECKLIST_ITEM_TRANSACTION_ID_SQL = sql`
  SELECT c.transaction_id, c.template_id FROM transaction_checklist_items i
  JOIN transaction_checklists c ON c.id = i.checklist_id
  WHERE i.id = ?
`;

/**
 * BACKLOG-3910 (slice d): the deal a checklist evidence group belongs to. One parameter: link id.
 * BACKLOG-3966: also the checklist's `template_id` (see the item statement above).
 */
export const CHECKLIST_LINK_TRANSACTION_ID_SQL = sql`
  SELECT c.transaction_id, c.template_id FROM transaction_checklist_links l
  JOIN transaction_checklist_items i ON i.id = l.item_id
  JOIN transaction_checklists c ON c.id = i.checklist_id
  WHERE l.id = ?
`;
