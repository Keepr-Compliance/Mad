-- W3 (C8): admin_update_license(..., {"status":"suspended"}) -> one pause row.
SELECT pg_temp.admin_ok(format('SELECT public.admin_update_license(%L::uuid, ''{"status":"suspended"}''::jsonb)::text', pg_temp.lic_id('u_test')));
SELECT pg_temp.check('licence suspended, one pause row', pg_temp.lic_status('u_test') = 'suspended'
  AND pg_temp.ob('u_test', 'pause_agent_subscription') = 1 AND pg_temp.ob('u_test', 'resume_agent_subscription') = 0, pg_temp.ob_all('u_test'));
