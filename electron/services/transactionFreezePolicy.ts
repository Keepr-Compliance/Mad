/**
 * Transaction Freeze Policy (BACKLOG-2013)
 * ========================================
 *
 * Anti-reuse rule for paid unlocks (founder decision 2026-07-14).
 *
 * Closes the abuse loop: unlock once -> export deal A -> swap the address /
 * parties / dates -> export deal B for free.
 *
 * BOUNDARY = FIRST EXPORT (NOT unlock):
 *   - BEFORE first export (incl. right after an unlock): the transaction is
 *     fully editable. Paying and then spotting a typo must stay fixable, and
 *     nothing has been extracted yet, so a legitimate correction is fine.
 *   - AFTER first export (`first_exported_at` is set):
 *       * IDENTITY fields FREEZE (address, parties, key dates, transaction type).
 *       * Linked communications become ADD-ONLY: new synced emails/texts still
 *         auto-link and re-export is allowed (the permanent-unlock promise),
 *         but DETACHING / REMOVING an already-linked communication is blocked.
 *   - Admin/support may UNFREEZE for the genuine post-export typo case. The
 *     unfreeze (and the edits it enables) are audit-logged for compliance.
 *
 * The exported PDF is a point-in-time snapshot; after an unfreeze-edit the app
 * state may legitimately diverge from a previously exported artifact.
 *
 * This module is the SINGLE SOURCE OF TRUTH for:
 *   - which transaction columns count as "identity" (frozen), and
 *   - the predicate `isTransactionFrozen`.
 *
 * Enforcement lives in the main/db layer (transactionDbService.updateTransaction,
 * transactionService unlink/remove paths), NOT only in the renderer — UI
 * disabling is a courtesy, the db layer is the guarantee.
 */

/**
 * Transaction columns that describe the transaction's IDENTITY and therefore
 * freeze after the first export.
 *
 * Deliberately EXCLUDES operational / derived / bookkeeping columns (status,
 * stage, message_count, export_*, submission_*, financial figures, metadata,
 * skip_address_filter, etc.) — those may legitimately change after export
 * (e.g. status moves to 'closed', new comms bump message_count, a re-export
 * updates export tracking).
 */
export const FROZEN_IDENTITY_FIELDS: readonly string[] = [
  // Property identity (address block)
  "property_address",
  "property_street",
  "property_city",
  "property_state",
  "property_zip",
  "property_coordinates",

  // Transaction identity
  "transaction_type",

  // Parties (contact references stored on the transaction row)
  "buyer_agent_id",
  "seller_agent_id",
  "escrow_officer_id",
  "inspector_id",
  "other_contacts",
  "other_parties",

  // Key dates
  "started_at",
  "closed_at",
  "representation_start_date",
  "closing_deadline",
  "mutual_acceptance_date",
  "inspection_deadline",
  "financing_deadline",
  "earnest_money_delivered_date",
  "key_dates",
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
 * Error thrown when a frozen identity field or a comms-detach is attempted on
 * an already-exported transaction without an admin unfreeze. Carries a stable
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
