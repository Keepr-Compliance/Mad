-- Rollback of 20261123120000_backlog_4263_cloud_blob_erase_schedule (BACKLOG-4263, sync plan P3, E3).
-- Removes the hourly cloud-blob-erase cron job. Run before rollback-20261123110000.sql. Re-runnable.
-- lock_timeout 3s is set before the first statement.
SET LOCAL lock_timeout = '3s';
DO $rb4263e3$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cloud-blob-erase') THEN
    PERFORM cron.unschedule('cloud-blob-erase');
  END IF;
END
$rb4263e3$;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261123120000';
