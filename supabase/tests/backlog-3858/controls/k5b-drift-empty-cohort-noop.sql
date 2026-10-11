-- harness: drift
-- harness: empty-cohort
-- k5b: with an empty cohort (fresh database, or after the run) the file is a
-- no-op even when the function body differs, so a database reset never fails
-- here.
SELECT pg_temp.check('k5b nothing written but the empty bookkeeping table',
  pg_temp.snapshot('after1') - 'backfill' = pg_temp.snapshot('pre') - 'backfill'
  AND pg_temp.snapshot('after1')->'backfill' = '[]'::jsonb,
  pg_temp.diff(pg_temp.snapshot('pre'), pg_temp.snapshot('after1')));
