-- BACKLOG-4084 rollback (keepr-test, or production with a go). Restores report_list_saved_views to the
-- 3450 body (as pg_get_functiondef printed it on keepr-test before the apply), removes
-- report_set_default_view, the one-default index and the is_default column, and the version row.
-- CREATE OR REPLACE keeps report_list_saved_views' grants as they are.
CREATE OR REPLACE FUNCTION public.report_list_saved_views(p_report_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID := auth.uid();
  v_views JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id,
    'name', v.name,
    'filters', v.filters,
    'metric', v.metric,
    'pinned', v.pinned,
    'created_at', v.created_at
  ) ORDER BY v.name ASC), '[]'::jsonb)
  INTO v_views
  FROM report_saved_views v
  -- THE ISOLATION. This function is SECURITY DEFINER, so the RLS policy above
  -- does not apply to it: delete this line and every internal user sees every
  -- other internal user's saved views, with no error anywhere.
  WHERE v.user_id = v_caller_id
    AND v.report_key = p_report_key;

  RETURN v_views;
END;
$function$;
DROP FUNCTION IF EXISTS public.report_set_default_view(TEXT, UUID);
DROP INDEX IF EXISTS public.report_saved_views_one_default;
ALTER TABLE public.report_saved_views DROP COLUMN IF EXISTS is_default;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261031180000';
