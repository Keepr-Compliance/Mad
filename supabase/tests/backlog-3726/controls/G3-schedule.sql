-- harness: schedule
-- The schedule file creates one job at minute 41 calling submission_sweep_invoke(); re-running keeps one job.
DO $$ BEGIN
  PERFORM pg_temp.ok((SELECT count(*) FROM cron.job WHERE jobname = 'submission-sweep') = 1, 'G3 one job');
  PERFORM pg_temp.ok((SELECT schedule = '41 * * * *' AND command = 'SELECT public.submission_sweep_invoke()' FROM cron.job WHERE jobname = 'submission-sweep'), 'G3 schedule and command');
END $$;
