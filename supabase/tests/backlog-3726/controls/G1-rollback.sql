-- harness: rollback
-- After the migration, the schedule file and the rollback: nothing of 3726 is left; submissions untouched.
DO $$ BEGIN
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname LIKE 'submission_sweep%'), 'G1 no sweep function left');
  PERFORM pg_temp.ok(to_regclass('public.submission_sweep_runs') IS NULL, 'G1 run table dropped');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name LIKE 'submission_sweep%'), 'G1 secrets removed');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'submission-sweep'), 'G1 schedule removed');
END $$;
