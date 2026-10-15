/**
 * SQL for migration v75 — BACKLOG-3764 (checklist links to evidence outside
 * the deal's audit dates).
 *
 * Same SQL boundary rule as migrationV71Sql.ts: SQL text is DEFINED under
 * `electron/services/db/` and imported, never inlined in the migration body.
 *
 * Adds `transaction_checklist_links.include_outside_dates`: 1 when the agent
 * answered "Include it" for a group with evidence dated outside the deal's
 * audit dates, so the submission sends that group regardless of the dates.
 * 0 (the default) for every link that exists before this migration and for
 * every link made inside the dates.
 *
 * `ADD COLUMN … NOT NULL DEFAULT 0` is valid in SQLite because the default is
 * not NULL. No index, trigger or view names this column in schema.sql: schema.sql
 * is exec'd on every launch BEFORE the versioned migrations, so a statement
 * there naming the column would abort every pre-v75 database before this
 * migration could add it (databaseService.migration-v75.test.ts, C11).
 *
 * Every statement here is fully static; nothing is built by interpolating a
 * caller's value.
 */

/** Does `transaction_checklist_links` already carry the column? A fresh install does. */
export const V75_CHECKLIST_LINKS_TABLE_INFO_SQL = "PRAGMA table_info(transaction_checklist_links)";

export const V75_ADD_INCLUDE_OUTSIDE_DATES_SQL =
  "ALTER TABLE transaction_checklist_links ADD COLUMN include_outside_dates INTEGER NOT NULL DEFAULT 0;";
