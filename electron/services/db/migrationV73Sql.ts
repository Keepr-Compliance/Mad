/**
 * SQL for migration v73 — BACKLOG-3519 (Commission M2, figures only).
 *
 * Moved out of `electron/services/databaseService.ts` for the same SQL
 * boundary rule migrationV71Sql.ts documents: SQL text is DEFINED under
 * `electron/services/db/` and imported, never inlined in the migration body.
 *
 * Adds four nullable columns to `transactions`: the commission rate the agent
 * was offered, the rate that actually applied, the gross commission computed
 * from them (whole dollars, rounded half up, once by the writer; never derived
 * on read), and an optional free-text reason for a rate change. No index — nothing queries
 * by these values. Figures only: no split is stored or resolved; see
 * schema.sql's comment on this section and pm_comments on BACKLOG-3519.
 *
 * Every statement here is fully static; nothing is built by interpolating a
 * caller's value.
 */

/** Does `transactions` already carry the v73 columns? A fresh install does. */
export const V73_TRANSACTIONS_TABLE_INFO_SQL = "PRAGMA table_info(transactions)";

export const V73_ADD_COMMISSION_COLUMNS_SQL = `ALTER TABLE transactions ADD COLUMN commission_offered_rate REAL;
ALTER TABLE transactions ADD COLUMN commission_actual_rate REAL;
ALTER TABLE transactions ADD COLUMN commission_gross_amount REAL;
ALTER TABLE transactions ADD COLUMN commission_adjustment_reason TEXT;`;
