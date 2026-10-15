-- W9 (C8): writes that do not move status into or out of 'suspended' enqueue nothing:
-- another column, active -> active, suspended -> suspended, active -> expired, expired -> active.
SELECT pg_temp.admin_ok(format('SELECT public.admin_update_license(%L::uuid, ''{"transaction_limit": 5}''::jsonb)::text', pg_temp.lic_id('u_test')));
UPDATE public.licenses SET status = 'active' WHERE user_id = pg_temp.id('u_test');
UPDATE public.licenses SET status = 'expired' WHERE user_id = pg_temp.id('u_test');
UPDATE public.licenses SET status = 'active' WHERE user_id = pg_temp.id('u_test');
SELECT pg_temp.check('no rows from non-suspension writes', NOT EXISTS (SELECT 1 FROM public.billing_outbox), pg_temp.ob_all('u_test'));
SELECT pg_temp.suspend_test_user();
UPDATE public.licenses SET status = 'suspended' WHERE user_id = pg_temp.id('u_test');
SELECT pg_temp.check('suspended -> suspended adds nothing', pg_temp.ob('u_test', 'pause_agent_subscription') = 1, pg_temp.ob_all('u_test'));
