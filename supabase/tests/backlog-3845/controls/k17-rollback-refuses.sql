-- harness: rollback
-- harness: expect-raise
-- harness: pre-rollback: SELECT public.grant_unlimited_from_subscription(pg_temp.id('u_live'), '2098-01-01T00:00:00Z'::timestamptz, 'live');
-- A Stripe grant (paid_through) exists: the old resolvers would ignore its
-- paid_through and read it as Unlimited forever, so the rollback must refuse.
SELECT pg_temp.check('migration applied', pg_temp.step_ok('apply1'), pg_temp.step_err('apply1'));
SELECT pg_temp.check('rollback refuses while a paid_through override exists',
  pg_temp.step_ok('rollback') IS FALSE AND pg_temp.step_err('rollback') LIKE '%paid_through or source=stripe%', pg_temp.step_err('rollback'));
SELECT pg_temp.check('nothing rolled back', to_regprocedure('public._override_effective(jsonb)') IS NOT NULL
  AND to_regclass('public.billing_outbox') IS NOT NULL);
