-- U1: unsuspend through admin_unsuspend_user (admin portal SuspendDialog / MembersTable),
-- called as `authenticated` with an internal user's JWT -> Unlimited restored to cpe + 2 h.
SELECT pg_temp.suspend_test_user();
SELECT pg_temp.check('suspended user has no override yet', pg_temp.unlimited('u_test') IS NULL, pg_temp.unlimited('u_test')::text);
INSERT INTO t3845_last VALUES (1, pg_temp.admin('SELECT public.admin_unsuspend_user(''{u_test}'')::text'))
  ON CONFLICT (k) DO UPDATE SET r = EXCLUDED.r;
SELECT pg_temp.check('admin_unsuspend_user ok, licence active', pg_temp.last() LIKE 'OK %' AND pg_temp.lic_status('u_test') = 'active', pg_temp.last());
SELECT pg_temp.check('override = {enabled, cpe + 2 h, stripe}', pg_temp.unlimited('u_test') = pg_temp.expected_grant('u_test'),
  coalesce(pg_temp.unlimited('u_test')::text, '<none>') || ' want ' || pg_temp.expected_grant('u_test')::text);
SELECT pg_temp.check3('user is Unlimited after unsuspend', pg_temp.id('u_test'), pg_temp.porg('u_test'), 'unlimited_transactions', 'OK true/override');
