/**
 * SQL for migration v74 — BACKLOG-3619 (Google Messages import): the local
 * tables of the RCS import, folded into ONE versioned migration (SR whole-
 * branch review: 18 rcs_* tables plus message_source_coverage had no
 * migration, which is what the schema-parity suite caught).
 *
 * Same SQL boundary rule as migrationV71Sql.ts: SQL text is DEFINED under
 * electron/services/db/ and imported, never inlined in the migration body.
 *
 * Every statement is CREATE … IF NOT EXISTS, copied from schema.sql (comments
 * dropped) — a no-op on a fresh install (schema.sql's exec already created
 * them) and on a database that already has them (the founder's test copy);
 * it creates them on any database that does not.
 * databaseService.migration-v74.test.ts holds this list identical to
 * schema.sql's statements: a table changed in one place only fails there.
 *
 * Every statement here is fully static; nothing is built by interpolating a
 * caller's value.
 */

/** The RCS import's local tables and indexes (as in schema.sql), in schema.sql's order. */
export const V74_RCS_LOCAL_TABLES_SQL: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS rcs_cache_state (\n  user_id TEXT PRIMARY KEY,\n  opted_in_at DATETIME,\n  last_cache_finished_at DATETIME,\n  own_number TEXT,\n  extension_version TEXT,\n  extension_seen_at DATETIME,\n  paired_at DATETIME,\n  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS rcs_cache_staging_chats (\n  job_id TEXT NOT NULL,\n  user_id TEXT NOT NULL,\n  chat_hash TEXT NOT NULL,\n  conversation_id TEXT NOT NULL,\n  title TEXT NOT NULL DEFAULT '',\n  people_json TEXT NOT NULL,\n  staged_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (job_id, chat_hash)\n);",
  "CREATE TABLE IF NOT EXISTS rcs_cache_staging_messages (\n  job_id TEXT NOT NULL,\n  chat_hash TEXT NOT NULL,\n  msg_id TEXT NOT NULL,\n  sent_at TEXT NOT NULL,\n  seq INTEGER NOT NULL,\n  message_json TEXT NOT NULL,\n  PRIMARY KEY (job_id, chat_hash, msg_id)\n);",
  "CREATE INDEX IF NOT EXISTS idx_rcs_cache_staging_messages_sent ON rcs_cache_staging_messages(job_id, sent_at);",
  "CREATE TABLE IF NOT EXISTS rcs_cache_staging_images (\n  job_id TEXT NOT NULL,\n  chat_hash TEXT NOT NULL,\n  msg_id TEXT NOT NULL,\n  idx INTEGER NOT NULL,\n  mime_type TEXT NOT NULL,\n  byte_size INTEGER NOT NULL,\n  sha256 TEXT NOT NULL,\n  temp_path TEXT NOT NULL,\n  PRIMARY KEY (job_id, chat_hash, msg_id, idx)\n);",
  "CREATE TABLE IF NOT EXISTS rcs_cache_staging_jobs (\n  job_id TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL,\n  started_at TEXT NOT NULL,\n  limits_json TEXT NOT NULL,\n  read_json TEXT NOT NULL\n);",
  "CREATE TABLE IF NOT EXISTS rcs_cache_staging_chat_meta (\n  job_id TEXT NOT NULL,\n  chat_hash TEXT NOT NULL,\n  chat_floor_ms INTEGER,\n  read_floor_ms INTEGER,\n  reached_floor INTEGER NOT NULL DEFAULT 0,\n  read_at TEXT NOT NULL,\n  PRIMARY KEY (job_id, chat_hash)\n);",
  "CREATE TABLE IF NOT EXISTS rcs_chat_reads (\n  user_id TEXT NOT NULL,\n  chat_hash TEXT NOT NULL,\n  read_at TEXT NOT NULL,\n  reached_floor INTEGER NOT NULL DEFAULT 0,\n  PRIMARY KEY (user_id, chat_hash),\n  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS rcs_cache_failed_run (\n  user_id TEXT PRIMARY KEY,\n  started_at TEXT NOT NULL,\n  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS rcs_cache_placed_files (\n  path TEXT PRIMARY KEY,\n  job_id TEXT NOT NULL,\n  placed_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);",
  "CREATE TABLE IF NOT EXISTS rcs_consent (\n  user_id TEXT PRIMARY KEY,\n  consent_at DATETIME,\n  consent_version INTEGER,\n  contacts_only INTEGER NOT NULL DEFAULT 0,\n  auto_delete_days INTEGER,\n  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS rcs_chat_exclusions (\n  id TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL,\n  chat_hash TEXT,\n  conversation_id TEXT,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE\n);",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_rcs_chat_exclusions_conv ON rcs_chat_exclusions(user_id, conversation_id) WHERE conversation_id IS NOT NULL;",
  "CREATE INDEX IF NOT EXISTS idx_rcs_chat_exclusions_hash ON rcs_chat_exclusions(user_id, chat_hash);",
  "CREATE TABLE IF NOT EXISTS rcs_pending_full_sync (\n  id TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL,\n  conversation_id TEXT,\n  chat_hash TEXT,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE\n);",
  "CREATE INDEX IF NOT EXISTS idx_rcs_pending_full_sync_user ON rcs_pending_full_sync(user_id);",
  "CREATE TABLE IF NOT EXISTS rcs_extension_pairings (\n  pair_id TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL,\n  key_hex TEXT NOT NULL,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS rcs_media_options (\n  user_id TEXT PRIMARY KEY,\n  photos_all_chats INTEGER NOT NULL DEFAULT 1,\n  videos_all_chats INTEGER NOT NULL DEFAULT 0,\n  last_photos_seen INTEGER,\n  last_videos_seen INTEGER,\n  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS rcs_pending_media (\n  user_id TEXT PRIMARY KEY,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS rcs_chat_people (\n  user_id TEXT NOT NULL,\n  chat_hash TEXT NOT NULL,\n  number_e164 TEXT NOT NULL,\n  name TEXT,\n  last_message_at DATETIME,\n  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (user_id, chat_hash, number_e164),\n  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE\n);",
  "CREATE INDEX IF NOT EXISTS idx_rcs_chat_people_number ON rcs_chat_people(user_id, number_e164);",
  "CREATE TABLE IF NOT EXISTS rcs_cache_runs (\n  user_id TEXT PRIMARY KEY,\n  floor_iso DATETIME NOT NULL,\n  full_read INTEGER NOT NULL DEFAULT 0,\n  list_stop TEXT,\n  reached_floor INTEGER NOT NULL DEFAULT 0,\n  not_settled_chats INTEGER NOT NULL DEFAULT 0,\n  finished_at DATETIME NOT NULL,\n  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS rcs_chat_coverage (\n  user_id TEXT NOT NULL,\n  chat_hash TEXT NOT NULL,\n  covered_since DATETIME NOT NULL,\n  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (user_id, chat_hash),\n  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE\n);",
  "CREATE TABLE IF NOT EXISTS message_source_coverage (\n  user_id TEXT NOT NULL,\n  source TEXT NOT NULL,\n  covered_since DATETIME,\n  last_sync_at DATETIME,\n  PRIMARY KEY (user_id, source),\n  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE\n);",
];

