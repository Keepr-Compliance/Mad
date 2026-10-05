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
 * it creates them on any database that does not. No column changes: no
 * commit on the branch added a column to an existing rcs_* table.
 * databaseService.migration-v74.test.ts holds this list identical to
 * schema.sql's statements: a table changed in one place only fails there.
 *
 * Every statement here is fully static; nothing is built by interpolating a
 * caller's value.
 */

/**
 * The RCS import's local tables and indexes (as in schema.sql), in schema.sql's
 * order — ONE literal, executed as is (the SQL boundary gate traces it).
 */
export const V74_RCS_LOCAL_TABLES_DDL = `CREATE TABLE IF NOT EXISTS rcs_cache_state (
  user_id TEXT PRIMARY KEY,
  opted_in_at DATETIME,
  last_cache_finished_at DATETIME,
  own_number TEXT,
  extension_version TEXT,
  extension_seen_at DATETIME,
  paired_at DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rcs_cache_staging_chats (
  job_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  chat_hash TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  people_json TEXT NOT NULL,
  staged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (job_id, chat_hash)
);

CREATE TABLE IF NOT EXISTS rcs_cache_staging_messages (
  job_id TEXT NOT NULL,
  chat_hash TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  seq INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  PRIMARY KEY (job_id, chat_hash, msg_id)
);

CREATE INDEX IF NOT EXISTS idx_rcs_cache_staging_messages_sent ON rcs_cache_staging_messages(job_id, sent_at);

CREATE TABLE IF NOT EXISTS rcs_cache_staging_images (
  job_id TEXT NOT NULL,
  chat_hash TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  temp_path TEXT NOT NULL,
  PRIMARY KEY (job_id, chat_hash, msg_id, idx)
);

CREATE TABLE IF NOT EXISTS rcs_cache_staging_jobs (
  job_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  read_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rcs_cache_staging_chat_meta (
  job_id TEXT NOT NULL,
  chat_hash TEXT NOT NULL,
  chat_floor_ms INTEGER,
  read_floor_ms INTEGER,
  reached_floor INTEGER NOT NULL DEFAULT 0,
  read_at TEXT NOT NULL,
  PRIMARY KEY (job_id, chat_hash)
);

CREATE TABLE IF NOT EXISTS rcs_chat_reads (
  user_id TEXT NOT NULL,
  chat_hash TEXT NOT NULL,
  read_at TEXT NOT NULL,
  reached_floor INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, chat_hash),
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rcs_cache_failed_run (
  user_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rcs_cache_placed_files (
  path TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  placed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rcs_consent (
  user_id TEXT PRIMARY KEY,
  consent_at DATETIME,
  consent_version INTEGER,
  contacts_only INTEGER NOT NULL DEFAULT 0,
  auto_delete_days INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rcs_chat_exclusions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chat_hash TEXT,
  conversation_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rcs_chat_exclusions_conv ON rcs_chat_exclusions(user_id, conversation_id) WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rcs_chat_exclusions_hash ON rcs_chat_exclusions(user_id, chat_hash);

CREATE TABLE IF NOT EXISTS rcs_pending_full_sync (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  chat_hash TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rcs_pending_full_sync_user ON rcs_pending_full_sync(user_id);

CREATE TABLE IF NOT EXISTS rcs_extension_pairings (
  pair_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  key_hex TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rcs_media_options (
  user_id TEXT PRIMARY KEY,
  photos_all_chats INTEGER NOT NULL DEFAULT 1,
  videos_all_chats INTEGER NOT NULL DEFAULT 0,
  last_photos_seen INTEGER,
  last_videos_seen INTEGER,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rcs_pending_media (
  user_id TEXT PRIMARY KEY,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rcs_chat_people (
  user_id TEXT NOT NULL,
  chat_hash TEXT NOT NULL,
  number_e164 TEXT NOT NULL,
  name TEXT,
  last_message_at DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, chat_hash, number_e164),
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rcs_chat_people_number ON rcs_chat_people(user_id, number_e164);

CREATE TABLE IF NOT EXISTS rcs_cache_runs (
  user_id TEXT PRIMARY KEY,
  floor_iso DATETIME NOT NULL,
  full_read INTEGER NOT NULL DEFAULT 0,
  list_stop TEXT,
  reached_floor INTEGER NOT NULL DEFAULT 0,
  not_settled_chats INTEGER NOT NULL DEFAULT 0,
  finished_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rcs_chat_coverage (
  user_id TEXT NOT NULL,
  chat_hash TEXT NOT NULL,
  covered_since DATETIME NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, chat_hash),
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_source_coverage (
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  covered_since DATETIME,
  last_sync_at DATETIME,
  PRIMARY KEY (user_id, source),
  FOREIGN KEY (user_id) REFERENCES users_local(id) ON DELETE CASCADE
);`;

/** The same, one statement each (the drift test compares it with schema.sql). */
export const V74_RCS_LOCAL_TABLES_SQL: readonly string[] = V74_RCS_LOCAL_TABLES_DDL
  .split(/;\n\n/)
  .map((st) => (st.endsWith(";") ? st : st + ";"));

/** The tables among them. */
export const V74_RCS_TABLES: readonly string[] = V74_RCS_LOCAL_TABLES_SQL
  .map((s) => /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(s)?.[1])
  .filter((t): t is string => !!t);
