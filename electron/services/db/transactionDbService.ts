/**
 * Transaction Database Service
 * Handles all transaction-related database operations
 */

import crypto from "crypto";
import type {
  Transaction,
  NewTransaction,
  TransactionFilters,
  TransactionWithContacts,
  TransactionStatus,
} from "../../types";
import { DatabaseError } from "../../types";
import { dbGet, dbAll, dbRun, dbTransaction } from "./core/dbConnection";
import {
  countLinkedEmailsByTransaction,
  type ScopedEmailRow,
} from "./emailThreadScope";
import logService from "../logService";
import {
  getTransactionContactsWithRoles,
  assignContactToTransactionSync,
  type TransactionContactData,
} from "./transactionContactDbService";
import {
  validateFields,
  isValidField,
  TABLE_FIELDS,
  type FieldExpression,
  type TransactionColumn,
} from "../../utils/sqlFieldWhitelist";
import {
  isTransactionFrozen,
  frozenFieldsInUpdate,
  TransactionFrozenError,
  FROZEN_IDENTITY_FIELDS,
} from "../transactionFreezePolicy";

/**
 * BACKLOG-2013: sentinel key callers may set on the `updates` object to bypass
 * the export-freeze guard for a single write (admin unfreeze + the export
 * handler stamping first_exported_at itself). It is stripped before SQL
 * construction and is NEVER a real column. Using a well-known key (rather than
 * a Symbol) keeps it serialisable across the IPC boundary if ever needed.
 */
export const UNFREEZE_OVERRIDE_KEY = "__unfreezeOverride";

// ===========================================================================
// THE COLUMN POLICY — BACKLOG-2737 / BACKLOG-2558 (epic BACKLOG-2738, Phase 2)
// ===========================================================================
//
// **This writer used to keep two hand-typed name lists, and both were wrong in
// the way a list cannot notice: by OMISSION.**
//
// `createTransactionSync` hard-coded a 13-column INSERT. The detection path
// builds a 22-field object including `detection_status: "pending"`, and every
// detection column was discarded on the way to the database with no error —
// so `schema.sql`'s `DEFAULT 'confirmed'` won, an auto-detected deal landed as
// a confirmed one, and the review queue counted by
// `WHERE detection_status = 'pending'` could never populate (BACKLOG-2737).
// `updateTransaction` kept a 46-name `allowedFields` array which invented 11
// columns that exist in no table and omitted 23 real ones, including the three
// the Approve / Reject / Restore actions send (BACKLOG-2558).
//
// **A union of column names cannot catch that.** A 13-column list is a
// perfectly valid `TransactionColumn[]`. Nothing about a union of names
// notices a name that was never mentioned.
//
// So the writer declares a TOTAL decision instead of a list. Because the
// object below is annotated `Record<TransactionColumn, ColumnPolicy>`:
//
//   * adding a column to `TABLE_FIELDS.transactions` and forgetting it here is
//     a MISSING-PROPERTY compile error, and
//   * removing a column from `TABLE_FIELDS.transactions` makes its entry here
//     an EXCESS-PROPERTY compile error.
//
// Both directions break the build in THIS file — the writer, which is where
// the decision has to be made. That is the PR-SOP §6.2e / §6.2b bar, and both
// halves are exercised in `transactionColumnPolicy-2737.compile.md` controls.
//
// -------------------------------------------------------------------------
// HOW TO CHANGE A DECISION
// -------------------------------------------------------------------------
// `"writable"` means the caller's value lands in the column. `"db-default"`
// means callers deliberately do NOT set it and the schema default is the
// intent. `"excluded"` means never written on that path for a reason that is
// not "the default is right". `"writer-owned"` means this function computes
// the value and the caller's is not used verbatim.
//
// **Turning a `"db-default"` into a `"writable"` is a behaviour change, not a
// cleanup.** Several of the entries below are `"db-default"` because no caller
// passes them today — and a drop can be load-bearing by accident: the manual
// creation path passes exactly the values the schema already defaults to, so
// discarding them was invisible. Turning on a write whose caller passes a
// WRONG value lands that wrong value for the first time. `closing_date_verified`
// is the worked example; read its `why`.
// ===========================================================================

/** What happens to a caller-supplied value for one column on one path. */
type ColumnWrite =
  /** The caller's value lands in this column. */
  | "writable"
  /** Deliberately not set by callers; the schema default is the intent. */
  | "db-default"
  /** Never written on this path, for a reason that is not the schema default. */
  | "excluded"
  /** This function computes the value; the caller's is not used verbatim. */
  | "writer-owned";

interface ColumnPolicy {
  readonly insert: ColumnWrite;
  readonly update: ColumnWrite;
  /** Object values are JSON-encoded before binding (the column stores JSON). */
  readonly json?: true;
  /**
   * On INSERT only, an empty string means "unset" and is stored as NULL. This
   * preserves the `|| null` the 13-column INSERT applied to exactly these
   * columns. The update path never had that coercion and does not get it now.
   */
  readonly emptyToNull?: true;
  /** Why this decision. Mandatory: the reasons ARE the deliverable. */
  readonly why: string;
}

/**
 * Every column of `transactions`, in physical (`PRAGMA table_info`) order, with
 * a decision for each write path. Keyed by `TransactionColumn`, which comes
 * from `TABLE_FIELDS.transactions`, which is enumerated from a migrated
 * database (BACKLOG-2739) — so this table cannot drift from the schema without
 * the build breaking.
 */
