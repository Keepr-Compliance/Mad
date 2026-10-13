-- W10 (SR R9): suspended -> expired / cancelled (reinstate to a previous non-active status) -> no resume row.
SELECT pg_temp.suspend_test_user();
SELECT pg_temp.admin_ok(format('SELECT public.admin_update_license(%L::uuid, ''{"status":"expired"}''::jsonb)::text', pg_temp.lic_id('u_test')));
SELECT pg_temp.check('licence expired, no resume row', pg_temp.lic_status('u_test') = 'expired'
  AND pg_temp.ob('u_test', 'resume_agent_subscription') = 0, pg_temp.ob_all('u_test'));
UPDATE public.licenses SET status = 'suspended' WHERE user_id = pg_temp.id('u_test');
UPDATE public.licenses SET status = 'cancelled' WHERE user_id = pg_temp.id('u_test');
SELECT pg_temp.check('suspended -> cancelled: no resume row; expired -> suspended: a second pause row',
  pg_temp.ob('u_test', 'resume_agent_subscription') = 0 AND pg_temp.ob('u_test', 'pause_agent_subscription') = 2, pg_temp.ob_all('u_test'));
