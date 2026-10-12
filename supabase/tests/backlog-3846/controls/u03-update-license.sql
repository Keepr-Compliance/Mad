-- U3: unsuspend through admin_update_license(..., {"status":"active"}) (admin-queries.ts), as an internal user.
SELECT pg_temp.suspend_test_user();
INSERT INTO t3845_last VALUES (1, pg_temp.admin(format('SELECT public.admin_update_license(%L::uuid, ''{"status":"active"}''::jsonb)::text', pg_temp.lic_id('u_test'))))
  ON CONFLICT (k) DO UPDATE SET r = EXCLUDED.r;
SELECT pg_temp.check('admin_update_license ok, licence active', pg_temp.last() LIKE 'OK %' AND pg_temp.lic_status('u_test') = 'active', pg_temp.last());
SELECT pg_temp.check('override restored', pg_temp.unlimited('u_test') = pg_temp.expected_grant('u_test'),
  coalesce(pg_temp.unlimited('u_test')::text, '<none>'));
