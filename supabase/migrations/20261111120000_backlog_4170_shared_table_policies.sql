-- BACKLOG-4170 PR3 — sixteen SELECT policies read per admin permission (+ two dependent policies)
--
-- Fifteen SELECT policies admitted any internal role (has_internal_role(), or EXISTS internal_roles),
-- and support_templates_select admitted every signed-in user (USING true). This migration replaces
-- ONLY that branch, per table, with an admin permission check:
--   (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY[...]))
-- and, on credit_ledger / transaction_unlocks / account_suspensions, the support requester set from
-- 4145 M1: user_id IN (SELECT public.support_my_requester_ids()) (requester_id of every ticket for
-- support.admin, of tickets assigned to the caller for support.view), as licenses already does.
-- Every own-row, own-role, member and service-role branch is kept exactly as it was, including the
-- stripe_customers live-mode condition.
--
-- The policies are changed IN PLACE with ALTER POLICY: same names, commands and count. No policy is
-- added (permissive policies OR together, so an added policy would leave the old access open). Every
-- helper is caller-bound SECURITY DEFINER with EXECUTE granted to authenticated, and every call is
-- wrapped in (SELECT ...) so it runs once per statement. Grants are unchanged (TRUNCATE stays revoked
-- from anon and authenticated on all 16 tables).
--
-- Keys per table (readers):
--   credit_ledger, transaction_unlocks   users.view + support requester; own rows kept
--                                        (admin-portal/lib/billing-queries.ts:263,270, service client
--                                         on users/[id]; electron/services/entitlementService.ts:390 own)
--   account_suspensions                  users.view + support requester (lib/suspension-queries.ts:103,
--                                         broker-portal/lib/billing/suspensionCause.ts:18, both service)
--   payment_intents, stripe_customers    billing.view; own rows kept (broker-portal service clients;
--                                         electron/services/paymentService.ts:481 own live row)
--   individual_invitations               users.edit (no session reader)
--   app_lifecycle_events                 analytics.view (insert-only from the desktop app)
--   email_delivery_log                   support.view (admin-portal/lib/support-queries.ts:1097,
--                                         EmailLogPanel); now TO authenticated (previously PUBLIC)
--   email_delivery_queue                 support.view (no session reader)
--   admin_audit_logs                     audit.view (read through admin_get_audit_logs)
--   admin_roles                          own role, or roles.view / roles.manage / internal_users.view /
--                                         internal_users.manage (components/providers/PermissionsProvider.tsx:57,
--                                         app/dashboard/page.tsx:22 own role; settings/page.tsx:74,122,148;
--                                         api/internal-users/invite/route.ts:59, resend-invite/route.ts:64)
--   admin_permissions,
--   admin_role_permissions               roles.view / roles.manage (settings/page.tsx:159,187)
--   pending_internal_invitations         internal_users.view / internal_users.manage (settings/page.tsx:116;
--                                         settings/components/InternalUsersTable.tsx:142 DELETE..RETURNING;
--                                         api/internal-users/resend-invite/route.ts:48). The invitee's own
--                                         row (users_can_read_own_invitation) is unchanged.
--   organization_plans                   organizations.view / users.view / support.view: the
--                                         organizations(organization_plans(...)) embeds on
--                                         organizations/[id]/page.tsx:86 and users/[id]/page.tsx:78 (the
--                                         users/[id] route admits users.view or support.view).
--   support_response_templates           support.view (agents read templates through the SECURITY DEFINER
--                                         support_list_templates; there is no direct table reader).
--
-- organization_plans keeps two SELECT policies: organization_plans_select_authenticated (plans.view or
-- organization member) and internal_users_can_read_org_plans (the page keys above). They OR together.
-- Folding them into one policy would change the policy count and is left to a follow-up.
--
-- payment_intents, stripe_customers (billing.view), individual_invitations (users.edit) and
-- app_lifecycle_events (analytics.view) take the reversible defaults of open question Q3 on BACKLOG-4170.
--
-- Sections 17-18: support_templates_manage (support.manage / support.admin) and
-- support_sla_settings_update_admin (support.admin) evaluated the permission join inline; they now call
-- the helper with the same key sets so they do not depend on the admin_role_permissions read policy.
-- Policy count is unchanged (18 ALTER POLICY, 0 added, 0 dropped).
--
-- Idempotent: ALTER POLICY sets the same text on every run.
-- Rollback: supabase/tests/backlog-4170-p3/rollback-4170-p3.sql (verbatim prior text).

-- ============================================================
-- 1. credit_ledger
-- ============================================================
ALTER POLICY credit_ledger_select_own ON public.credit_ledger
  USING (
    (( SELECT auth.uid() AS uid) = user_id)
    OR (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['users.view']))
    OR (user_id IN (SELECT public.support_my_requester_ids()))
  );

