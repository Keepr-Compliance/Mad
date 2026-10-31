-- BACKLOG-4098 rollback (keepr-test, or prod with a go). Restores admin_list_organizations() to the
-- body without is_personal / is_test. CREATE OR REPLACE keeps the function's grants and comment as the
-- migration left them. Also removes the migration's version row.
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
      'member_count', (SELECT count(*) FROM organization_members om WHERE om.organization_id = o.id)
    ) ORDER BY o.name)
    FROM organizations o
    LEFT JOIN organization_plans op ON op.organization_id = o.id
    LEFT JOIN plans p ON p.id = op.plan_id
  ));
END;
$function$;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261031160000';
