-- BACKLOG-1875: allow service-role (machine) callers on PM RPCs used by CI/hooks.
-- The strict internal_roles guard rejected service-role callers (auth.uid() IS NULL),
-- silently breaking pm-task-sync.yml (errors were masked as "task not found").
-- Adopts the existing pattern from pm_add_comment: interactive callers must be in
-- internal_roles; holders of the project service key (which already bypasses RLS
-- everywhere) are trusted machine callers. Function bodies otherwise unchanged.
--
-- Applied to production 2026-07-07 via Supabase MCP apply_migration
-- (as backlog_1875_pm_rpc_service_role_bypass + backlog_1875_pm_get_item_detail_bypass);
-- this file mirrors both for repo history.

CREATE OR REPLACE FUNCTION public.pm_update_task_status(p_task_id uuid, p_new_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID := auth.uid();
  v_old_status TEXT;
  v_valid_statuses TEXT[] := ARRAY['pending', 'in_progress', 'testing', 'completed', 'blocked', 'deferred'];
BEGIN
  -- Internal user check, OR the project service key (machine callers). BACKLOG-1875
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required';
  END IF;

  IF NOT (p_new_status = ANY(v_valid_statuses)) THEN
    RAISE EXCEPTION 'Invalid status: %. Must be one of: pending, in_progress, testing, completed, blocked, deferred', p_new_status;
  END IF;

  SELECT status INTO v_old_status
  FROM pm_tasks
  WHERE id = p_task_id AND deleted_at IS NULL;

  IF v_old_status IS NULL THEN
    RAISE EXCEPTION 'Task not found: %', p_task_id;
  END IF;

  IF v_old_status = p_new_status THEN
    RETURN jsonb_build_object(
      'success', true, 'task_id', p_task_id,
      'old_status', v_old_status, 'new_status', p_new_status, 'changed', false
    );
  END IF;

  UPDATE pm_tasks
  SET status = p_new_status, updated_at = now(),
      completed_at = CASE WHEN p_new_status = 'completed' THEN now() ELSE completed_at END
  WHERE id = p_task_id;

  INSERT INTO pm_events (task_id, event_type, old_value, new_value, metadata)
  VALUES (p_task_id, 'status_changed', v_old_status, p_new_status,
    jsonb_build_object('source', 'pm_update_task_status'));

  RETURN jsonb_build_object(
    'success', true, 'task_id', p_task_id,
    'old_status', v_old_status, 'new_status', p_new_status, 'changed', true
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.pm_get_task_by_legacy_id(p_legacy_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID := auth.uid();
  v_task RECORD;
BEGIN
  -- Internal user check, OR the project service key (machine callers). BACKLOG-1875
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required';
  END IF;

  IF p_legacy_id IS NULL OR trim(p_legacy_id) = '' THEN
    RAISE EXCEPTION 'legacy_id is required and cannot be empty';
  END IF;

  SELECT id, legacy_id, title, status, backlog_item_id, sprint_id
  INTO v_task
  FROM pm_tasks
  WHERE legacy_id = p_legacy_id AND deleted_at IS NULL;

  IF v_task IS NULL THEN
    RETURN jsonb_build_object('error', 'Task not found');
  END IF;

  RETURN jsonb_build_object(
    'id', v_task.id, 'legacy_id', v_task.legacy_id,
    'title', v_task.title, 'status', v_task.status,
    'backlog_item_id', v_task.backlog_item_id, 'sprint_id', v_task.sprint_id
  );
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

  IF p_new_status NOT IN ('pending', 'in_progress', 'testing', 'completed', 'blocked', 'deferred', 'obsolete', 'reopened', 'waiting_for_user') THEN
    RAISE EXCEPTION 'Invalid status: %. Must be one of: pending, in_progress, testing, completed, blocked, deferred, obsolete, reopened, waiting_for_user', p_new_status;
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

CREATE OR REPLACE FUNCTION public.pm_get_item_by_legacy_id(p_legacy_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID := auth.uid();
  v_item_id UUID;
BEGIN
  -- Internal user check, OR the project service key (machine callers). BACKLOG-1875
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required';
  END IF;

  SELECT id INTO v_item_id
  FROM pm_backlog_items
  WHERE legacy_id = p_legacy_id AND deleted_at IS NULL;

  IF v_item_id IS NULL THEN
    RAISE EXCEPTION 'Item not found with legacy_id: %', p_legacy_id;
  END IF;

  RETURN pm_get_item_detail(v_item_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.pm_get_item_detail(p_item_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID := auth.uid();
  v_item JSONB;
  v_comments JSONB;
  v_events JSONB;
  v_links JSONB;
  v_labels JSONB;
  v_children JSONB;
  v_parent JSONB;
BEGIN
  -- Internal user check, OR the project service key (machine callers). BACKLOG-1875
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required';
  END IF;

  SELECT to_jsonb(i.*) INTO v_item
  FROM pm_backlog_items i
  WHERE i.id = p_item_id AND i.deleted_at IS NULL;

  IF v_item IS NULL THEN
    RAISE EXCEPTION 'Item not found: %', p_item_id;
  END IF;

  -- Comments with author name/email from auth.users
  SELECT COALESCE(jsonb_agg(
    to_jsonb(c.*) || jsonb_build_object(
      'author_name', COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', u.email),
      'author_email', u.email
    )
    ORDER BY c.created_at ASC
  ), '[]'::jsonb)
  INTO v_comments
  FROM pm_comments c
  LEFT JOIN auth.users u ON u.id = c.author_id
  WHERE c.item_id = p_item_id AND c.deleted_at IS NULL;

  -- Events with actor name/email from auth.users
  SELECT COALESCE(jsonb_agg(
    to_jsonb(e.*) || jsonb_build_object(
      'actor_name', COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', u.email),
      'actor_email', u.email
    )
    ORDER BY e.created_at ASC
  ), '[]'::jsonb)
  INTO v_events
  FROM pm_events e
  LEFT JOIN auth.users u ON u.id = e.actor_id
  WHERE e.item_id = p_item_id;

  SELECT COALESCE(jsonb_agg(link_row), '[]'::jsonb)
  INTO v_links
  FROM (
    SELECT jsonb_build_object(
      'link_id', tl.id,
      'link_type', tl.link_type,
      'direction', CASE WHEN tl.source_id = p_item_id THEN 'outgoing' ELSE 'incoming' END,
      'item_id', other.id,
      'item_title', other.title,
      'item_legacy_id', other.legacy_id,
      'item_status', other.status
    ) AS link_row
    FROM pm_task_links tl
    JOIN pm_backlog_items other ON other.id = CASE
      WHEN tl.source_id = p_item_id THEN tl.target_id
      ELSE tl.source_id
    END
    WHERE (tl.source_id = p_item_id OR tl.target_id = p_item_id)
      AND other.deleted_at IS NULL
  ) sub;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'color', l.color)), '[]'::jsonb)
  INTO v_labels
  FROM pm_item_labels il
  JOIN pm_labels l ON l.id = il.label_id
  WHERE il.item_id = p_item_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'title', c.title, 'legacy_id', c.legacy_id,
    'status', c.status, 'priority', c.priority, 'type', c.type
  ) ORDER BY c.sort_order ASC, c.created_at DESC), '[]'::jsonb)
  INTO v_children
  FROM pm_backlog_items c
  WHERE c.parent_id = p_item_id AND c.deleted_at IS NULL;

  -- Parent item details (when this item has a parent_id)
  SELECT jsonb_build_object(
    'id', p.id, 'title', p.title, 'item_number', p.item_number,
    'legacy_id', p.legacy_id, 'status', p.status, 'priority', p.priority, 'type', p.type
  )
  INTO v_parent
  FROM pm_backlog_items p
  WHERE p.id = (v_item->>'parent_id')::UUID AND p.deleted_at IS NULL;

  RETURN jsonb_build_object(
    'item', v_item,
    'comments', v_comments,
    'events', v_events,
    'links', v_links,
    'labels', v_labels,
    'children', v_children,
    'parent', COALESCE(v_parent, 'null'::jsonb)
  );
END;
$function$;
