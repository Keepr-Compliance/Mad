-- harness: rollback
-- harness: pre-rollback: UPDATE public.organization_plans SET feature_overrides = '{"unlimited_transactions":{"enabled":true}}'::jsonb WHERE organization_id = pg_temp.porg('c_ind1');
-- k4c: a recorded org whose plan row gained feature_overrides after the run
-- (shape transcribed from a prod personal org's plan row) makes the rollback
-- refuse and write nothing.
SELECT pg_temp.check('k4c rollback refused', pg_temp.step_ok('rollback') = false
  AND pg_temp.step_err('rollback') LIKE '%rollback refused%feature_overrides set%', pg_temp.step_err('rollback'));
SELECT pg_temp.check('k4c nothing deleted', pg_temp.porg('c_ind1') IS NOT NULL
  AND jsonb_typeof(pg_temp.state()->'backfill') = 'array'
  AND jsonb_array_length(pg_temp.state()->'backfill') = 4);
