-- u05: paused subscription -> no override.
UPDATE public.billing_subscriptions SET paused = true WHERE user_id = pg_temp.id('u_test');
SELECT pg_temp.suspend_test_user();
INSERT INTO t3845_last VALUES (1, pg_temp.admin('SELECT public.admin_unsuspend_user(''{u_test}'')::text'))
  ON CONFLICT (k) DO UPDATE SET r = EXCLUDED.r;
SELECT pg_temp.check('unsuspend ok, licence active', pg_temp.last() LIKE 'OK %' AND pg_temp.lic_status('u_test') = 'active', pg_temp.last());
SELECT pg_temp.check('paused subscription -> no override', pg_temp.unlimited('u_test') IS NULL, coalesce(pg_temp.unlimited('u_test')::text, '<none>'));