export const TRANSACTION_COLUMN_POLICY: Record<TransactionColumn, ColumnPolicy> = {
  id: {
    insert: "writer-owned",
    update: "excluded",
    why: "Primary key, generated here with crypto.randomUUID. A row's identity is never taken from, nor edited by, a caller.",
  },
  user_id: {
    insert: "writable",
    update: "excluded",
    why: "The owner is fixed at creation. Re-parenting a deal to another user is not an edit; it would silently move audit evidence between accounts.",
  },
  property_address: {
    insert: "writable",
    update: "writable",
    why: "The caller's address is the deal's identity. Frozen after first export by the guard below.",
  },
  property_street: {
    insert: "writable",
    update: "writable",
    emptyToNull: true,
    why: "Address component supplied by the caller.",
  },
  property_city: {
    insert: "writable",
    update: "writable",
    emptyToNull: true,
    why: "Address component supplied by the caller.",
  },
  property_state: {
    insert: "writable",
    update: "writable",
    emptyToNull: true,
    why: "Address component supplied by the caller.",
  },
  property_zip: {
    insert: "writable",
    update: "writable",
    emptyToNull: true,
    why: "Address component supplied by the caller.",
  },
  property_coordinates: {
    insert: "writable",
    update: "writable",
    json: true,
    emptyToNull: true,
    why: "Geocoded point, stored as JSON. Callers pass either the object or the encoded string.",
  },
  transaction_type: {
    insert: "writable",
    update: "writable",
    emptyToNull: true,
    why: "Caller-chosen. Constrained by a CHECK to purchase/sale/other.",
  },
  status: {
    insert: "writer-owned",
    update: "writable",
    why: "On INSERT the value goes through validateTransactionStatus, which throws on an unknown status and substitutes 'active' for absent — so the column is always written, never defaulted by SQLite. The same validator runs on the update path.",
  },
  started_at: {
    insert: "writable",
    update: "writable",
    emptyToNull: true,
    why: "Audit-window start supplied by the caller. Frozen after first export.",
  },
  closed_at: {
    insert: "writable",
    update: "writable",
    emptyToNull: true,
    why: "Closing date supplied by the caller.",
  },
  last_activity_at: {
    insert: "db-default",
    update: "db-default",
    why: "No caller passes it on either path (BACKLOG-2739 Phase-2 input §1). Left at the schema default rather than opened speculatively; a column with no writer today gains one when something means to write it.",
  },
  representation_start_date: {
    insert: "db-default",
    update: "db-default",
    why: "Zero writers AND zero readers repo-wide — the only reference is a test fixture (BACKLOG-2739 Phase-2 input §3). Opening a write for a column nothing reads would land a value nothing validates. Recorded here so the next person finds a decision instead of a gap.",
  },
  closing_date_verified: {
    insert: "db-default",
    update: "writable",
    why: "THE WORKED EXAMPLE. The audited-create path passes `property_coordinates ? true : false` (transactionService.ts:1173) — a fact about the ADDRESS, not about the closing date. Every path stores the schema DEFAULT 0 today because the INSERT dropped it; opening the INSERT would land a semantically wrong 1 for the first time. The update path already accepted it (the IPC validator forwards a 0/1 the user actually set), so that half is unchanged.",
  },
  representation_start_confidence: {
    insert: "writable",
    update: "writable",
    why: "Confidence about this row's own dates; the creating path is the only thing that knows it. The manual path names it and passes undefined, which is omitted.",
  },
  closing_date_confidence: {
    insert: "writable",
    update: "writable",
    why: "Confidence about this row's own dates; the creating path is the only thing that knows it. The manual path names it and passes undefined, which is omitted.",
  },
  confidence_score: {
    insert: "db-default",
    update: "db-default",
    why: "No caller passes it. The detection path passes the @deprecated `extraction_confidence`, which is a column of NO table; remapping one to the other would be inventing behaviour this PR was not asked for. Recorded on BACKLOG-2737, not fixed here.",
  },
  stage: {
    insert: "db-default",
    update: "db-default",
    why: "Owned by the stage-classification feature, which does not write yet. No caller passes it on either path.",
  },
  stage_source: {
    insert: "db-default",
    update: "db-default",
    why: "Companion of `stage`; same decision.",
  },
  stage_confidence: {
    insert: "db-default",
    update: "db-default",
    why: "Companion of `stage`; same decision.",
  },
  stage_updated_at: {
    insert: "db-default",
    update: "db-default",
    why: "Companion of `stage`; same decision.",
  },
  listing_price: {
    insert: "db-default",
    update: "writable",
    why: "Entered by the user after the deal exists; no creating caller supplies it. Already accepted on the update path and forwarded by the IPC validator.",
  },
  sale_price: {
    insert: "db-default",
    update: "writable",
    why: "Entered by the user after the deal exists. Already accepted on the update path and forwarded by the IPC validator. NOTE the one creating caller that names it — `_createTransactionFromSummary` (transactionService.ts:530) — is a PRIVATE method with zero callers repo-wide, so opening this would change no live behaviour and would give a dead path its first effect. If that method is ever revived, revisit this entry rather than assuming the drop is still harmless.",
  },
  earnest_money_amount: {
    insert: "db-default",
    update: "writable",
    why: "Entered by the user after the deal exists; no creating caller supplies it. Already accepted on the update path.",
  },
  mutual_acceptance_date: {
    insert: "db-default",
    update: "writable",
    why: "Entered by the user after the deal exists; no creating caller supplies it. Already accepted on the update path.",
  },
  inspection_deadline: {
    insert: "db-default",
    update: "db-default",
    why: "No caller passes it on either path today. Left closed rather than opened speculatively — the compile gate above means the next person who means to write it must change this entry, and cannot forget the column instead.",
  },
  financing_deadline: {
    insert: "db-default",
    update: "db-default",
    why: "No caller passes it on either path today. Same reasoning as `inspection_deadline`.",
  },
  closing_deadline: {
    insert: "writable",
    update: "writable",
    emptyToNull: true,
    why: "Supplied by the audited-create path and editable afterwards.",
  },
  message_count: {
    insert: "db-default",
    update: "writable",
    why: "A counter maintained by the link/unlink paths. It is Omit-ted from `NewTransaction` entirely, so no creating caller can supply it; the schema DEFAULT 0 is the correct starting value.",
  },
  attachment_count: {
    insert: "db-default",
    update: "writable",
    why: "A counter maintained by the link/unlink paths. Omit-ted from `NewTransaction`; schema DEFAULT 0 is the correct starting value.",
  },
  text_thread_count: {
    insert: "db-default",
    update: "excluded",
    why: "Owned by a hand-built `UPDATE transactions SET text_thread_count = ?` in communicationDbService.ts:1085 and :1125, which bypasses this writer and the whitelist entirely (BACKLOG-2739 Phase-2 input §2). Outside this PR's fence — recorded, not fixed. Accepting it here as well would give one column two writers with no arbiter.",
  },
  export_status: {
    insert: "writable",
    update: "writable",
    why: "The creating paths pass 'not_exported', which equals the schema default — so opening the INSERT changes no stored value today (asserted by the manual-path parity test) while making the caller's intent the thing that lands.",
  },
  export_format: {
    insert: "db-default",
    update: "writable",
    why: "Known only once an export runs; no creating caller supplies it. Already accepted on the update path.",
  },
  export_count: {
    insert: "writable",
    update: "writable",
    why: "The creating paths pass 0, which equals the schema default — same reasoning as `export_status`. NOTE the value is 0 and therefore falsy: a blanket `value || null` here would turn it into NULL, which is why the coercion below is per-column and never generic.",
  },
  last_exported_at: {
    insert: "excluded",
    update: "excluded",
    why: "THE PRE-EXISTING DOCUMENTED EXCLUSION, preserved verbatim from the old allow-list comment. It has no writer — export completion stamps `last_exported_on` (BACKLOG-2109). The column stays because the v51 freeze backfill reads it as a legacy source; it is simply not accepted from a caller.",
  },
  last_exported_on: {
    insert: "db-default",
    update: "writable",
    why: "Stamped by the export handlers on every export completion. Nothing exports a deal at the moment it is created.",
  },
  first_exported_at: {
    insert: "db-default",
    update: "writable",
    why: "BACKLOG-2013 freeze marker. Set write-once at the SQL layer by stampFirstExportedAt and cleared by admin unfreeze — both via the override path below. A brand-new deal has never been exported.",
  },
  detection_source: {
    insert: "writable",
    update: "writable",
    why: "BACKLOG-2737. Dropped on INSERT, so an auto-detected deal was recorded as user-created by the schema default 'manual'. No caller passes it on the update path today, so opening that half changes nothing now and removes the same trap for BACKLOG-2234.",
  },
  detection_status: {
    insert: "writable",
    update: "writable",
    why: "BACKLOG-2737 on INSERT and BACKLOG-2558 on UPDATE — the single field this whole epic is anchored to. Dropped on INSERT, the schema default 'confirmed' won and the review queue could never populate; absent from the update allow-list, Approve wrote 1 of its 3 fields and Reject hard-failed.",
  },
  detection_confidence: {
    insert: "writable",
    update: "writable",
    why: "BACKLOG-2737. Part of the detection field set the INSERT discarded; the review UI ranks by it.",
  },
  detection_method: {
    insert: "writable",
    update: "writable",
    why: "BACKLOG-2737. Part of the detection field set the INSERT discarded.",
  },
  suggested_contacts: {
    insert: "writable",
    update: "writable",
    json: true,
    why: "BACKLOG-2737. The parties a detection proposes, stored as JSON. Discarded on INSERT, so a reviewer had nothing to accept.",
  },
  reviewed_at: {
    insert: "writable",
    update: "writable",
    why: "BACKLOG-2558. Written by Approve / Reject / Restore. No creating caller passes it — a row has not been reviewed at the moment it is created — so the INSERT half is inert today and open for the same reason as the rest of the set.",
  },
  rejection_reason: {
    insert: "writable",
    update: "writable",
    why: "BACKLOG-2558. Written by Reject and CLEARED BY RESTORE — which is why null must land as null rather than being skipped as 'no value'.",
  },
  buyer_agent_id: {
    insert: "db-default",
    update: "writable",
    why: "Parties are attached through transaction_contacts at creation; these legacy id columns are set later, if at all. Already accepted on the update path.",
  },
  seller_agent_id: {
    insert: "db-default",
    update: "writable",
    why: "Same as buyer_agent_id.",
  },
  escrow_officer_id: {
    insert: "db-default",
    update: "writable",
    why: "Same as buyer_agent_id.",
  },
  inspector_id: {
    insert: "db-default",
    update: "writable",
    why: "Same as buyer_agent_id.",
  },
  other_contacts: {
    insert: "db-default",
    update: "writable",
    json: true,
    why: "JSON array of additional contact ids, set after creation. Already accepted on the update path.",
  },
  submission_status: {
    insert: "db-default",
    update: "writable",
    why: "B2B submission tracking (BACKLOG-390). A new deal has not been submitted; the schema default 'not_submitted' is the correct starting value.",
  },
  submission_id: {
    insert: "db-default",
    update: "writable",
    why: "Assigned by the broker portal on submission. Already accepted on the update path.",
  },
  submitted_at: {
    insert: "db-default",
    update: "writable",
    why: "Stamped on submission. Already accepted on the update path.",
  },
  last_review_notes: {
    insert: "db-default",
    update: "writable",
    why: "Broker feedback synced from cloud. Already accepted on the update path.",
  },
  skip_address_filter: {
    insert: "db-default",
    update: "writable",
    why: "Per-transaction auto-link toggle (BACKLOG-1364), flipped from the UI after creation. Schema DEFAULT 0 is the correct starting value.",
  },
  last_pending_scan_at: {
    insert: "db-default",
    update: "writable",
    why: "BACKLOG-2791 Needs-Review delta watermark. NULL on a new deal is correct — the first open then sweeps the whole window once and sets it. Written only by reviewStateService's open sweep; if this were not 'writable' the whitelist would SILENTLY DISCARD the update and every open would re-examine the full window forever (the BACKLOG-2620 shape).",
  },
  metadata: {
    insert: "db-default",
    update: "db-default",
    why: "No caller passes the JSON blob on either path today, and it has no reader on the write paths. Left closed rather than opened speculatively.",
  },
  created_at: {
    insert: "db-default",
    update: "excluded",
    why: "CURRENT_TIMESTAMP. When a row was created is a fact about the database, not a value a caller may assert or revise.",
  },
  updated_at: {
    insert: "db-default",
    update: "excluded",
    why: "CURRENT_TIMESTAMP. Same as created_at.",
  },
};

