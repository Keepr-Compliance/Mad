-- harness: rollback
-- rollback-3845.sql restores the pre-3845 fingerprint: resolver bodies (md5),
-- ACLs, columns, constraints, the select policy, triggers, and drops every new object.
SELECT pg_temp.check('rollback succeeds', pg_temp.step_ok('rollback'), pg_temp.step_err('rollback'));
SELECT pg_temp.check('fingerprint restored', pg_temp.snapshot('pre') = pg_temp.snapshot('after_rb'),
  pg_temp.diff(pg_temp.snapshot('pre'), pg_temp.snapshot('after_rb')));
SELECT pg_temp.check('resolver md5s are production''s again',
  (SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname IN ('get_org_features', 'broker_get_org_features', 'check_feature_access'))
  = 'broker_get_org_features=8500027bde15be0c0993ea83455a3ca9,check_feature_access=84add903044b6c2ac0d6a71248650325,get_org_features=51401252aade8541bd69ca60ecfe21e2');
SELECT pg_temp.check('pre-existing Stripe rows survive the rollback',
  (SELECT count(*) FROM public.stripe_customers WHERE user_id = pg_temp.id('u_live')) = 1
  AND (SELECT count(*) FROM public.payment_intents WHERE user_id = pg_temp.id('u_live')) = 1);
