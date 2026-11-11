-- BACKLOG-4170 PR3 rollback: restores the 16 SELECT policies changed by 20261111120000 to the text read
-- from the production catalog on 2026-11-10 (pg_policies quals, verbatim; identical on keepr-test).
-- Digest of every policy on the 16 tables before PR3 (expression: pg_temp.tdigest() in prelude.sql):
--   n=36 md5=801af2214b81aebad5e5c7831547727a
-- Run only inside a transaction that is rolled back (harness), or with an explicit go for a real rollback.

ALTER POLICY account_suspensions_internal_select ON public.account_suspensions
  USING (has_internal_role(auth.uid()));

ALTER POLICY credit_ledger_select_own ON public.credit_ledger
  USING (((( SELECT auth.uid() AS uid) = user_id) OR has_internal_role(( SELECT auth.uid() AS uid))));

ALTER POLICY transaction_unlocks_select_own ON public.transaction_unlocks
  USING (((( SELECT auth.uid() AS uid) = user_id) OR has_internal_role(( SELECT auth.uid() AS uid))));

ALTER POLICY payment_intents_select_own ON public.payment_intents
  USING (((( SELECT auth.uid() AS uid) = user_id) OR has_internal_role(( SELECT auth.uid() AS uid))));

ALTER POLICY stripe_customers_select_own ON public.stripe_customers
  USING ((((( SELECT auth.uid() AS uid) = user_id) AND (stripe_mode = 'live'::text)) OR has_internal_role(( SELECT auth.uid() AS uid))));

ALTER POLICY internal_users_can_read_individual_invitations ON public.individual_invitations
  USING (has_internal_role(( SELECT auth.uid() AS uid)));

ALTER POLICY "Internal users can read logs" ON public.email_delivery_log
  TO public
  USING ((EXISTS ( SELECT 1
   FROM internal_roles
  WHERE (internal_roles.user_id = ( SELECT auth.uid() AS uid)))));

ALTER POLICY "email_delivery_queue internal read" ON public.email_delivery_queue
  USING (has_internal_role(( SELECT auth.uid() AS uid)));

ALTER POLICY "Internal users can view admin audit logs" ON public.admin_audit_logs
  USING (has_internal_role(( SELECT auth.uid() AS uid)));

ALTER POLICY "Internal users can view roles" ON public.admin_roles
  USING (has_internal_role(( SELECT auth.uid() AS uid)));

ALTER POLICY "Internal users can view permissions" ON public.admin_permissions
  USING (has_internal_role(( SELECT auth.uid() AS uid)));

ALTER POLICY "Internal users can view role permissions" ON public.admin_role_permissions
  USING (has_internal_role(( SELECT auth.uid() AS uid)));

ALTER POLICY internal_users_read_invitations ON public.pending_internal_invitations
  USING (has_internal_role(( SELECT auth.uid() AS uid)));

ALTER POLICY "Internal roles can read lifecycle events" ON public.app_lifecycle_events
  USING ((EXISTS ( SELECT 1
   FROM internal_roles
  WHERE (internal_roles.user_id = ( SELECT auth.uid() AS uid)))));

ALTER POLICY internal_users_can_read_org_plans ON public.organization_plans
  USING (has_internal_role(( SELECT auth.uid() AS uid)));

ALTER POLICY support_templates_select ON public.support_response_templates
  USING (true);

-- Sections 17-18 (dependency fix). support_sla_settings policies before PR3: n=2 md5=807b7e3820f853eb4e18e29bfe74f922
ALTER POLICY support_templates_manage ON public.support_response_templates
  USING ((EXISTS ( SELECT 1
   FROM ((internal_roles ir
     JOIN admin_role_permissions arp ON ((arp.role_id = ir.role_id)))
     JOIN admin_permissions ap ON ((ap.id = arp.permission_id)))
  WHERE ((ir.user_id = ( SELECT auth.uid() AS uid)) AND (ap.key = ANY (ARRAY['support.manage'::text, 'support.admin'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM ((internal_roles ir
     JOIN admin_role_permissions arp ON ((arp.role_id = ir.role_id)))
     JOIN admin_permissions ap ON ((ap.id = arp.permission_id)))
  WHERE ((ir.user_id = ( SELECT auth.uid() AS uid)) AND (ap.key = ANY (ARRAY['support.manage'::text, 'support.admin'::text]))))));

ALTER POLICY support_sla_settings_update_admin ON public.support_sla_settings
  USING ((EXISTS ( SELECT 1
   FROM ((internal_roles ir
     JOIN admin_role_permissions arp ON ((arp.role_id = ir.role_id)))
     JOIN admin_permissions ap ON ((ap.id = arp.permission_id)))
  WHERE ((ir.user_id = ( SELECT auth.uid() AS uid)) AND (ap.key = 'support.admin'::text)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM ((internal_roles ir
     JOIN admin_role_permissions arp ON ((arp.role_id = ir.role_id)))
     JOIN admin_permissions ap ON ((ap.id = arp.permission_id)))
  WHERE ((ir.user_id = ( SELECT auth.uid() AS uid)) AND (ap.key = 'support.admin'::text)))));