/**
 * The columns `createTransactionSync` will take from its caller, derived once
 * at module load.
 *
 * `TABLE_FIELDS.transactions` is a `readonly` tuple of literal column names, so
 * this is a `TransactionColumn[]` with no cast anywhere — which is what lets
 * `` `${column} = ?` `` below satisfy `validateFields` directly and made the
 * BACKLOG-2739 Phase 1 seam cast unnecessary.
 *
 * There is deliberately NO matching `UPDATABLE_COLUMNS` set. The update path
 * iterates the caller's keys rather than the schema's — it has to report which
 * keys it dropped and why — so it reads `TRANSACTION_COLUMN_POLICY[key].update`
 * at the point of decision. A precomputed set would be a second derived
 * definition that nothing consults, which is the exact thing this PR argues
 * against.
 */
const INSERTABLE_COLUMNS: readonly TransactionColumn[] = TABLE_FIELDS.transactions.filter(
  (column) => TRANSACTION_COLUMN_POLICY[column].insert === "writable",
);

/**
 * Prepare one caller value for binding.
 *
 * `better-sqlite3` binds only numbers, strings, bigints, buffers and null — a
 * boolean throws. The creating paths pass `closing_date_verified: false` and
 * `property_coordinates ? true : false`, so this is not hypothetical; it is the
 * first thing that breaks when a hard-coded INSERT becomes a derived one.
 */
