/**
 * SQL for migration v84 — BACKLOG-4263 PR-6 (the todo screens).
 *
 * Same SQL boundary rule as migrationV81Sql.ts: SQL text is DEFINED under `electron/services/db/` and imported,
 * never inlined in the migration body.
 *
 * - `cloud_sync_todo_state.changed_json`: nullable, behind a column-exists guard (a fresh install, and any profile
 *   whose shadow table schema.sql creates, already has it). The latest AI-app change of a todo as the server feed
 *   reported it: `{"part", "by", "at"}`. Written only by the puller (cloudSyncTodoPullDb.ts); the confirm path
 *   clears it when this computer's own change of that part is confirmed. NULL on every existing row.
 * - `idx_cloud_sync_todo_notices_seq`: CREATE INDEX IF NOT EXISTS on the notices table.
 * No existing row is written. Re-runnable. 2.48.0 neither reads nor writes either.
 */
export const V84_STATE_TABLE_INFO_SQL = "PRAGMA table_info(cloud_sync_todo_state)";

export const V84_ADD_CHANGED_JSON_SQL = "ALTER TABLE cloud_sync_todo_state ADD COLUMN changed_json TEXT;";

export const V84_NOTICES_TABLE_INFO_SQL = "PRAGMA table_info(cloud_sync_todo_notices)";

export const V84_NOTICES_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS idx_cloud_sync_todo_notices_seq ON cloud_sync_todo_notices (project_ref, owner_user_id, kind, change_seq);";
