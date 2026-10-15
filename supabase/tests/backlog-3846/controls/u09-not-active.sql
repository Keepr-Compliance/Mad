-- U9 (R8): suspended -> cancelled through admin_update_license -> no override.
SELECT pg_temp.suspend_test_user();
INSERT INTO t3845_last VALUES (1, pg_temp.admin(format('SELECT public.admin_update_license(%L::uuid, ''{"status":"cancelled"}''::jsonb)::text', pg_temp.lic_id('u_test'))))
  ON CONFLICT (k) DO UPDATE SET r = EXCLUDED.r;
SELECT pg_temp.check('licence cancelled', pg_temp.last() LIKE 'OK %' AND pg_temp.lic_status('u_test') = 'cancelled', pg_temp.last());
SELECT pg_temp.check('suspended -> cancelled grants nothing', pg_temp.unlimited('u_test') IS NULL, coalesce(pg_temp.unlimited('u_test')::text, '<none>'));
