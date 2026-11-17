/**
 * SQL for migration v82 — BACKLOG-4263 PR-4b (two-way todos: the desktop pulls).
 *
 * Same SQL boundary rule as migrationV81Sql.ts: SQL text is DEFINED under
 * `electron/services/db/` and imported, never inlined in the migration body.
 *
 * Adds two nullable columns to `cloud_sync_todo_cursor`, each behind a
 * column-exists guard (a fresh install already has both from schema.sql,
 * which runs before the chain; so does a v80 profile, whose cursor table
 * schema.sql creates with them):
 * - `horizon`: the pull horizon the server sent with the page whose
 *   `next_after` is stored in `last_seq` (contract cloud-todo-change-v1.json
 *   `pull.cursor`: the desktop sends both back). NULL until the first page.
 * - `full_pull_kind`: 'restore' while the full pull owed after a backup
 *   restore has not finished (the cloud's values win in that pull); NULL
 *   otherwise.
 * Both are NULL on every existing row; no existing row is written. No
 * trigger, index or view names either column.
 */
export const V82_CURSOR_TABLE_INFO_SQL = "PRAGMA table_info(cloud_sync_todo_cursor)";

export const V82_ADD_HORIZON_SQL = "ALTER TABLE cloud_sync_todo_cursor ADD COLUMN horizon INTEGER;";

export const V82_ADD_FULL_PULL_KIND_SQL = "ALTER TABLE cloud_sync_todo_cursor ADD COLUMN full_pull_kind TEXT;";
