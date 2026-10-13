-- harness: expect-raise
-- harness: pre-apply: DO $d$ BEGIN EXECUTE replace(pg_get_functiondef('public.broker_get_org_features(uuid)'::regprocedure), 'BEGIN', E'BEGIN\n  -- drift'); END $d$;
-- A resolver whose body is not production's (someone changed it after this
-- file was reviewed) stops the migration before anything is replaced.
SELECT pg_temp.check('drifted resolver body -> migration refuses',
  pg_temp.step_ok('apply1') IS FALSE AND pg_temp.step_err('apply1') LIKE '%broker_get_org_features(uuid) body changed%', pg_temp.step_err('apply1'));
SELECT pg_temp.check('nothing applied', to_regprocedure('public._override_effective(jsonb)') IS NULL
  AND to_regclass('public.billing_outbox') IS NULL);
