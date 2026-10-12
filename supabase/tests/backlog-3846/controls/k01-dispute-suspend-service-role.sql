-- K1 (BACKLOG-3136): suspend_account_for_dispute as the service role (the Stripe
-- webhook's path: role service_role, no user) suspends and writes an actorless audit row.
INSERT INTO t3845_last VALUES (1, pg_temp.as_role('service_role', NULL,
  'SELECT public.suspend_account_for_dispute(''{u_test}'', ''du_FX3846'', ''pi_FX3846'', NULL, 1999, now())::text'))
  ON CONFLICT (k) DO UPDATE SET r = EXCLUDED.r;
SELECT pg_temp.check('service-role dispute suspension succeeds', pg_temp.last() LIKE 'OK %"already_suspended": false%', pg_temp.last());
SELECT pg_temp.check('licence suspended', pg_temp.lic_status('u_test') = 'suspended', pg_temp.lic_status('u_test'));
SELECT pg_temp.check('audit row: no actor, source stripe_webhook',
  (SELECT count(*) = 1 FROM public.admin_audit_logs
    WHERE action = 'account.suspend' AND target_id = pg_temp.id('u_test')::text
      AND actor_id IS NULL AND metadata ->> 'source' = 'stripe_webhook'));
-- Same dispute again: deduped, still one audit row.
SELECT pg_temp.as_role('service_role', NULL,
  'SELECT public.suspend_account_for_dispute(''{u_test}'', ''du_FX3846'', ''pi_FX3846'', NULL, 1999, now())::text');
SELECT pg_temp.check('replay deduped', (SELECT count(*) = 1 FROM public.admin_audit_logs WHERE action = 'account.suspend' AND target_id = pg_temp.id('u_test')::text));
-- Support reinstates (after the dispute is won/settled): Unlimited comes back.
INSERT INTO t3845_last VALUES (1, pg_temp.admin('SELECT public.reinstate_suspended_account(''{u_test}'', ''dispute won'')::text'))
  ON CONFLICT (k) DO UPDATE SET r = EXCLUDED.r;
SELECT pg_temp.check('reinstated -> active and re-granted', pg_temp.last() LIKE 'OK %' AND pg_temp.lic_status('u_test') = 'active'
  AND pg_temp.unlimited('u_test') = pg_temp.expected_grant('u_test'), pg_temp.last() || ' ' || coalesce(pg_temp.unlimited('u_test')::text, '<none>'));
