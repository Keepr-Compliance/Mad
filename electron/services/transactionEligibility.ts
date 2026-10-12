/**
 * Transaction eligibility — the ONE definition of "is this deal live?".
 *
 * BACKLOG-2562. A deal's status decides whether it receives auto-linked
 * communications, whether its property address competes as a disambiguation
 * candidate, and whether it carries an audit-completeness obligation. That rule
 * was previously written out by hand at every reader, and the copies drifted:
 *
 *   - The correct form is `status != 'rejected'`. A rejected deal is dead —
 *     the user said "this is not a transaction" — so it must stop receiving
 *     mail and stop competing for it.
 *   - The stale form was `status != 'archived'`. `'archived'` is NOT a
 *     permitted status (schema.sql CHECK admits only pending|active|closed|
 *     rejected, and `validateTransactionStatus` throws on it), so that
 *     predicate was a tautology over every row the CHECK admits — it excluded
 *     nothing and, in particular, INCLUDED rejected deals.
 *
 * BACKLOG-2308/2772 migrated the import-floor and export-gate readers off the
 * dead form. `autoLinkService` never got migrated, which is the defect this
 * module closes. The rule now lives once so the next reader cannot drift.
 *
 * ---------------------------------------------------------------------------
 * NULL status: the SQL and JS forms deliberately DISAGREE, and both are
 * transcriptions of existing behaviour rather than new decisions.
 *
 *   - SQL: `t.status != 'rejected'` against a NULL status evaluates to NULL,
 *     which is not TRUE, so a NULL-status row is EXCLUDED by the WHERE clause.
 *     This matches the dead `!= 'archived'` form it replaces (identical NULL
 *     behaviour), so migrating a site is behaviour-neutral for NULL rows.
 *   - JS: `isLiveTransactionStatus(null)` returns TRUE — a NULL-status deal is
 *     treated as live. This matches `auditCoverageService`'s existing
 *     `txn?.status === "rejected"` early-return, which is false for NULL.
 *
 * Unifying the two is a BEHAVIOUR CHANGE at multiple sites (it would mean
 * either COALESCE-ing the SQL to treat NULL as live, or excluding NULL-status
 * deals from the audit gate). That needs a product decision and is explicitly
 * NOT folded in here — see BACKLOG-2562 open question 1.
 * ---------------------------------------------------------------------------
 */

import type { SubmissionStatus, TransactionStatus } from "../types/models";

/**
 * The status that marks a deal dead. Typed against the status union so that
 * adding a new `TransactionStatus` value forces a decision here rather than
 * silently defaulting the new status to "eligible".
 */
export const REJECTED_TRANSACTION_STATUS: TransactionStatus = "rejected";

/*
 * ---------------------------------------------------------------------------
 * The SQL form of the rule lives in `db/core/transactionEligibilitySql.ts`
 * (BACKLOG-3103) — `LIVE_TRANSACTION_SQL_PREDICATE`,
 * `LIVE_TRANSACTION_SQL_PREDICATE_UNALIASED` and `withLiveTransactionParam`.
 *
 * It used to live here, hand-quoting the constant above into SQL text, with a
 * docblock claiming "there is no injection surface and no parameter to bind".
 * The first half was true; the second was the defect. A status is a VALUE, so it
 * binds, and text authored outside `db/**` is what the whole SQL-brand epic
 * exists to end. The rule is still defined once — this file owns the VALUE and
 * the JS comparison, `db/core` owns the SQL spelling and its parameter.
 * ---------------------------------------------------------------------------
 */

/**
 * JS form of the rule, for readers that already hold the row.
 *
 * A NULL/undefined status is treated as LIVE (see the module docblock) — this
 * transcribes `auditCoverageService`'s pre-existing `status === "rejected"`
 * early return and is NOT the same NULL handling as the SQL predicate.
 */
export function isLiveTransactionStatus(status: string | null | undefined): boolean {
  return status !== REJECTED_TRANSACTION_STATUS;
}

// ---------------------------------------------------------------------------
// BACKLOG-3910 (slice b): the LOCKED-DEAL state.
// ---------------------------------------------------------------------------
//
// One answer to "may Keepr add anything to this deal on its own?", read from
// `transactions.submission_status`. A locked deal gets no automatic links and
// no new Needs Review items from any path, and every user edit handler
// refuses it (`refuseIfDealLocked` in dealLockState.ts): contacts, emails,
// texts and Needs Review (founder 2026-10-11), checklists and deal details
// (founder 2026-10-12). Two reasons, because the founder wants one locked state with two
// meanings:
//
//   "submitted"  the deal is with the broker. Locked while the broker reviews;
//                unlocks when the broker asks for changes or rejects it.
//   "sealed"     permanent. In 2.41 the only producer is `approved`;
//                BACKLOG-2229 adds closed (Complete) deals.
//
// Every gate tests `dealLockReason(...) !== null`, so adding a producer later
// changes no gate.
//
// THE RENDERER MIRROR is `src/utils/dealLock.ts` (nothing under `electron/`
// may import from `src/`, and the renderer cannot value-import from here).
// `src/utils/__tests__/dealLock.parity.test.ts` imports both and fails when
// they disagree, and fails when the schema's CHECK list gains a status this
// map does not name.

export type DealLockReason = "submitted" | "sealed";

/**
 * Every submission status, and what it means for locking. `null` = open.
 * Exhaustive over `SubmissionStatus` (the type makes a missing key an error).
 */
export const DEAL_LOCK_REASON_BY_STATUS: Readonly<
  Record<SubmissionStatus, DealLockReason | null>
> = {
  not_submitted: null,
  submitted: "submitted",
  under_review: "submitted",
  resubmitted: "submitted",
  needs_changes: null,
  rejected: null,
  approved: "sealed",
};

/**
 * Why this deal is locked, or `null` when Keepr may still add to it.
 * NULL / unknown status = open (the column defaults to 'not_submitted').
 */
export function dealLockReason(
  submissionStatus: string | null | undefined,
): DealLockReason | null {
  if (!submissionStatus) return null;
  if (!Object.prototype.hasOwnProperty.call(DEAL_LOCK_REASON_BY_STATUS, submissionStatus)) {
    return null;
  }
  return DEAL_LOCK_REASON_BY_STATUS[submissionStatus as SubmissionStatus];
}

/**
 * BACKLOG-3910a: every submission status that locks a deal, DERIVED from
 * `DEAL_LOCK_REASON_BY_STATUS` so there is one list and no second spelling.
 * Bound into the email Force Re-cache's frozen-set SQL.
 */
export const LOCKED_SUBMISSION_STATUSES: readonly SubmissionStatus[] = (
  Object.keys(DEAL_LOCK_REASON_BY_STATUS) as SubmissionStatus[]
).filter((status) => DEAL_LOCK_REASON_BY_STATUS[status] !== null);
