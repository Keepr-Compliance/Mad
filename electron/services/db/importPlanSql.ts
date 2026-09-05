/**
 * SQL for the import plan's transaction window — BACKLOG-3044 PR 5.
 *
 * Moved out of `electron/services/importPlanInputs.ts` (1 site). The import plan decides
 * how far back to fetch, and the answer is bounded by the user's LIVE deals: a rejected
 * transaction should not widen the window and pull in months of correspondence nobody
 * asked for.
 *
 * ## This statement was BLOCKED until BACKLOG-3103, and it is the unaliased case
 *
 * It splices `LIVE_TRANSACTION_SQL_PREDICATE_UNALIASED` — the variant for a query that
 * reads `transactions` without a table alias. Until 3103 that fragment was
 * `` `status != '${REJECTED_TRANSACTION_STATUS}'` ``, a status VALUE in SQL text, which
 * the tag correctly refused; it is now `` sql`status != ?` `` and composes.
 *
 * The eligibility placeholder is the LAST one in the statement, which is the contract
 * `withLiveTransactionParam` exists to keep. That call stays at the CALLER, with the
 * params array it appends to.
 *
 * Text is byte-identical to what it replaced, verified by
 * `scripts/ci/sql-move-identity.mjs`; its text occurs exactly once in the tree, so that
 * check's exit code is load-bearing for it.
 */

import { sql } from "./core/sqlText";
import { LIVE_TRANSACTION_SQL_PREDICATE_UNALIASED } from "./core/transactionEligibilitySql";

/**
 * The date bounds of every LIVE transaction for a user. Bound: user id, then the
 * eligibility value last via `withLiveTransactionParam`.
 *
 * All three of `started_at`, `created_at` and `closed_at` are selected because the
 * caller takes the widest defensible window and a transaction may be missing any one of
 * them — narrowing here would silently shorten the import.
 */
export const LIVE_TRANSACTION_WINDOWS_SQL = sql`SELECT started_at, created_at, closed_at
       FROM transactions
      WHERE user_id = ? AND ${LIVE_TRANSACTION_SQL_PREDICATE_UNALIASED}`;
