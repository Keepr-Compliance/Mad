-- U11: the trigger fires only on suspended -> active: an active licence's other
-- updates, and suspending, grant nothing.
SELECT pg_temp.admin(format('SELECT public.admin_update_license(%L::uuid, ''{"transaction_limit": 5}''::jsonb)::text', pg_temp.lic_id('u_test')));
UPDATE public.licenses SET status = 'active' WHERE user_id = pg_temp.id('u_test');
SELECT pg_temp.suspend_test_user();
SELECT pg_temp.check('no override from non-unsuspend writes', pg_temp.unlimited('u_test') IS NULL, coalesce(pg_temp.unlimited('u_test')::text, '<none>'));