function bindValue(
  column: TransactionColumn,
  raw: unknown,
  path: "insert" | "update",
): unknown {
  const policy = TRANSACTION_COLUMN_POLICY[column];
  let value = raw;

  if (policy.json === true && typeof value === "object" && value !== null) {
    value = JSON.stringify(value);
  }
  if (path === "insert" && policy.emptyToNull === true && value === "") {
    value = null;
  }
  if (typeof value === "boolean") {
    value = value ? 1 : 0;
  }
  return value === undefined ? null : value;
}

/**
 * Valid transaction status values.
 * These are the only values allowed in the database.
 */
export const VALID_TRANSACTION_STATUSES: readonly TransactionStatus[] = [
  "pending",
  "active",
  "closed",
  "rejected",
] as const;

/**
 * Validate and return a transaction status value.
 *
 * @param status - The status value to validate (can be null/undefined for default)
 * @returns A valid TransactionStatus value
 * @throws DatabaseError if the status is invalid (not null/undefined and not a valid value)
 *
 * @example
 * validateTransactionStatus('active') // returns 'active'
 * validateTransactionStatus('pending') // returns 'pending'
 * validateTransactionStatus(undefined) // returns 'active' (default)
 * validateTransactionStatus('invalid') // throws DatabaseError
 */
export function validateTransactionStatus(
  status: unknown
): TransactionStatus {
  // Handle null/undefined - default to 'active'
  if (status === null || status === undefined || status === "") {
    return "active";
  }

  // Validate the status is one of the allowed values
  if (
    typeof status === "string" &&
    VALID_TRANSACTION_STATUSES.includes(status as TransactionStatus)
  ) {
    return status as TransactionStatus;
  }

  // Reject invalid values with a clear error message
  throw new DatabaseError(
    `Invalid transaction status: "${status}". Valid values are: ${VALID_TRANSACTION_STATUSES.join(", ")}`
  );
}

/**
 * Create a new transaction
 */
export async function createTransaction(
  transactionData: NewTransaction,
): Promise<Transaction> {
  return createTransactionSync(transactionData);
}

/**
 * The synchronous core of `createTransaction` (BACKLOG-2538).
 *
 * WHY IT HAD TO BE SPLIT OUT — the same reason `updateContactSync` was
 * (BACKLOG-2496). Creating a deal and attaching its parties now run in ONE
 * transaction, and `dbTransaction` takes a SYNCHRONOUS callback. Calling the
 * `async` wrapper inside it would have been a silent atomicity hole: the body
 * is synchronous, but an `async` function turns a throw into a REJECTED
 * PROMISE rather than a synchronous throw, so `dbTransaction` would see the
 * callback return normally and COMMIT — with the failure surfacing later as an
 * unhandled rejection, after the write it was supposed to prevent had landed.
 *
 * The async wrapper stays because other callers await it.
 */
