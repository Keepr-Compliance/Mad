-- W11 (SR R9): two suspend / reinstate cycles in one transaction -> 2 pause + 2 resume rows,
-- four distinct dedupe keys. (updated_at is now() and the same for all four updates here;
-- the key uses clock_timestamp so the second cycle is not dropped.)
SELECT pg_temp.suspend_test_user();
SELECT pg_temp.admin_ok('SELECT public.admin_unsuspend_user(''{u_test}'')::text');
SELECT pg_temp.suspend_test_user();
SELECT pg_temp.admin_ok('SELECT public.admin_unsuspend_user(''{u_test}'')::text');
SELECT pg_temp.check('2 pause + 2 resume rows', pg_temp.ob('u_test', 'pause_agent_subscription') = 2
  AND pg_temp.ob('u_test', 'resume_agent_subscription') = 2, pg_temp.ob_all('u_test'));
SELECT pg_temp.check('four distinct keys', (SELECT count(DISTINCT dedupe_key) = 4 FROM public.billing_outbox WHERE user_id = pg_temp.id('u_test')));
SELECT pg_temp.check('updated_at is transaction-stable here (why the key does not use it)',
  (SELECT updated_at = now() FROM public.licenses WHERE user_id = pg_temp.id('u_test')));
