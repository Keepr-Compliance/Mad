-- W2 (C8): suspend_account_for_dispute as the service role (the Stripe webhook) -> one pause row.
INSERT INTO t3845_last VALUES (1, pg_temp.as_role('service_role', NULL,
  'SELECT public.suspend_account_for_dispute(''{u_test}'', ''du_FX3878'', ''pi_FX3878'', NULL, 1999, now())::text'))
  ON CONFLICT (k) DO UPDATE SET r = EXCLUDED.r;
SELECT pg_temp.check('dispute suspension ok, licence suspended', pg_temp.last() LIKE 'OK %' AND pg_temp.lic_status('u_test') = 'suspended', pg_temp.last());
SELECT pg_temp.check('one pause row', pg_temp.ob('u_test', 'pause_agent_subscription') = 1 AND pg_temp.ob('u_test', 'resume_agent_subscription') = 0, pg_temp.ob_all('u_test'));
-- Replay of the same dispute: the licence is already suspended -> no second row.
SELECT pg_temp.as_role('service_role', NULL,
  'SELECT public.suspend_account_for_dispute(''{u_test}'', ''du_FX3878'', ''pi_FX3878'', NULL, 1999, now())::text');
SELECT pg_temp.check('replay adds nothing', pg_temp.ob('u_test', 'pause_agent_subscription') = 1, pg_temp.ob_all('u_test'));
