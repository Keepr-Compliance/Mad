-- U2: unsuspend through reinstate_suspended_account (SuspensionAction.tsx), as an internal user.
SELECT pg_temp.suspend_test_user();
INSERT INTO t3845_last VALUES (1, pg_temp.admin('SELECT public.reinstate_suspended_account(''{u_test}'', ''fixture reinstate'')::text'))
  ON CONFLICT (k) DO UPDATE SET r = EXCLUDED.r;
SELECT pg_temp.check('reinstate ok, licence active', pg_temp.last() LIKE 'OK %' AND pg_temp.lic_status('u_test') = 'active', pg_temp.last());
SELECT pg_temp.check('override restored', pg_temp.unlimited('u_test') = pg_temp.expected_grant('u_test'),
  coalesce(pg_temp.unlimited('u_test')::text, '<none>'));
