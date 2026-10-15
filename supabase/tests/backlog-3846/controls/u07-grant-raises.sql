-- U7: the grant raises (personal org has no plan row, P0002) -> the unsuspend still succeeds.
DELETE FROM public.organization_plans WHERE organization_id = pg_temp.porg('u_test');
SELECT pg_temp.suspend_test_user();
INSERT INTO t3845_last VALUES (1, pg_temp.admin('SELECT public.admin_unsuspend_user(''{u_test}'')::text'))
  ON CONFLICT (k) DO UPDATE SET r = EXCLUDED.r;
SELECT pg_temp.check('unsuspend succeeds although the re-grant raised', pg_temp.last() LIKE 'OK %' AND pg_temp.lic_status('u_test') = 'active', pg_temp.last());
