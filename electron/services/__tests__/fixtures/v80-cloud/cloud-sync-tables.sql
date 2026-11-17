-- The five Keepr Cloud tables as electron/database/schema.sql declares them at int-portal/release-2.49 b869f3911
-- (schema version 80, before BACKLOG-4263 v81). Extracted with:
--   git show b869f3911:electron/database/schema.sql | sed -n '/^CREATE TABLE IF NOT EXISTS cloud_sync_install/,/^-- BACKLOG-4243 END/p'
CREATE TABLE IF NOT EXISTS cloud_sync_install (
  project_ref  TEXT PRIMARY KEY,
  install_id   TEXT NOT NULL,
  machine_hash TEXT,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cloud_sync_settings (
  project_ref        TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  local_confirmed_at TEXT,
  notice_version     INTEGER,
  accepted_at        TEXT,
  last_state_json    TEXT,
  last_state_at      TEXT,
  turn_off_owed_at   TEXT,
  PRIMARY KEY (project_ref, user_id)
);
CREATE TABLE IF NOT EXISTS cloud_sync_state (
  project_ref     TEXT NOT NULL,
  owner_user_id   TEXT NOT NULL,
  entity          TEXT NOT NULL,
  local_id        TEXT NOT NULL,
  transaction_id  TEXT NOT NULL,
  cloud_id        TEXT,
  cloud_deal_id   TEXT,
  content_hash    TEXT,
  hash_version    INTEGER,
  cloud_version   INTEGER,
  removed         INTEGER NOT NULL DEFAULT 0,
  last_status     TEXT,
  last_error_code TEXT,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (project_ref, owner_user_id, entity, local_id)
);
CREATE TABLE IF NOT EXISTS cloud_sync_dirty (
  transaction_id  TEXT PRIMARY KEY,
  generation      INTEGER NOT NULL,
  marked_at       TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error_code TEXT
);
CREATE TABLE IF NOT EXISTS cloud_sync_runs (
  id            INTEGER PRIMARY KEY,
  project_ref   TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  outcome       TEXT,
  deals_done    INTEGER NOT NULL DEFAULT 0,
  deals_failed  INTEGER NOT NULL DEFAULT 0,
  rows_rejected INTEGER NOT NULL DEFAULT 0,
  error_code    TEXT
);
-- BACKLOG-4243 END
