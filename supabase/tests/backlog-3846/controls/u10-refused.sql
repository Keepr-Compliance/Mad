-- U10 (R8): a support override is present, so the grant returns refused (non_stripe_override):
-- the unsuspend succeeds and the support override is untouched.
SELECT pg_temp.set_override(pg_temp.porg('u_test'), 'unlimited_transactions', '{"enabled": true}');
SELECT pg_temp.suspend_test_user();
INSERT INTO t3845_last VALUES (1, pg_temp.admin('SELECT public.admin_unsuspend_user(''{u_test}'')::text'))
  ON CONFLICT (k) DO UPDATE SET r = EXCLUDED.r;
SELECT pg_temp.check('unsuspend ok', pg_temp.last() LIKE 'OK %' AND pg_temp.lic_status('u_test') = 'active', pg_temp.last());
SELECT pg_temp.check('support override unchanged', pg_temp.unlimited('u_test') = '{"enabled": true}'::jsonb, pg_temp.unlimited('u_test')::text);