export function createTransactionSync(
  transactionData: NewTransaction,
): Transaction {
  const id = crypto.randomUUID();

  // Validate status - reject invalid values, use 'active' as default for null/undefined
  // Note: Legacy transaction_status field is no longer supported in write paths
  const validatedStatus = validateTransactionStatus(transactionData.status);

  // BACKLOG-2737 — the column list is DERIVED, not typed out.
  //
  // The two `writer-owned` columns come first because they are always written:
  // `id` is generated here and `status` has already been through its validator
  // (which substitutes 'active' for absent, so SQLite's own default never
  // applies). Everything else is a `writable` column the caller actually
  // supplied — an absent value means "use the schema default", which is what
  // makes opening these columns safe for the paths that pass exactly the
  // defaults today.
  const columns: TransactionColumn[] = ["id", "status"];
  const params: unknown[] = [id, validatedStatus];

  const supplied = transactionData as Record<string, unknown>;
  for (const column of INSERTABLE_COLUMNS) {
    if (supplied[column] === undefined) continue;
    columns.push(column);
    params.push(bindValue(column, supplied[column], "insert"));
  }

  // Defence in depth against a name that arrived from outside the type system.
  // The types make this unreachable from this file; the runtime check is for
  // everything that is not this file (see sqlFieldWhitelist's own header).
  validateFields("transactions", columns);

  const sql = `
    INSERT INTO transactions (${columns.join(", ")})
    VALUES (${columns.map(() => "?").join(", ")})
  `;

  dbRun(sql, params);
  const transaction = getTransactionByIdSync(id);
  if (!transaction) {
    throw new DatabaseError("Failed to create transaction");
  }
  return transaction;
}

/**
 * Get count of pending auto-detected transactions for a user.
 * BACKLOG-1124: Uses a SQL COUNT query instead of fetching all transactions
 * and filtering client-side, avoiding large IPC serialization overhead.
 */
export function getPendingTransactionCount(userId: string): number {
  const result = dbGet<{ count: number }>(
    "SELECT COUNT(*) as count FROM transactions WHERE user_id = ? AND detection_status = 'pending'",
    [userId],
  );
  return result?.count ?? 0;
}

/**
 * BACKLOG-2865: the attached emails of some set of transactions, in the shape
 * and the ORDER the linked-email count needs.
 *
 * `transactionScope` is a SQL fragment selecting transaction ids, spliced in as
 * a subselect so this stays ONE query no matter how many deals the list holds.
 * It carries no caller-supplied text of its own — the only call sites pass a
 * literal `?` or the same WHERE clause the transaction query just ran, with the
 * same bound params.
 *
 * TWO THINGS THAT ARE LOAD-BEARING:
 *
 * 1. INNER JOIN, not LEFT. It mirrors `getCommunicationsWithMessages`, whose
 *    channel is derived from the emails join: a `communications` row whose
 *    `email_id` points at no `emails` row comes back as channel 'unknown' and is
 *    dropped by `processEmailThreads`. The old `COUNT(DISTINCT c.email_id)`
 *    counted those rows — a divergence from the tab that predates this item and
 *    does not survive it.
 *
 * 2. `ORDER BY e.sent_at DESC` is the loader's order, and the de-duplication in
 *    `countLinkedEmailsByTransaction` keeps the first row per email id on that
 *    basis. Changing the order here silently changes which duplicate wins.
 */
function fetchScopedEmailRows(
  transactionScope: string,
  params: unknown[],
): ScopedEmailRow[] {
  return dbAll<ScopedEmailRow>(
    `SELECT c.transaction_id  as transaction_id,
            c.email_id       as email_id,
            c.match_reason   as match_reason,
            e.thread_id      as thread_id,
            e.subject        as subject
       FROM communications c
       INNER JOIN emails e ON e.id = c.email_id
      WHERE c.email_id IS NOT NULL
        AND c.transaction_id IN (${transactionScope})
      ORDER BY e.sent_at DESC`,
    params,
  );
}

/**
 * Get all transactions for a user
 */