/** The tables among them (for the column check). */
export const V74_RCS_TABLES: readonly string[] = V74_RCS_LOCAL_TABLES_SQL
  .map((s) => /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(s)?.[1])
  .filter((t): t is string => !!t);

/** A table's columns (main), or its reference copy's (temp). Names come from the fixed list above only. */
export function v74TableInfoSql(which: "main" | "ref", table: string): string {
  if (!V74_RCS_TABLES.includes(table)) throw new Error(`v74: not an RCS table: ${table}`);
  return which === "main" ? `PRAGMA main.table_info(${table})` : `PRAGMA temp.table_info(v74ref_${table})`;
}

/**
 * A table statement as a TEMP reference copy (v74ref_<table>) — what the
 * column check compares against. TEMP, not an attached database: migrations
 * run inside a transaction, where ATTACH is refused.
 */
export function v74RefTableSql(statement: string): string {
  return statement.replace(/^CREATE TABLE IF NOT EXISTS (\w+)/, "CREATE TEMP TABLE v74ref_$1");
}

/** Drop a reference copy. */
export function v74DropRefSql(table: string): string {
  if (!V74_RCS_TABLES.includes(table)) throw new Error(`v74: not an RCS table: ${table}`);
  return `DROP TABLE IF EXISTS temp.v74ref_${table}`;
}

/** ALTER TABLE … ADD COLUMN for a column the reference has and the database lacks. */
export function v74AddColumnSql(table: string, column: { name: string; type: string; notnull: number; dflt_value: string | null }): string {
  if (!V74_RCS_TABLES.includes(table)) throw new Error(`v74: not an RCS table: ${table}`);
  if (!/^\w+$/.test(column.name) || !/^[\w ()]*$/.test(column.type)) throw new Error("v74: unexpected column shape");
  // SQLite refuses ADD COLUMN with a non-constant default (CURRENT_TIMESTAMP):
  // such a column is added plain (nullable) — rows written later fill it.
  const constantDefault = column.dflt_value !== null && !/^CURRENT_/i.test(column.dflt_value);
  const dflt = constantDefault ? ` DEFAULT ${column.dflt_value}` : "";
  const notNull = column.notnull && constantDefault ? " NOT NULL" : "";
  return `ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.type}${notNull}${dflt}`;
}
