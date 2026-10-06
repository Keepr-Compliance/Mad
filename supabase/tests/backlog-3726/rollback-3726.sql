-- BACKLOG-3726 rollback. Removes the schedule (if present), the four functions,
-- the run table and the two Vault secrets. Touches no submission, row or file.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'submission-sweep') THEN
    PERFORM cron.unschedule('submission-sweep');
  END IF;
END
$$;
DROP FUNCTION IF EXISTS public.submission_sweep_invoke();
DROP FUNCTION IF EXISTS public.submission_sweep_finish(uuid, uuid[], jsonb, text);
DROP FUNCTION IF EXISTS public.submission_sweep_claim(boolean, interval, interval, interval, integer, integer);
DROP FUNCTION IF EXISTS public.submission_sweep_secret();
DROP TABLE IF EXISTS public.submission_sweep_runs;
DELETE FROM vault.secrets WHERE name IN ('submission_sweep_secret', 'submission_sweep_url');