export async function getTransactions(
  filters?: TransactionFilters,
): Promise<Transaction[]> {
  // BACKLOG-396: Use stored text_thread_count for texts (updated on link/unlink)
  //
  // BACKLOG-2865: `email_count` is NOT computed in this SQL any more. It was a
  // `COUNT(DISTINCT c.email_id)` subquery over EVERY attached email, and once
  // BACKLOG-2861 scoped the Emails tab to its linked list the card and the tab
  // described different sets — 9 on the card, "0 conversations (0 emails)" in
  // the tab, on the same deal. It is now derived below from the rules the tab
  // classifies with. Do not reintroduce a SQL count here: two producers of one
  // number is the shape this item exists to remove.
  let whereClause = " WHERE 1=1";
  const params: unknown[] = [];

  if (filters?.user_id) {
    whereClause += " AND t.user_id = ?";
    params.push(filters.user_id);
  }

  if (filters?.transaction_type) {
    whereClause += " AND t.transaction_type = ?";
    params.push(filters.transaction_type);
  }

  if (filters?.status) {
    whereClause += " AND t.status = ?";
    params.push(filters.status);
  }

  if (filters?.export_status) {
    whereClause += " AND t.export_status = ?";
    params.push(filters.export_status);
  }

  if (filters?.start_date) {
    whereClause += " AND t.closing_deadline >= ?";
    params.push(filters.start_date);
  }

  if (filters?.end_date) {
    whereClause += " AND t.closing_deadline <= ?";
    params.push(filters.end_date);
  }

  if (filters?.property_address) {
    whereClause += " AND t.property_address LIKE ?";
    params.push(`%${filters.property_address}%`);
  }

  const sql = `SELECT t.*,
             (SELECT COUNT(*) FROM communications c WHERE c.transaction_id = t.id) as total_communications_count
             FROM transactions t${whereClause} ORDER BY t.created_at DESC`;

  const transactions = dbAll<Transaction>(sql, params);
  if (transactions.length === 0) return transactions;

  // The SAME predicate the rows above were selected by, re-used as a subselect
  // rather than an `IN` list of ids: a user with a thousand deals would blow
  // SQLite's bound-variable limit, and re-deriving the filter by hand is how
  // the two halves drift apart.
  const counts = countLinkedEmailsByTransaction(
    fetchScopedEmailRows(`SELECT t.id FROM transactions t${whereClause}`, [
      ...params,
    ]),
  );
  for (const transaction of transactions) {
    transaction.email_count = counts.get(transaction.id) ?? 0;
  }

  return transactions;
}

/**
 * Get transaction by ID
 */
export async function getTransactionById(
  transactionId: string,
): Promise<Transaction | null> {
  return getTransactionByIdSync(transactionId);
}

/**
 * Create a deal AND attach every party on it in ONE transaction (BACKLOG-2538).
 *
 * THE DEFECT THIS REPLACES. Creating a deal was one INSERT followed by N
 * awaited assignments, unwrapped. `better-sqlite3` is synchronous, so every
 * statement outside a transaction commits before the next line runs — a throw
 * after the third of five parties left a deal that EXISTED, carried three
 * people, and marked nothing. It read as complete. Ranked third by damage in
 * the write-path audit (BACKLOG-2496).
 *
 * Both callees are the SYNC cores, deliberately. `dbTransaction` takes a
 * synchronous callback; calling the `async` facades here would let the
 * transaction commit over a rejected promise — see `createTransactionSync`.
 *
 * Communication auto-linking is NOT in here. It is a long network-and-scan
 * operation, and holding the single SQLite write lock across it would block
 * every other writer for its duration. It is also re-runnable, where a
 * half-written deal is not.
 */
export function createTransactionWithContactsSync(
  transactionData: NewTransaction,
  assignments: TransactionContactData[],
): Transaction {
  return dbTransaction(() => {
    const transaction = createTransactionSync(transactionData);
    for (const assignment of assignments) {
      assignContactToTransactionSync(transaction.id, assignment);
    }
    return transaction;
  });
}

/**
 * The synchronous core of `getTransactionById` (BACKLOG-2538).
 *
 * The body never awaited anything; the `async` was decoration. It has to be
 * reachable synchronously because `createTransactionSync` reads the row back
 * from inside a `dbTransaction` callback, which is synchronous.
 */
export function getTransactionByIdSync(
  transactionId: string,
): Transaction | null {
  // BACKLOG-446: Include email_count so list view and detail view agree.
  //
  // BACKLOG-2865: THIS producer is not optional to fix, and fixing only
  // `getTransactions` would have looked correct in every static test. This one
  // is what `getOverview` returns (handler → transactionService.getTransactionOverview
  // → databaseService.getTransactionById → here), and TransactionDetails re-reads
  // `email_count` from `getOverview` after every auto-sync (BACKLOG-2838). A card
  // scoped in one producer and not the other shows the scoped number on load and
  // flips to the unscoped one the moment anything refreshes behind the modal.
  const transaction = dbGet<Transaction>(
    "SELECT t.* FROM transactions t WHERE t.id = ?",
    [transactionId],
  );
  if (!transaction) return null;

  const counts = countLinkedEmailsByTransaction(
    fetchScopedEmailRows("SELECT ?", [transactionId]),
  );
  transaction.email_count = counts.get(transactionId) ?? 0;
  return transaction;
}

/**
 * Get transaction with associated contacts
 */
