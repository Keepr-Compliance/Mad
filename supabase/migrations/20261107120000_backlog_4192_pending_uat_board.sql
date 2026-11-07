-- BACKLOG-4192: the PM board shows items whose status is 'pending_uat'.
--
-- pm_get_board_tasks(uuid,uuid,text): adds a 'pending_uat' key (built exactly like 'testing').
-- pm_update_item_status(uuid,text): accepts 'pending_uat' (the status CHECK on pm_backlog_items
-- already allows it).
-- Bodies: generated from the live definitions by supabase/tests/backlog-4192/build_migration.py;
-- every other line is unchanged. Caller checks unchanged (internal role; service_role bypass on
-- pm_update_item_status only).
-- Grants: EXECUTE revoked from PUBLIC and anon, granted to authenticated and service_role.
-- Pre-check: each md5(prosrc) must be the pre-4192 body or this body (a re-run is a no-op that
-- still runs the post-check).
-- ORDER: apply to production only after the admin portal that tolerates the new key is live.
-- Rollback: supabase/tests/backlog-4192/rollback-4192.sql. No transaction control in this file.

DO $pre$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.pm_get_board_tasks(uuid,uuid,text)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('cf39c28a71417a23e7e1ed0b950a5598', 'a165917dbfcc47df2db15b8b93471724') THEN
    RAISE EXCEPTION '4192 pre-check: public.pm_get_board_tasks(uuid,uuid,text) differs from the expected body (md5(prosrc) %)', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.pm_update_item_status(uuid,text)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('dcb70919845b12cbe1bdc7ed68c9d3ec', 'af73dbf8cd60dd5fe881a1467568bc1f') THEN
    RAISE EXCEPTION '4192 pre-check: public.pm_update_item_status(uuid,text) differs from the expected body (md5(prosrc) %)', v_md5;
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.pm_get_board_tasks(p_sprint_id uuid DEFAULT NULL::uuid, p_project_id uuid DEFAULT NULL::uuid, p_area text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID := auth.uid();
  v_columns JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required';
  END IF;

  IF p_sprint_id IS NULL AND p_project_id IS NULL THEN
    RAISE EXCEPTION 'At least one filter required: p_sprint_id or p_project_id';
  END IF;

  SELECT jsonb_build_object(
    'pending', COALESCE((
      SELECT jsonb_agg(item_row ORDER BY i_sort ASC)
      FROM (
        SELECT to_jsonb(i.*) AS item_row, i.sort_order AS i_sort
        FROM pm_backlog_items i
        WHERE i.status = 'pending' AND i.deleted_at IS NULL
          AND (p_sprint_id IS NULL OR i.sprint_id = p_sprint_id)
          AND (p_project_id IS NULL OR i.project_id = p_project_id)
          AND (p_area IS NULL OR i.area = p_area)
        ORDER BY i.sort_order ASC
      ) sub
    ), '[]'::jsonb),
    'in_progress', COALESCE((
      SELECT jsonb_agg(item_row ORDER BY i_sort ASC)
      FROM (
        SELECT to_jsonb(i.*) AS item_row, i.sort_order AS i_sort
        FROM pm_backlog_items i
        WHERE i.status = 'in_progress' AND i.deleted_at IS NULL
          AND (p_sprint_id IS NULL OR i.sprint_id = p_sprint_id)
          AND (p_project_id IS NULL OR i.project_id = p_project_id)
          AND (p_area IS NULL OR i.area = p_area)
        ORDER BY i.sort_order ASC
      ) sub
    ), '[]'::jsonb),
    'testing', COALESCE((
      SELECT jsonb_agg(item_row ORDER BY i_sort ASC)
      FROM (
        SELECT to_jsonb(i.*) AS item_row, i.sort_order AS i_sort
        FROM pm_backlog_items i
        WHERE i.status = 'testing' AND i.deleted_at IS NULL
          AND (p_sprint_id IS NULL OR i.sprint_id = p_sprint_id)
          AND (p_project_id IS NULL OR i.project_id = p_project_id)
          AND (p_area IS NULL OR i.area = p_area)
        ORDER BY i.sort_order ASC
      ) sub
    ), '[]'::jsonb),
    'pending_uat', COALESCE((
      SELECT jsonb_agg(item_row ORDER BY i_sort ASC)
      FROM (
        SELECT to_jsonb(i.*) AS item_row, i.sort_order AS i_sort
        FROM pm_backlog_items i
        WHERE i.status = 'pending_uat' AND i.deleted_at IS NULL
          AND (p_sprint_id IS NULL OR i.sprint_id = p_sprint_id)
          AND (p_project_id IS NULL OR i.project_id = p_project_id)
          AND (p_area IS NULL OR i.area = p_area)
        ORDER BY i.sort_order ASC
      ) sub
    ), '[]'::jsonb),
    'waiting_for_user', COALESCE((
      SELECT jsonb_agg(item_row ORDER BY i_sort ASC)
      FROM (
        SELECT to_jsonb(i.*) AS item_row, i.sort_order AS i_sort
        FROM pm_backlog_items i
        WHERE i.status = 'waiting_for_user' AND i.deleted_at IS NULL
          AND (p_sprint_id IS NULL OR i.sprint_id = p_sprint_id)
          AND (p_project_id IS NULL OR i.project_id = p_project_id)
          AND (p_area IS NULL OR i.area = p_area)
        ORDER BY i.sort_order ASC
      ) sub
    ), '[]'::jsonb),
    'completed', COALESCE((
      SELECT jsonb_agg(item_row ORDER BY i_sort ASC)
      FROM (
        SELECT to_jsonb(i.*) AS item_row, i.sort_order AS i_sort
        FROM pm_backlog_items i
        WHERE i.status = 'completed' AND i.deleted_at IS NULL
          AND (p_sprint_id IS NULL OR i.sprint_id = p_sprint_id)
          AND (p_project_id IS NULL OR i.project_id = p_project_id)
          AND (p_area IS NULL OR i.area = p_area)
        ORDER BY i.sort_order ASC
      ) sub
    ), '[]'::jsonb),
    'blocked', COALESCE((
      SELECT jsonb_agg(item_row ORDER BY i_sort ASC)
      FROM (
        SELECT to_jsonb(i.*) AS item_row, i.sort_order AS i_sort
        FROM pm_backlog_items i
        WHERE i.status = 'blocked' AND i.deleted_at IS NULL
          AND (p_sprint_id IS NULL OR i.sprint_id = p_sprint_id)
          AND (p_project_id IS NULL OR i.project_id = p_project_id)
          AND (p_area IS NULL OR i.area = p_area)
        ORDER BY i.sort_order ASC
      ) sub
    ), '[]'::jsonb),
    'deferred', COALESCE((
      SELECT jsonb_agg(item_row ORDER BY i_sort ASC)
      FROM (
        SELECT to_jsonb(i.*) AS item_row, i.sort_order AS i_sort
        FROM pm_backlog_items i
        WHERE i.status = 'deferred' AND i.deleted_at IS NULL
          AND (p_sprint_id IS NULL OR i.sprint_id = p_sprint_id)
          AND (p_project_id IS NULL OR i.project_id = p_project_id)
          AND (p_area IS NULL OR i.area = p_area)
        ORDER BY i.sort_order ASC
      ) sub
    ), '[]'::jsonb),
    'obsolete', COALESCE((
      SELECT jsonb_agg(item_row ORDER BY i_sort ASC)
      FROM (
        SELECT to_jsonb(i.*) AS item_row, i.sort_order AS i_sort
        FROM pm_backlog_items i
        WHERE i.status = 'obsolete' AND i.deleted_at IS NULL
          AND (p_sprint_id IS NULL OR i.sprint_id = p_sprint_id)
          AND (p_project_id IS NULL OR i.project_id = p_project_id)
          AND (p_area IS NULL OR i.area = p_area)
        ORDER BY i.sort_order ASC
      ) sub
    ), '[]'::jsonb),
    'reopened', COALESCE((
      SELECT jsonb_agg(item_row ORDER BY i_sort ASC)
      FROM (
        SELECT to_jsonb(i.*) AS item_row, i.sort_order AS i_sort
        FROM pm_backlog_items i
        WHERE i.status = 'reopened' AND i.deleted_at IS NULL
          AND (p_sprint_id IS NULL OR i.sprint_id = p_sprint_id)
          AND (p_project_id IS NULL OR i.project_id = p_project_id)
          AND (p_area IS NULL OR i.area = p_area)
        ORDER BY i.sort_order ASC
      ) sub
    ), '[]'::jsonb)
  ) INTO v_columns;

  RETURN v_columns;
END;
$function$;

CREATE OR REPLACE FUNCTION public.pm_update_item_status(p_item_id uuid, p_new_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID := auth.uid();
  v_old_status TEXT;
  v_has_blockers BOOLEAN;
BEGIN
  -- Internal user check, OR the project service key (machine callers). BACKLOG-1875
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required';
  END IF;

  IF p_new_status NOT IN ('pending', 'in_progress', 'testing', 'pending_uat', 'completed', 'blocked', 'deferred', 'obsolete', 'reopened', 'waiting_for_user') THEN
    RAISE EXCEPTION 'Invalid status: %. Must be one of: pending, in_progress, testing, pending_uat, completed, blocked, deferred, obsolete, reopened, waiting_for_user', p_new_status;
  END IF;

  SELECT status INTO v_old_status
  FROM pm_backlog_items
  WHERE id = p_item_id AND deleted_at IS NULL;

  IF v_old_status IS NULL THEN
    RAISE EXCEPTION 'Item not found: %', p_item_id;
  END IF;

  IF v_old_status = p_new_status THEN
    RETURN jsonb_build_object('success', true, 'old_status', v_old_status, 'new_status', p_new_status, 'changed', false);
  END IF;

  IF p_new_status = 'in_progress' THEN
    SELECT EXISTS (
      SELECT 1
      FROM pm_task_links tl
      JOIN pm_backlog_items blocker ON blocker.id = tl.source_id
      WHERE tl.target_id = p_item_id
        AND tl.link_type = 'blocked_by'
        AND blocker.status != 'completed'
        AND blocker.deleted_at IS NULL
    ) INTO v_has_blockers;

    IF v_has_blockers THEN
      RAISE EXCEPTION 'Cannot move to in_progress: item has uncompleted blockers';
    END IF;
  END IF;

  UPDATE pm_backlog_items
  SET
    status = p_new_status,
    completed_at = CASE WHEN p_new_status = 'completed' THEN now() ELSE completed_at END
  WHERE id = p_item_id;

  INSERT INTO pm_events (item_id, actor_id, event_type, old_value, new_value)
  VALUES (p_item_id, v_caller_id, 'status_changed', v_old_status, p_new_status);

  RETURN jsonb_build_object('success', true, 'old_status', v_old_status, 'new_status', p_new_status);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.pm_get_board_tasks(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_get_board_tasks(uuid, uuid, text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.pm_update_item_status(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_update_item_status(uuid, text) TO authenticated, service_role;

DO $post$
DECLARE v_md5 text; v_acl text;
BEGIN
  SELECT md5(prosrc), proacl::text INTO v_md5, v_acl FROM pg_proc WHERE oid = to_regprocedure('public.pm_get_board_tasks(uuid,uuid,text)');
  IF v_md5 IS DISTINCT FROM 'a165917dbfcc47df2db15b8b93471724' THEN
    RAISE EXCEPTION '4192 post-check: public.pm_get_board_tasks(uuid,uuid,text) md5(prosrc) is %, expected a165917dbfcc47df2db15b8b93471724', v_md5;
  END IF;
  IF v_acl IS NULL OR v_acl NOT IN ('{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION '4192 post-check: public.pm_get_board_tasks(uuid,uuid,text) ACL is %', v_acl;
  END IF;
  SELECT md5(prosrc), proacl::text INTO v_md5, v_acl FROM pg_proc WHERE oid = to_regprocedure('public.pm_update_item_status(uuid,text)');
  IF v_md5 IS DISTINCT FROM 'af73dbf8cd60dd5fe881a1467568bc1f' THEN
    RAISE EXCEPTION '4192 post-check: public.pm_update_item_status(uuid,text) md5(prosrc) is %, expected af73dbf8cd60dd5fe881a1467568bc1f', v_md5;
  END IF;
  IF v_acl IS NULL OR v_acl NOT IN ('{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN
    RAISE EXCEPTION '4192 post-check: public.pm_update_item_status(uuid,text) ACL is %', v_acl;
  END IF;
END $post$;
