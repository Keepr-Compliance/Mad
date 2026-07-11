-- GIT<->PROD PARITY MIRROR: this file mirrors the migration already applied to PROD
-- (supabase_migrations.schema_migrations version 20260711072238) via MCP apply_migration
-- on 2026-07-11. DO NOT re-apply — the database already has it. Ref BACKLOG-1956.
-- BACKLOG-1956: Add internal-role guard to 2 SECURITY DEFINER pm_* delete mutators.
-- pm_bulk_delete and pm_delete_project are EXECUTE-granted to anon/authenticated but did
-- NOT verify the caller's internal role, so any authenticated (or anon) principal could
-- soft-delete backlog items / projects. Guard idiom copied verbatim from the correctly-
-- guarded post-BACKLOG-1875 sibling pm_update_item_status:
--     IF auth.role() IS DISTINCT FROM 'service_role'
--        AND NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id) THEN
--       RAISE EXCEPTION 'Access denied: internal role required';
--     END IF;
-- This idiom lets service_role machine callers (CI/hooks, auth.uid() = NULL) through while
-- rejecting non-internal authenticated users, matching the other pm_* mutators.
-- CREATE OR REPLACE preserves existing EXECUTE grants; grants are NOT changed.

CREATE OR REPLACE FUNCTION public.pm_bulk_delete(p_item_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count INT;
  v_caller_id UUID := auth.uid();
BEGIN
  -- Internal user check, OR the project service key (machine callers). BACKLOG-1956
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required';
  END IF;

  -- Validate input
  IF p_item_ids IS NULL OR array_length(p_item_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('success', false, 'deleted_count', 0);
  END IF;

  -- Soft-delete all items (only those not already deleted)
  UPDATE pm_backlog_items
  SET deleted_at = NOW(),
      updated_at = NOW()
  WHERE id = ANY(p_item_ids)
    AND deleted_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_count', v_count
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.pm_delete_project(p_project_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID := auth.uid();
BEGIN
  -- Internal user check, OR the project service key (machine callers). BACKLOG-1956
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required';
  END IF;

  UPDATE pm_projects
  SET deleted_at = now(), updated_at = now()
  WHERE id = p_project_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project not found or already deleted';
  END IF;
END;
$function$;