export async function getTransactionWithContacts(
  transactionId: string,
): Promise<TransactionWithContacts | null> {
  const transaction = await getTransactionById(transactionId);
  if (!transaction) {
    return null;
  }

  const contacts = await getTransactionContactsWithRoles(transactionId);

  const result: TransactionWithContacts = {
    ...transaction,
    all_contacts: contacts.map((tc) => ({
      id: tc.contact_id,
      user_id: transaction.user_id,
      name: tc.contact_name || "",
      email: tc.contact_email,
      phone: tc.contact_phone,
      company: tc.contact_company,
      title: tc.contact_title,
      source: "manual" as const,
      is_imported: true,
      created_at: tc.created_at,
      updated_at: tc.updated_at,
    })),
  };

  // Find specific role contacts
  const buyerAgent = contacts.find((c) => c.specific_role === "Buyer Agent");
  const sellerAgent = contacts.find((c) => c.specific_role === "Seller Agent");
  const escrowOfficer = contacts.find(
    (c) => c.specific_role === "Escrow Officer",
  );
  const inspector = contacts.find((c) => c.specific_role === "Inspector");

  if (buyerAgent) {
    result.buyer_agent = {
      id: buyerAgent.contact_id,
      user_id: transaction.user_id,
      name: buyerAgent.contact_name || "",
      email: buyerAgent.contact_email,
      phone: buyerAgent.contact_phone,
      company: buyerAgent.contact_company,
      title: buyerAgent.contact_title,
      source: "manual" as const,
      is_imported: true,
      created_at: buyerAgent.created_at,
      updated_at: buyerAgent.updated_at,
    };
  }

  if (sellerAgent) {
    result.seller_agent = {
      id: sellerAgent.contact_id,
      user_id: transaction.user_id,
      name: sellerAgent.contact_name || "",
      email: sellerAgent.contact_email,
      phone: sellerAgent.contact_phone,
      company: sellerAgent.contact_company,
      title: sellerAgent.contact_title,
      source: "manual" as const,
      is_imported: true,
      created_at: sellerAgent.created_at,
      updated_at: sellerAgent.updated_at,
    };
  }

  if (escrowOfficer) {
    result.escrow_officer = {
      id: escrowOfficer.contact_id,
      user_id: transaction.user_id,
      name: escrowOfficer.contact_name || "",
      email: escrowOfficer.contact_email,
      phone: escrowOfficer.contact_phone,
      company: escrowOfficer.contact_company,
      title: escrowOfficer.contact_title,
      source: "manual" as const,
      is_imported: true,
      created_at: escrowOfficer.created_at,
      updated_at: escrowOfficer.updated_at,
    };
  }

  if (inspector) {
    result.inspector = {
      id: inspector.contact_id,
      user_id: transaction.user_id,
      name: inspector.contact_name || "",
      email: inspector.contact_email,
      phone: inspector.contact_phone,
      company: inspector.contact_company,
      title: inspector.contact_title,
      source: "manual" as const,
      is_imported: true,
      created_at: inspector.created_at,
      updated_at: inspector.updated_at,
    };
  }

  return result;
}

/**
 * BACKLOG-2181: normalize a frozen-identity-field value for equality
 * comparison between an incoming update and the currently stored row.
 *
 * - `property_coordinates` may arrive as an object (see the JSON.stringify
 *   branch below in `updateTransaction`) or already as the stored JSON
 *   string — normalize both to the same string so a no-op re-submit compares
 *   equal regardless of shape.
 * - Treat null/undefined/empty-string as the same "unset" value so a re-save
 *   that omits vs. explicitly nulls an already-empty field isn't flagged as a
 *   change.
 */
function normalizeFrozenFieldValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (field === "property_coordinates" && typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Update transaction
 */
export async function updateTransaction(
  transactionId: string,
  updates: Partial<Transaction>,
): Promise<void> {
  // BACKLOG-2558 — there is no `allowedFields` array here any more.
  //
  // The 46-name array this replaces invented 11 columns that exist in no table
  // and omitted 23 real ones, including `detection_status`, `reviewed_at` and
  // `rejection_reason` — which is why Approve wrote 1 of its 3 fields and
  // returned success, and why Reject (which sends no `status`) had every field
  // dropped and threw "No valid fields to update".
  //
  // The accepted set is now derived from TRANSACTION_COLUMN_POLICY above, so a
  // column cannot be forgotten without a compile error.

  // Validate status if it's being updated
  if (updates.status !== undefined) {
    validateTransactionStatus(updates.status);
  }

  // BACKLOG-2013 — EXPORT FREEZE ENFORCEMENT (db layer = the guarantee).
  //
  // Pull the override sentinel out of `updates` first so it never reaches the
  // column loop. Callers set it only on the trusted paths that legitimately
  // mutate the freeze state itself (export handler stamping first_exported_at;
  // admin unfreeze clearing it).
  const updatesRecord = updates as Record<string, unknown>;
  const hasUnfreezeOverride = updatesRecord[UNFREEZE_OVERRIDE_KEY] === true;
  if (UNFREEZE_OVERRIDE_KEY in updatesRecord) {
    delete updatesRecord[UNFREEZE_OVERRIDE_KEY];
  }

  // If the caller is touching any identity field, check the freeze marker. We
  // only pay for the extra read when an identity field is actually in play, so
  // the common case (bookkeeping updates: status, counts, export tracking) is
  // unaffected.
  //
  // BACKLOG-2181: the guard is VALUE-aware, not just key-aware. Re-submitting
  // an unchanged frozen field (e.g. re-exporting, or widening only the end
  // date while `start_date` rides along unchanged in the same payload) must
  // NOT be blocked — only a genuine change to a frozen field's value throws.
  const attemptedFrozen = frozenFieldsInUpdate(Object.keys(updatesRecord));
  if (attemptedFrozen.length > 0 && !hasUnfreezeOverride) {
    const selectCols = ["first_exported_at", ...FROZEN_IDENTITY_FIELDS].join(", ");
    const current = dbGet<Record<string, unknown>>(
      `SELECT ${selectCols} FROM transactions WHERE id = ?`,
      [transactionId],
    );
    if (isTransactionFrozen((current as { first_exported_at: string | null } | undefined) ?? undefined)) {
      const changedFrozen = attemptedFrozen.filter((field) => {
        const incoming = normalizeFrozenFieldValue(field, updatesRecord[field]);
        const existing = normalizeFrozenFieldValue(field, current?.[field]);
        return incoming !== existing;
      });

      if (changedFrozen.length > 0) {
        // BACKLOG-2146 — the thrown message is surfaced verbatim to the user, so
        // it must be HUMAN (no raw snake_case column names). The precise frozen
        // field list stays in the log and on the typed error's `attemptedFields`
        // for developers/support; it is never dumped at the user.
        logService.info(
          "Blocked edit to frozen identity anchor(s) after export",
          "TransactionDbService",
          { transactionId, attemptedFrozen: changedFrozen },
        );
        throw new TransactionFrozenError(
          transactionId,
          "This transaction has been exported — its address and audit start date are locked to protect the audit record. Contact support to correct a genuine typo.",
          changedFrozen,
        );
      }
    }
  }

  const fields: FieldExpression<TransactionColumn>[] = [];
  const values: unknown[] = [];
  /** Keys that will NOT be written, and the recorded reason. */
  const dropped: Array<{ key: string; reason: string }> = [];

  for (const key of Object.keys(updatesRecord)) {
    // `isValidField` is Phase 1's type predicate: it narrows this plain string
    // to `TransactionColumn`, so the policy lookup and the `${key} = ?` below
    // need no cast. That is what retires the BACKLOG-2739 Phase 1 seam cast
    // that used to sit under `validateFields` here.
    if (!isValidField("transactions", key)) {
      dropped.push({ key, reason: "not a column of transactions" });
      continue;
    }

    const policy = TRANSACTION_COLUMN_POLICY[key];
    if (policy.update !== "writable") {
      dropped.push({ key, reason: `${policy.update}: ${policy.why}` });
      continue;
    }

    fields.push(`${key} = ?`);
    values.push(bindValue(key, updatesRecord[key], "update"));
  }

  // Validate field names against the whitelist BEFORE anything is raised or
  // built. BACKLOG-2558: this call used to run AFTER the local filter had
  // already discarded the drifted keys and after the empty-set throw, so the
  // one check the codebase relies on to catch drift could never see it.
  validateFields("transactions", fields);

  if (fields.length === 0) {
    // BACKLOG-2558: the error now carries the evidence. The old message named
    // nothing, so a caller whose entire payload had been discarded — which is
    // exactly what happened to Reject — was told only that "no valid fields"
    // existed, with no way to see which fields it had sent.
    logService.warn("Transaction update dropped every field", "TransactionDbService", {
      transactionId,
      dropped,
    });
    throw new DatabaseError(
      dropped.length === 0
        ? "No valid fields to update. The update payload was empty."
        : `No valid fields to update. Dropped: ${dropped
            .map((d) => `${d.key} (${d.reason.split(":")[0]})`)
            .join(", ")}`,
    );
  }

  if (dropped.length > 0) {
    // Not silent: a partially-dropped payload says so, with the decision that
    // dropped it, so the next BACKLOG-2558 is visible in a log rather than
    // inferred from a stuck row.
    logService.debug("Transaction update skipped non-writable keys", "TransactionDbService", {
      transactionId,
      dropped,
    });
  }

  values.push(transactionId);

  const sql = `UPDATE transactions SET ${fields.join(", ")} WHERE id = ?`;
  const result = dbRun(sql, values);

  logService.debug("Transaction update result", "TransactionDbService", {
    transactionId,
    fields,
    rowsChanged: result.changes,
  });

  if (result.changes === 0) {
    logService.warn("Transaction update changed 0 rows", "TransactionDbService", {
      transactionId,
      fields,
    });
  }
}

/**
 * BACKLOG-2013 — stamp the export-freeze marker (`first_exported_at`) write-once
 * at the SQL layer. The `WHERE first_exported_at IS NULL` predicate makes the
 * boundary immutable in the database itself: a second (or racing) export can
 * never move it, independent of caller convention. Returns true iff this call
 * was the one that set the marker (`changes === 1`); a false return means the
 * transaction was already frozen and the boundary was left untouched.
 *
 * Does NOT go through `updateTransaction` on purpose — that path builds a
 * generic `WHERE id = ?` update, which cannot express the write-once guard.
 */
export function stampFirstExportedAt(
  transactionId: string,
  timestamp: string,
): boolean {
  const result = dbRun(
    "UPDATE transactions SET first_exported_at = ? WHERE id = ? AND first_exported_at IS NULL",
    [timestamp, transactionId],
  );
  return result.changes === 1;
}

/**
 * Delete transaction
 */
export async function deleteTransaction(transactionId: string): Promise<void> {
  const sql = "DELETE FROM transactions WHERE id = ?";
  dbRun(sql, [transactionId]);
}

/**
 * Find existing transactions by property addresses for a user.
 * Used for deduplication during import to efficiently check if transactions
 * already exist before creating new ones.
 *
 * @param userId - The user ID to scope the search
 * @param propertyAddresses - Array of property addresses to look up
 * @returns Map of normalized property address to existing transaction ID
 */
export async function findExistingTransactionsByAddresses(
  userId: string,
  propertyAddresses: string[],
): Promise<Map<string, string>> {
  if (propertyAddresses.length === 0) {
    return new Map();
  }

  // Normalize addresses for comparison (lowercase, trim whitespace)
  const normalizedAddresses = propertyAddresses.map((addr) =>
    addr.toLowerCase().trim()
  );

  // Build SQL with placeholders for all addresses
  const placeholders = normalizedAddresses.map(() => "LOWER(TRIM(property_address)) = ?").join(" OR ");
  const sql = `
    SELECT id, property_address
    FROM transactions
    WHERE user_id = ? AND (${placeholders})
  `;

  const params = [userId, ...normalizedAddresses];
  const results = dbAll<{ id: string; property_address: string }>(sql, params);

  // Build map of normalized address -> transaction ID
  const addressMap = new Map<string, string>();
  for (const row of results) {
    const normalizedAddr = row.property_address.toLowerCase().trim();
    addressMap.set(normalizedAddr, row.id);
  }

  return addressMap;
}
