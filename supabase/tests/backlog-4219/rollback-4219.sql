-- BACKLOG-4219 PR1 rollback (20261112130000_backlog_4219_learn_pilot_report.sql).
-- Removes every object the migration created. The desktop send fails quietly when the RPCs are gone.
DO $rbj$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-learn-pilot-reports') THEN
    PERFORM cron.unschedule('purge-learn-pilot-reports');
  END IF;
END
$rbj$;
DROP FUNCTION IF EXISTS public.learn_pilot_report_admin_list();
DROP FUNCTION IF EXISTS public.learn_pilot_report_withdraw();
DROP FUNCTION IF EXISTS public.learn_pilot_report_submit(JSONB);
DROP TABLE IF EXISTS public.learn_pilot_reports;
DROP FUNCTION IF EXISTS public._learn_pilot_report_invalid(JSONB);
DROP FUNCTION IF EXISTS public._learn_pilot_census_invalid(JSONB);
DROP FUNCTION IF EXISTS public._learn_pilot_counts_ok(JSONB, TEXT[]);
DROP FUNCTION IF EXISTS public._learn_pilot_int_ok(JSONB);
-- cascades any report_access rows on the key
DELETE FROM public.reports WHERE report_key = 'learn-pilot';
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261112130000';
