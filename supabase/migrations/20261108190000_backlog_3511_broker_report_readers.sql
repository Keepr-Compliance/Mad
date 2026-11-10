-- ============================================================================
-- Migration: Add the broker report reader helper public.org_report_scope
-- Backlog: BACKLOG-3511 (broker half), design in BACKLOG-3505 PLAN v1
-- Purpose:
--   One caller-bound answer for the row policies of every broker-portal report
--   table or view: what may the CALLER read in organization p_org?
--
--     'all' -> an ACTIVE member of a brokerage organization whose role is a
--              full portal role: broker, admin or it_admin (founder ruling,
--              pm_comments 85aaac88 on BACKLOG-3505).
--     'own' -> an ACTIVE agent of a brokerage organization: own rows only
--              (founder: every active agent of the organization).
--     NULL  -> anybody else: not a member, not active (pending, suspended,
--              expired, unassigned), signed out, or a member of a PERSONAL
--              organization (organizations.personal_owner_user_id set).
--
--   "Active" mirrors the live split-agreement helpers
--   (can_write_split_agreements, is_active_split_member):
--   organization_members.license_status = 'active', caller = auth.uid().
--   The full-role set mirrors FULL_PORTAL_ROLES in
--   packages/shared/src/billing/planRule.ts; the broker-portal parity test
--   (__tests__/reports-3511/roleParity.test.ts) reads the IN list below.
--
-- The two standard report policies built on it (row scope only narrows):
--   org-wide : USING (public.org_report_scope(organization_id) = 'all')
--   own rows : USING (public.org_report_scope(organization_id) = 'own'
--                     AND agent_user_id = (SELECT auth.uid()))
--
-- SECURITY DEFINER so a policy can read organization_members and
-- organizations whatever their own RLS says. The caller check is inside: every
-- row read is the caller's own (user_id = auth.uid()), so it reveals nothing
-- the caller could not already know. EXECUTE: authenticated only.
--
-- Idempotent: CREATE OR REPLACE, then REVOKE / GRANT (re-running changes
-- nothing). No existing policy, table or function is changed.
--
-- Rollback: supabase/tests/backlog-3511/rollback-3511.sql.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.org_report_scope(p_org uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT CASE
           WHEN m.role IN ('broker', 'admin', 'it_admin') THEN 'all'
           WHEN m.role = 'agent' THEN 'own'
         END
    FROM public.organization_members m
    JOIN public.organizations o ON o.id = m.organization_id
   WHERE m.organization_id = p_org
     AND m.user_id = (SELECT auth.uid())
     AND m.license_status = 'active'
     AND o.personal_owner_user_id IS NULL
   LIMIT 1;
$function$;

COMMENT ON FUNCTION public.org_report_scope(uuid) IS
  'BACKLOG-3511: report row scope of the caller in p_org: all (active broker/admin/it_admin), own (active agent), NULL otherwise. Brokerage organizations only.';

REVOKE EXECUTE ON FUNCTION public.org_report_scope(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_report_scope(uuid) TO authenticated;