-- ============================================================
-- 2. transaction_unlocks
-- ============================================================
ALTER POLICY transaction_unlocks_select_own ON public.transaction_unlocks
  USING (
    (( SELECT auth.uid() AS uid) = user_id)
    OR (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['users.view']))
    OR (user_id IN (SELECT public.support_my_requester_ids()))
  );

-- ============================================================
-- 3. account_suspensions (no own-row branch before or after)
-- ============================================================
ALTER POLICY account_suspensions_internal_select ON public.account_suspensions
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['users.view']))
    OR (user_id IN (SELECT public.support_my_requester_ids()))
  );

-- ============================================================
-- 4. payment_intents
-- ============================================================
ALTER POLICY payment_intents_select_own ON public.payment_intents
  USING (
    (( SELECT auth.uid() AS uid) = user_id)
    OR (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['billing.view']))
  );

-- ============================================================
-- 5. stripe_customers
-- ============================================================
ALTER POLICY stripe_customers_select_own ON public.stripe_customers
  USING (
    ((( SELECT auth.uid() AS uid) = user_id) AND (stripe_mode = 'live'::text))
    OR (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['billing.view']))
  );

-- ============================================================
-- 6. individual_invitations
-- ============================================================
ALTER POLICY internal_users_can_read_individual_invitations ON public.individual_invitations
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['users.edit']))
  );

-- ============================================================
-- 7. email_delivery_log
-- ============================================================
ALTER POLICY "Internal users can read logs" ON public.email_delivery_log
  TO authenticated
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['support.view']))
  );

-- ============================================================
-- 8. email_delivery_queue
-- ============================================================
ALTER POLICY "email_delivery_queue internal read" ON public.email_delivery_queue
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['support.view']))
  );

-- ============================================================
-- 9. admin_audit_logs
-- ============================================================
ALTER POLICY "Internal users can view admin audit logs" ON public.admin_audit_logs
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['audit.view']))
  );

-- ============================================================
-- 10. admin_roles (own role kept for every internal user)
-- ============================================================
ALTER POLICY "Internal users can view roles" ON public.admin_roles
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['roles.view', 'roles.manage', 'internal_users.view', 'internal_users.manage']))
    OR (id IN (SELECT ir.role_id FROM public.internal_roles ir WHERE ir.user_id = (SELECT auth.uid())))
  );

-- ============================================================
-- 11. admin_permissions
-- ============================================================
ALTER POLICY "Internal users can view permissions" ON public.admin_permissions
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['roles.view', 'roles.manage']))
  );

-- ============================================================
-- 12. admin_role_permissions
-- ============================================================
ALTER POLICY "Internal users can view role permissions" ON public.admin_role_permissions
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['roles.view', 'roles.manage']))
  );

-- ============================================================
-- 13. pending_internal_invitations
-- ============================================================
ALTER POLICY internal_users_read_invitations ON public.pending_internal_invitations
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['internal_users.view', 'internal_users.manage']))
  );

-- ============================================================
-- 14. app_lifecycle_events
-- ============================================================
ALTER POLICY "Internal roles can read lifecycle events" ON public.app_lifecycle_events
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['analytics.view']))
  );

-- ============================================================
-- 15. organization_plans (second SELECT policy organization_plans_select_authenticated unchanged)
-- ============================================================
ALTER POLICY internal_users_can_read_org_plans ON public.organization_plans
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['organizations.view', 'users.view', 'support.view']))
  );

-- ============================================================
-- 16. support_response_templates (support_templates_manage, FOR ALL, unchanged)
-- ============================================================
ALTER POLICY support_templates_select ON public.support_response_templates
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['support.view']))
  );

-- ============================================================
-- 17-18. Policies that evaluated the permission join inline
-- ============================================================
-- support_templates_manage and support_sla_settings_update_admin read internal_roles ->
-- admin_role_permissions -> admin_permissions inside the policy, as the caller. With section 11-12
-- those two tables are readable only with roles.view / roles.manage, so the inline join would no longer
-- find the caller's own keys. They now call the SECURITY DEFINER helper with the same key sets, so they
-- do not depend on the admin_role_permissions / admin_permissions read policies. USING and WITH CHECK
-- are both set (ALTER POLICY without WITH CHECK keeps the previous one).
ALTER POLICY support_templates_manage ON public.support_response_templates
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['support.manage', 'support.admin']))
  )
  WITH CHECK (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['support.manage', 'support.admin']))
  );

ALTER POLICY support_sla_settings_update_admin ON public.support_sla_settings
  USING (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['support.admin']))
  )
  WITH CHECK (
    (SELECT public.has_any_permission((SELECT auth.uid()), ARRAY['support.admin']))
  );
