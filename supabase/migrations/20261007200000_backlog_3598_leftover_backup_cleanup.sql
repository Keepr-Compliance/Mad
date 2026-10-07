-- Migration: record unfinished-backup cleanup on sync outcome rows (BACKLOG-3598)
--
-- Two nullable columns, written by desktop builds that remove unfinished iPhone
-- backups. Builds that do not send these keys are unaffected.
--
-- APPLY BEFORE A CLIENT THAT SENDS THEM SHIPS. The client upserts the row; an unknown
-- column rejects the whole write, so a run that cleaned up would lose its terminal
-- row. Check: select column_name from information_schema.columns
--   where table_name = 'sync_outcomes' and column_name like 'leftover%';  -> 2 rows.

alter table public.sync_outcomes
  add column if not exists leftover_backup_bytes_cleared bigint,
  add column if not exists leftover_cleanup text;

comment on column public.sync_outcomes.leftover_backup_bytes_cleared is
  'BACKLOG-3598: bytes this run removed from unfinished iPhone backups: folders swept at sync start (any phone on this computer, so not per-device) plus this run''s own unfinished backup when it failed or was cancelled. A folder whose size could not be measured adds nothing, so this can undercount. NULL when nothing was removed.';

comment on column public.sync_outcomes.leftover_cleanup is
  'BACKLOG-3598: ''removed'' when every removal in the run succeeded; ''failed:<errno>'' (e.g. failed:EBUSY) when any removal failed, which takes precedence. Never a path. NULL when no removal was attempted.';
