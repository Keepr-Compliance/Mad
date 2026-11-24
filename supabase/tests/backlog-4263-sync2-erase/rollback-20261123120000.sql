-- Rollback of 20261123120000_backlog_4263_cloud_blob_erase_schedule (BACKLOG-4263, sync plan P3, E3).
-- Removes the hourly cloud-blob-erase cron job and the ledger row. Run before rollback-20261123110000.sql.
-- Re-runnable, unlike the rollbacks of 20261123110000, 20261123130000 and 20261123140000: on a database without the
-- job (E3 never applied, or this file already run) it removes nothing and its post-check still holds. The erase
-- harness (harness.py) runs it first on the test project, which has no E3.
-- One transaction; RAISEs (nothing changed) unless its post-check holds: the job and the ledger row are gone, every
-- other cron job is as it was, and the six functions of 20261123110000 are as they were.
-- Locks (held until commit; lock_timeout 3s): the cron.job row of the job; a row lock on the ledger row.
-- lock_timeout 3s is set before the first statement.
SET LOCAL lock_timeout = '3s';
DO $rb4263e3$
BEGIN
  PERFORM set_config('rb4263e3.e1_functions', coalesce((SELECT string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), ';' ORDER BY p.oid::regprocedure::text)
      FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname::text LIKE 'cloud\_blob\_erase\_%'), 'none'), true);
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM set_config('rb4263e3.other_jobs', coalesce((SELECT string_agg(md5(concat_ws('|', j.jobid::text, j.jobname::text, j.schedule::text, j.command::text)), ',' ORDER BY j.jobid)
        FROM cron.job j WHERE j.jobname IS DISTINCT FROM 'cloud-blob-erase'), 'none'), true);
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cloud-blob-erase') THEN
      PERFORM cron.unschedule('cloud-blob-erase');
    END IF;
  ELSE
    PERFORM set_config('rb4263e3.other_jobs', 'no pg_cron', true);
  END IF;
END
$rb4263e3$;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261123120000';
DO $postrb4263e3$
DECLARE bad text := ''; v text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cloud-blob-erase') THEN bad := bad || 'cron job cloud-blob-erase still present; '; END IF;
    v := coalesce((SELECT string_agg(md5(concat_ws('|', j.jobid::text, j.jobname::text, j.schedule::text, j.command::text)), ',' ORDER BY j.jobid)
        FROM cron.job j WHERE j.jobname IS DISTINCT FROM 'cloud-blob-erase'), 'none');
  ELSE
    v := 'no pg_cron';
  END IF;
  IF v IS DISTINCT FROM current_setting('rb4263e3.other_jobs', true) THEN bad := bad || 'another cron job changed; '; END IF;
  IF coalesce((SELECT string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), ';' ORDER BY p.oid::regprocedure::text)
      FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname::text LIKE 'cloud\_blob\_erase\_%'), 'none')
     IS DISTINCT FROM current_setting('rb4263e3.e1_functions', true) THEN
    bad := bad || 'a function of 20261123110000 changed; ';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations s WHERE s.version = '20261123120000') THEN
    bad := bad || 'ledger row still present; ';
  END IF;
  IF bad <> '' THEN
    RAISE EXCEPTION 'ROLLBACK POST-CHECK 20261123120000 FAILED, nothing changed: %', bad;
  END IF;
  RAISE NOTICE 'ROLLBACK POST-CHECK 20261123120000 OK';
END
$postrb4263e3$;
