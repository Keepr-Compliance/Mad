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
$function$
