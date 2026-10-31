-- BACKLOG-4098: admin_list_organizations() returns two more keys per organization.
--   is_personal  true when the organization is a personal organization (personal_owner_user_id is set).
--                The owner id itself is not returned.
--   is_test      organizations.is_test.
-- Everything else is unchanged: the internal-role guard, the reply shape, the other keys, the joins
-- and the ORDER BY o.name. The body below is the current definition with only those two keys added.
-- Callers: admin-portal/app/dashboard/organizations/page.tsx (signed-in internal user).
-- EXECUTE: authenticated and service_role.
-- Plan and review: pm_comments on BACKLOG-4098 (PLAN v1, SR PLAN REVIEW).
-- Rollback: supabase/tests/backlog-4098/rollback-4098.sql (restores the body without the two keys).

CREATE OR REPLACE FUNCTION public.admin_list_organizations()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT has_internal_role(auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  
  RETURN jsonb_build_object('success', true, 'organizations', (
    SELECT jsonb_agg(jsonb_build_object(
      'id', o.id,
      'name', o.name,
      'slug', o.slug,
      'max_seats', o.max_seats,
      'created_at', o.created_at,
      'plan_name', p.name,
      'plan_tier', p.tier,
      'member_count', (SELECT count(*) FROM organization_members om WHERE om.organization_id = o.id),
      'is_personal', (o.personal_owner_user_id IS NOT NULL),
      'is_test', o.is_test
    ) ORDER BY o.name)
    FROM organizations o
    LEFT JOIN organization_plans op ON op.organization_id = o.id
    LEFT JOIN plans p ON p.id = op.plan_id
  ));
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_list_organizations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_organizations() TO authenticated, service_role;

COMMENT ON FUNCTION public.admin_list_organizations() IS
  'Admin portal Organizations list. Internal users only (has_internal_role). Returns {success, organizations: [{id, name, slug, max_seats, created_at, plan_name, plan_tier, member_count, is_personal, is_test}]} ordered by name. BACKLOG-4098.';
