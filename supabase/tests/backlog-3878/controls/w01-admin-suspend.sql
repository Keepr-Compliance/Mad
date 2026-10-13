-- W1 (C8): admin_suspend_user (admin portal SuspendDialog), as an internal user -> exactly one pause row, test mode.
SELECT pg_temp.suspend_test_user();
SELECT pg_temp.check('one pause row, no resume row', pg_temp.ob('u_test', 'pause_agent_subscription') = 1
  AND pg_temp.ob('u_test', 'resume_agent_subscription') = 0, pg_temp.ob_all('u_test'));
SELECT pg_temp.check('row: mode test, payload active -> suspended, licence id, run now, unprocessed',
  (SELECT stripe_mode = 'test' AND payload ->> 'from' = 'active' AND payload ->> 'to' = 'suspended'
          AND (payload ->> 'licence_id')::uuid = pg_temp.lic_id('u_test') AND run_after <= now() AND processed_at IS NULL
          AND dedupe_key LIKE 'pause:test:' || pg_temp.id('u_test')::text || ':%'
     FROM public.billing_outbox WHERE user_id = pg_temp.id('u_test')), pg_temp.ob_all('u_test'));
