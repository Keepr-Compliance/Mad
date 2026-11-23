-- Rollback of 20261123110000_backlog_4263_cloud_blob_erase (BACKLOG-4263, sync plan P3, E1).
-- Run rollback-20261123120000.sql first (the schedule calls cloud_blob_erase_invoke()). Re-runnable.
-- Removes the five functions, the two tables (run history is lost) and both vault secrets of the job
-- (cloud_blob_erase_secret, created by E1, and cloud_blob_erase_url, set per environment after E1).
-- Leaves cloud_blobs, cloud_deal_* rows and storage objects as they are: a blob fenced before the rollback stays
-- fenced and is erased once E1 is applied again.
DO $rb4263e1$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cloud-blob-erase') THEN
    RAISE EXCEPTION 'BACKLOG-4263 rollback E1: run rollback-20261123120000.sql first (cron job cloud-blob-erase exists)';
  END IF;
END
$rb4263e1$;
DROP FUNCTION IF EXISTS public.cloud_blob_erase_invoke();
DROP FUNCTION IF EXISTS public.cloud_blob_erase_scrub(uuid, uuid, boolean, integer);
DROP FUNCTION IF EXISTS public.cloud_blob_erase_finish(uuid, uuid[], jsonb, text);
DROP FUNCTION IF EXISTS public.cloud_blob_erase_claim(boolean, integer, integer);
DROP FUNCTION IF EXISTS public.cloud_blob_erase_secret();
DROP TABLE IF EXISTS public.cloud_blob_erase_leases;
DROP TABLE IF EXISTS public.cloud_blob_erase_runs;
DELETE FROM vault.secrets WHERE name IN ('cloud_blob_erase_secret', 'cloud_blob_erase_url');
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261123110000';
