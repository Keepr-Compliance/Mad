/**
 * SQL for migration v81 — BACKLOG-4263 PR-3 (two-way todos, local side).
 *
 * Same SQL boundary rule as migrationV71Sql.ts: SQL text is DEFINED under
 * `electron/services/db/` and imported, never inlined in the migration body.
 *
 * Adds two nullable columns, each behind a column-exists guard (a fresh install
 * already has both from schema.sql, which runs before the chain):
 * - `transaction_checklist_items.due_date`: YYYY-MM-DD between 2000 and 2100,
 *   NULL for every existing item. SQLite tests an added column's CHECK against
 *   every existing row; all are NULL, so it passes.
 * - `cloud_sync_settings.install_removed_at` (plan E1): set when this
 *   computer's online copy was removed elsewhere; NULL for every existing row.
 *
 * Also creates the todo tables (IF NOT EXISTS; schema.sql already did on any
 * open). No index, trigger or view names either column in schema.sql (see v75).
 * Every statement here is fully static.
 */
import { CLOUD_SYNC_TODO_TABLES_DDL } from "./cloudSyncTodoSql";

export const V81_ITEMS_TABLE_INFO_SQL = "PRAGMA table_info(transaction_checklist_items)";
export const V81_SETTINGS_TABLE_INFO_SQL = "PRAGMA table_info(cloud_sync_settings)";

/** Identical to the column in schema.sql. */
export const V81_ADD_DUE_DATE_SQL =
  "ALTER TABLE transaction_checklist_items ADD COLUMN due_date TEXT CHECK (due_date IS NULL OR (date(due_date) IS due_date AND due_date BETWEEN '2000-01-01' AND '2100-12-31'));";

export const V81_ADD_INSTALL_REMOVED_AT_SQL = "ALTER TABLE cloud_sync_settings ADD COLUMN install_removed_at TEXT;";

export const V81_TODO_TABLES_DDL = CLOUD_SYNC_TODO_TABLES_DDL;
