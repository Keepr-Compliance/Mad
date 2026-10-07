-- Migration: Google Messages Syncs in sync_outcomes (BACKLOG-3671 P2)
--
-- NOT APPLIED ANYWHERE YET. Until it is, the desktop app's Google Messages rows
-- (the only rows that carry these columns) are refused by PostgREST and dropped
-- with a warn line, exactly like an offline write; the iPhone rows never send
-- these keys and are unaffected.
--
-- PURPOSE
--   The Google Messages Sync (source = 'google-messages') writes the same row as
--   the iPhone Sync: start at the page's claim, a heartbeat guarded on
--   outcome = 'running', a terminal row after Keepr's save, follow-ups that
--   update source_metrics only. Its per-stage numbers (finding / reading /
--   saving / end) do not fit the iPhone columns, so they go in one jsonb.
--
-- WHY A jsonb HERE, AGAINST 20260828143000's "no metadata jsonb" RULE
--   That rule exists because a catch-all jsonb carries whatever a producer puts
--   there. The allow-list therefore moves into code, and it is ONE function:
--   electron/services/rcsSyncOutcome.ts buildRcsSourceMetrics — the only writer.
--   Named keys only, finite numbers >= 0 (clamped), enums from fixed sets; every
--   unknown key, string, array and non-finite number is dropped (unit-tested).
--   The size cap below bounds what even a bug could put there.
--
-- WHY THE CHECK IS NOT VALID
--   It applies to every new and updated row; existing rows (all NULL) are not
--   re-scanned. Same best-effort rule as the other columns otherwise: no CHECK on
--   the text columns (a rejected write is a silently dropped row).
--
-- PII: counts, durations, failure / stop codes, a run kind, two version strings.
--   No names, no phone numbers, no conversation ids, no salted tags.
--
-- ROLLBACK:
--   ALTER TABLE public.sync_outcomes DROP CONSTRAINT IF EXISTS sync_outcomes_source_metrics_size;
--   ALTER TABLE public.sync_outcomes
--     DROP COLUMN IF EXISTS source_metrics,
--     DROP COLUMN IF EXISTS run_kind,
--     DROP COLUMN IF EXISTS extension_version,
--     DROP COLUMN IF EXISTS chrome_version;

ALTER TABLE public.sync_outcomes
  -- The source's own per-stage numbers (Google Messages). Nullable, no default.
  ADD COLUMN IF NOT EXISTS source_metrics     jsonb,
  -- 'sync' | 'retry' | 'older' | 'transaction' (Google Messages).
  ADD COLUMN IF NOT EXISTS run_kind           text,
  -- The Chrome extension's version, e.g. '0.3.53'.
  ADD COLUMN IF NOT EXISTS extension_version  text,
  -- Chrome's version string only, e.g. '141.0.7390.55'.
  ADD COLUMN IF NOT EXISTS chrome_version     text;

ALTER TABLE public.sync_outcomes
  DROP CONSTRAINT IF EXISTS sync_outcomes_source_metrics_size;

ALTER TABLE public.sync_outcomes
  ADD CONSTRAINT sync_outcomes_source_metrics_size
  CHECK (pg_column_size(source_metrics) < 32768) NOT VALID;
