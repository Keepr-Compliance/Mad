-- W5 (C8): dispute suspension, then reinstate_suspended_account (SuspensionAction.tsx) -> one resume row.
SELECT pg_temp.as_role('service_role', NULL,
  'SELECT public.suspend_account_for_dispute(''{u_test}'', ''du_FX3878b'', ''pi_FX3878b'', NULL, 1999, now())::text');
SELECT pg_temp.admin_ok('SELECT public.reinstate_suspended_account(''{u_test}'', ''dispute won'')::text');
SELECT pg_temp.check('licence active, one pause + one resume row', pg_temp.lic_status('u_test') = 'active'
  AND pg_temp.ob('u_test', 'pause_agent_subscription') = 1 AND pg_temp.ob('u_test', 'resume_agent_subscription') = 1, pg_temp.ob_all('u_test'));
