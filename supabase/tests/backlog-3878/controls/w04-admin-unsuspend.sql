-- W4 (C8): admin_unsuspend_user after an admin suspension -> one resume row.
SELECT pg_temp.suspend_test_user();
SELECT pg_temp.admin_ok('SELECT public.admin_unsuspend_user(''{u_test}'')::text');
SELECT pg_temp.check('licence active, one pause + one resume row', pg_temp.lic_status('u_test') = 'active'
  AND pg_temp.ob('u_test', 'pause_agent_subscription') = 1 AND pg_temp.ob('u_test', 'resume_agent_subscription') = 1, pg_temp.ob_all('u_test'));
SELECT pg_temp.check('resume row: test mode, suspended -> active',
  (SELECT stripe_mode = 'test' AND payload ->> 'from' = 'suspended' AND payload ->> 'to' = 'active' AND dedupe_key LIKE 'resume:test:%'
     FROM public.billing_outbox WHERE user_id = pg_temp.id('u_test') AND kind = 'resume_agent_subscription'), pg_temp.ob_all('u_test'));
