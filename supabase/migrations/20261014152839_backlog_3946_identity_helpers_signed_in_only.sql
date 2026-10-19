-- BACKLOG-3946 (B of 3): the seven identity helpers are executable by signed-in sessions
-- only, and every row-level security policy that calls one applies to signed-in sessions.
--
-- 1. 22 policies move from TO public to TO authenticated. Each is false for a NULL
--    auth.uid() already (every term is a helper on auth.uid(), a column compared to
--    auth.uid(), or ANDed with one), so a signed-out read returns what it returned before.
--    Other policies on these tables are unchanged.
-- 2. EXECUTE is removed from PUBLIC and anon on has_internal_role, get_user_org_ids,
--    is_org_admin, is_super_admin, get_user_permissions, has_permission and
--    has_any_permission (the last two already held none; listed so the file states the
--    full end state). authenticated and service_role keep EXECUTE.
--
-- Policies first, then the grant changes: a partial apply never leaves a TO public policy
-- calling a helper anon cannot execute.
--
-- Apply as one transaction. No BEGIN/COMMIT here.
-- Rollback: supabase/tests/backlog-3946/rollback-B.sql

ALTER POLICY "Internal users can view admin audit logs" ON public.admin_audit_logs TO authenticated;
ALTER POLICY "Internal users can view permissions" ON public.admin_permissions TO authenticated;
ALTER POLICY "Internal users can view role permissions" ON public.admin_role_permissions TO authenticated;
ALTER POLICY "Internal users can view roles" ON public.admin_roles TO authenticated;
ALTER POLICY analytics_events_select_own_or_internal ON public.analytics_events TO authenticated;
ALTER POLICY audit_logs_select_public ON public.audit_logs TO authenticated;
ALTER POLICY credit_ledger_select_own ON public.credit_ledger TO authenticated;
ALTER POLICY devices_select_public ON public.devices TO authenticated;
ALTER POLICY "Internal users can view their own sessions" ON public.impersonation_sessions TO authenticated;
ALTER POLICY internal_users_can_read_individual_invitations ON public.individual_invitations TO authenticated;
ALTER POLICY "Super admins can manage internal roles" ON public.internal_roles TO authenticated;
ALTER POLICY licenses_select_public ON public.licenses TO authenticated;
ALTER POLICY organization_members_all_public ON public.organization_members TO authenticated;
ALTER POLICY organization_members_select_public ON public.organization_members TO authenticated;
ALTER POLICY internal_users_can_read_org_plans ON public.organization_plans TO authenticated;
ALTER POLICY organizations_select_public ON public.organizations TO authenticated;
ALTER POLICY payment_intents_select_own ON public.payment_intents TO authenticated;
ALTER POLICY internal_users_can_manage_invitations ON public.pending_internal_invitations TO authenticated;
ALTER POLICY stripe_customers_select_own ON public.stripe_customers TO authenticated;
ALTER POLICY transaction_unlocks_select_own ON public.transaction_unlocks TO authenticated;
ALTER POLICY user_preferences_select_internal ON public.user_preferences TO authenticated;
ALTER POLICY users_select_public ON public.users TO authenticated;

REVOKE EXECUTE ON FUNCTION public.has_internal_role(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_user_org_ids(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_org_admin(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_super_admin(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_user_permissions(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_permission(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_any_permission(uuid, text[]) FROM PUBLIC, anon;
