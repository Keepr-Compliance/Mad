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

import type { TransactionStatus } from "../types/models";

/**
 * The status that marks a deal dead. Typed against the status union so that
 * adding a new `TransactionStatus` value forces a decision here rather than
 * silently defaulting the new status to "eligible".
 */
export const REJECTED_TRANSACTION_STATUS: TransactionStatus = "rejected";

/**
 * SQL fragment selecting LIVE transactions, for use in a WHERE clause where the
 * `transactions` table is aliased `t`.
 *
 * Interpolated as a constant, never built from input — there is no injection
 * surface and no parameter to bind.
 *
 * NULL status is excluded (see the module docblock).
 */
export const LIVE_TRANSACTION_SQL_PREDICATE = `t.status != '${REJECTED_TRANSACTION_STATUS}'`;

/**
 * The same fragment for queries that read `transactions` unaliased.
 */
export const LIVE_TRANSACTION_SQL_PREDICATE_UNALIASED = `status != '${REJECTED_TRANSACTION_STATUS}'`;

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
