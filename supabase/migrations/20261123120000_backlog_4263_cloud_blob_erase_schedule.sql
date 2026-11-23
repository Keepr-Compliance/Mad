-- ============================================================================
-- Migration: Keepr Cloud file-byte erase job, hourly schedule (BACKLOG-4263, sync plan P3, E3)
--
-- Runs public.cloud_blob_erase_invoke() at minute 23 of every hour. Applied at its own deploy step: after
-- 20261123110000, after vault secret cloud_blob_erase_url is set for this environment, and after the Edge Function
-- cloud-blob-erase is deployed with CLOUD_BLOB_ERASE_MODE = dry_run. Refuses to apply without pg_cron, without the
-- invoke function, or without the URL secret (checked by name only). Re-running replaces the job (cron.schedule
-- upserts by name).
-- Stop: SELECT cron.unschedule('cloud-blob-erase');
-- lock_timeout 3s is set before the first statement: if a lock is not obtained in 3 seconds nothing is applied.
-- ============================================================================

SET LOCAL lock_timeout = '3s';
DO $cron4263e3$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'BACKLOG-4263 E3: pg_cron is not enabled on this database';
  END IF;
  IF to_regprocedure('public.cloud_blob_erase_invoke()') IS NULL THEN
    RAISE EXCEPTION 'BACKLOG-4263 E3: apply 20261123110000 first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cloud_blob_erase_url') THEN
    RAISE EXCEPTION 'BACKLOG-4263 E3: set vault secret cloud_blob_erase_url for this environment first';
  END IF;
  PERFORM cron.schedule('cloud-blob-erase', '23 * * * *', 'SELECT public.cloud_blob_erase_invoke()');
END
$cron4263e3$;
