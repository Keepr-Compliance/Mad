-- W6 (C8): admin_update_license(..., {"status":"active"}) on a suspended licence -> one resume row.
SELECT pg_temp.suspend_test_user();
SELECT pg_temp.admin_ok(format('SELECT public.admin_update_license(%L::uuid, ''{"status":"active"}''::jsonb)::text', pg_temp.lic_id('u_test')));
SELECT pg_temp.check('licence active, one resume row', pg_temp.lic_status('u_test') = 'active'
  AND pg_temp.ob('u_test', 'resume_agent_subscription') = 1, pg_temp.ob_all('u_test'));
