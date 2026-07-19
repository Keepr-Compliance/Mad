/**
 * Transaction Freeze Policy (BACKLOG-2013, narrowed by BACKLOG-2150)
 * =================================================================
 *
 * Anti-reuse rule for paid unlocks (founder decision 2026-07-14; field-level
 * boundary refined with the founder 2026-07-19, BACKLOG-2150).
 *
 * Closes the abuse loop: unlock once -> export deal A -> swap the address ->
 * export deal B for free.
 *
 * KEY INSIGHT (BACKLOG-2150): the audit is a TIME-WINDOWED capture of one
 * deal's comms. Reuse-for-a-different-deal requires changing an ANCHOR — WHICH
 * deal (property + transaction type) or WHEN THE WINDOW STARTS (`started_at`).
 * Freeze those anchors and reuse is fully defeated: swapping comms, removing a
 * party, or widening the end date on a frozen (property, type, start) only ever
 * yields MORE comms of the SAME deal — a worthless audit if repurposed. So
 * comm/party removal and end-date edits carry ~zero abuse risk but real support
 * burden, and are therefore LEFT EDITABLE after export.
 *
 * BOUNDARY = FIRST EXPORT (NOT unlock):
 *   - BEFORE first export (incl. right after an unlock): fully editable.
 *   - AFTER first export (`first_exported_at` is set):
 *       * The IDENTITY ANCHORS freeze: property address block, transaction
 *         type, and `started_at` (the audit-window start). These cannot be
 *         edited without an admin unfreeze.
 *       * Everything else stays editable — the closing/end date, linked
 *         communications (add AND remove), and party/contact assignments
 *         (add AND remove). New synced comms still auto-link and re-export
 *         stays open (the permanent-unlock promise).
 *   - Admin/support may UNFREEZE for a genuine post-export anchor typo. The
 *     unfreeze (and the edits it enables) are audit-logged for compliance.
 *
 * The exported PDF is a point-in-time snapshot; after later edits the app state
 * may legitimately diverge from a previously exported artifact.
 *
 * This module is the SINGLE SOURCE OF TRUTH for:
 *   - which transaction columns count as "identity" (frozen), and
 *   - the predicate `isTransactionFrozen`.
 *
 * Enforcement lives in the main/db layer (transactionDbService.updateTransaction),
 * NOT only in the renderer — UI disabling is a courtesy, the db layer is the
 * guarantee.
 */

/**
 * Transaction columns that describe the transaction's IDENTITY ANCHORS and
 * therefore freeze after the first export.
 *
 * BACKLOG-2150 narrowed this to the anti-reuse anchors only: the property
 * address block, the transaction type, and the audit-window START date.
 *
 * Deliberately EXCLUDES:
 *   - the END/closing date and other key dates — a deal legitimately closes
 *     later than expected; widening the window on a frozen start only pulls in
 *     more comms of the SAME deal;
 *   - party/contact reference columns — parties are add-AND-remove after export
 *     (fixing an imperfect auto-link without a support ticket);
 *   - operational / derived / bookkeeping columns (status, stage, message_count,
 *     export_*, submission_*, financial figures, metadata, skip_address_filter).
 */
export const FROZEN_IDENTITY_FIELDS: readonly string[] = [
  // Property identity (address block) — the primary "which deal" anchor.
  "property_address",
  "property_street",
  "property_city",
  "property_state",
  "property_zip",
  "property_coordinates",

  // Transaction identity.
  "transaction_type",

  // Audit-window START — moving it re-scopes the capture into a different
  // audit, so it is frozen. The END date (`closed_at`) is intentionally NOT
  // here (BACKLOG-2150): widening the window only yields more of the same deal.
  "started_at",
];

const FROZEN_IDENTITY_FIELD_SET: ReadonlySet<string> = new Set(FROZEN_IDENTITY_FIELDS);

/** Minimal shape needed to evaluate the freeze predicate. */
export interface FreezeState {
  first_exported_at?: string | null;
}

/**
 * A transaction is frozen once it has been exported at least once, i.e. its
 * `first_exported_at` marker is a non-empty value.
 *
 * Absence / null / empty string => NOT frozen (still fully editable).
 */
export function isTransactionFrozen(state: FreezeState | null | undefined): boolean {
  if (!state) return false;
  const marker = state.first_exported_at;
  return typeof marker === "string" && marker.trim().length > 0;
}

/** True when `field` is an identity column that freezes after first export. */
export function isFrozenIdentityField(field: string): boolean {
  return FROZEN_IDENTITY_FIELD_SET.has(field);
}

/**
 * Given a set of update keys, return the subset that are frozen identity fields.
 * Used to build a precise error message and to distinguish "editing a frozen
 * field" from "editing an always-allowed field".
 */
export function frozenFieldsInUpdate(updateKeys: readonly string[]): string[] {
  return updateKeys.filter((k) => FROZEN_IDENTITY_FIELD_SET.has(k));
}

/**
 * Error thrown when a frozen identity anchor (property address block,
 * transaction type, or the audit-window start date) is edited on an
 * already-exported transaction without an admin unfreeze. Carries a stable
 * `code` so handlers/renderer can branch on it (e.g. show the "request
 * unfreeze" affordance) rather than string-matching the message.
 */
export class TransactionFrozenError extends Error {
  readonly code = "TRANSACTION_FROZEN";
  readonly transactionId: string;
  readonly attemptedFields?: string[];

  constructor(transactionId: string, message: string, attemptedFields?: string[]) {
    super(message);
    this.name = "TransactionFrozenError";
    this.transactionId = transactionId;
    this.attemptedFields = attemptedFields;
  }
}
