-- BACKLOG-4170 PR2a rollback: restores the 23 functions changed by 20261111110000 to the production
-- text and ACL read on 2026-11-09 (md5(prosrc), proacl, proconfig and provolatile identical on
-- production and keepr-test; bodies dumped from keepr-test where md5(prosrc) equals production).
--   public.support_agent_analytics(integer)                        04e8b2ac36c410123ffcaba2831a0dbd  PUBLIC, anon, authenticated, service_role
--   public.support_assign_ticket(uuid,uuid)                        cdc27dba988c5cd2e2e1e05361372e3c  authenticated, service_role
--   public.support_bulk_update_tickets(uuid[],text,uuid)           acdd7bf7ee40bc6ba872554438045906  PUBLIC, anon, authenticated, service_role
--   public.support_bulk_update_tickets(uuid[],text,uuid,text,uuid) b33cb66459a64d4f3074ead0abbdfb61  PUBLIC, anon, authenticated, service_role
--   public.support_bulk_update_tickets(uuid[],text,uuid,text,uuid,boolean) 51a032512a9aa2952b1e44b5de9f5514  PUBLIC, anon, authenticated, service_role
--   public.support_create_template(text,text,text)                 a9583ac82fb77119ab5c655602961f1a  PUBLIC, anon, authenticated, service_role
--   public.support_delete_template(uuid)                           e49a16a0652947c77e1a938ebf613f3f  authenticated, service_role
--   public.support_update_template(uuid,text,text,text,boolean)    faa1972e45968cabb372a7c19f083e26  authenticated, service_role
--   public.support_list_all_templates()                            9b7aab726245c7d79f4f51fc830f46a1  authenticated, service_role
--   public.support_list_templates()                                e0b516b7e4fa7f31d3069689bd3c8c34  authenticated, service_role
--   public.support_get_related_tickets(uuid)                       f07af0dc30c78077ec0f92aec548cc15  PUBLIC, anon, authenticated, service_role
--   public.support_get_ticket_stats()                              143268d8467069815725b63d46321c0f  authenticated, service_role
--   public.support_link_tickets(uuid,uuid,text)                    670b5c231766c25c08f138fb326b4068  PUBLIC, anon, authenticated, service_role
--   public.support_unlink_tickets(uuid,uuid)                       471f1d402dd9eccd4f13500d75d74fdd  PUBLIC, anon, authenticated, service_role
--   public.support_list_agents()                                   c43c764d2e8774598ca42178b6278494  PUBLIC, anon, authenticated, service_role
--   public.support_add_participant(uuid,text,text,text)            ab0ebdddf278d4cd42189c1108a9b424  PUBLIC, anon, authenticated, service_role
--   public.support_remove_participant(uuid)                        5bf202181373c0a7b5263b489bdc874e  PUBLIC, anon, authenticated, service_role
--   public.support_requester_recent_tickets(text)                  386d6f8045eb6cbdcaa745354851bac3  PUBLIC, anon, authenticated, service_role
--   public.support_search_requesters(text)                         3ede1502ca6eaa20350f3eb6ee2b4620  PUBLIC, anon, authenticated, service_role
--   public.support_search_tickets_for_link(text,uuid)              ff5ea5c11488dea9623d050de194a0eb  PUBLIC, anon, authenticated, service_role
--   public.support_update_ticket_category(uuid,uuid)               6d72b79f3ab18e4184ae5a6f1bebdc43  authenticated, service_role
--   public.support_update_ticket_priority(uuid,text)               e05219f24e3214566285f714ea4c575b  authenticated, service_role
--   public.support_update_ticket_status(uuid,text,text)            ca21d75b52989bb088da077908989bf3  authenticated, service_role
-- ACLs are rebuilt from empty in the production order, so proacl matches entry for entry.
-- Run only inside a transaction that is rolled back (harness), or with an explicit go for a real rollback.

CREATE OR REPLACE FUNCTION public.support_agent_analytics(p_period_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID := auth.uid();
  v_summary JSONB;
  v_agents JSONB;
  v_period_start TIMESTAMPTZ;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Support agent access required' USING ERRCODE = '42501';
  END IF;

  v_period_start := now() - (p_period_days || ' days')::INTERVAL;

  SELECT jsonb_build_object(
    'total_tickets', COUNT(*),
    'open_tickets', COUNT(*) FILTER (WHERE status NOT IN ('resolved', 'closed')),
    'resolved_tickets', COUNT(*) FILTER (WHERE status = 'resolved'),
    'closed_tickets', COUNT(*) FILTER (WHERE status = 'closed'),
    'avg_first_response_hours', ROUND(EXTRACT(EPOCH FROM AVG(first_response_at - created_at) FILTER (WHERE first_response_at IS NOT NULL)) / 3600, 1),
    'avg_resolution_hours', ROUND(EXTRACT(EPOCH FROM AVG(resolved_at - created_at) FILTER (WHERE resolved_at IS NOT NULL)) / 3600, 1),
    'tickets_created_in_period', COUNT(*) FILTER (WHERE created_at >= v_period_start),
    'tickets_resolved_in_period', COUNT(*) FILTER (WHERE resolved_at >= v_period_start)
  ) INTO v_summary
  FROM support_tickets;

  SELECT COALESCE(jsonb_agg(row_to_json(agent_stats)::JSONB), '[]'::JSONB)
  INTO v_agents
  FROM (
    SELECT
      st.assignee_id,
      u.email AS agent_email,
      COUNT(*) AS total_assigned,
      COUNT(*) FILTER (WHERE st.status NOT IN ('resolved', 'closed')) AS open_count,
      COUNT(*) FILTER (WHERE st.status IN ('resolved', 'closed')) AS resolved_count,
      ROUND(EXTRACT(EPOCH FROM AVG(st.first_response_at - st.created_at) FILTER (WHERE st.first_response_at IS NOT NULL)) / 3600, 1) AS avg_first_response_hours,
      ROUND(EXTRACT(EPOCH FROM AVG(st.resolved_at - st.created_at) FILTER (WHERE st.resolved_at IS NOT NULL)) / 3600, 1) AS avg_resolution_hours
    FROM support_tickets st
    JOIN auth.users u ON u.id = st.assignee_id
    WHERE st.assignee_id IS NOT NULL
    GROUP BY st.assignee_id, u.email
    ORDER BY total_assigned DESC
  ) agent_stats;

  RETURN jsonb_build_object(
    'summary', v_summary,
    'agents', v_agents,
    'period_days', p_period_days
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_assign_ticket(p_ticket_id uuid, p_assignee_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_assignee UUID;
  v_old_status TEXT;
  v_caller_id UUID := auth.uid();
BEGIN
  -- AUTH GUARD: Must be authenticated and exist in internal_roles
  IF v_caller_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM internal_roles WHERE user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Only authenticated agents can assign tickets';
  END IF;

  SELECT assignee_id, status INTO v_old_assignee, v_old_status
  FROM support_tickets
  WHERE id = p_ticket_id;

  IF v_old_status IS NULL THEN
    RAISE EXCEPTION 'Ticket not found: %', p_ticket_id;
  END IF;

  -- Update assignment
  UPDATE support_tickets
  SET
    assignee_id = p_assignee_id,
    status = CASE WHEN v_old_status = 'new' THEN 'assigned' ELSE status END
  WHERE id = p_ticket_id;

  -- Log assignment event
  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, new_value, metadata)
  VALUES (
    p_ticket_id,
    v_caller_id,
    'assigned',
    v_old_assignee::text,
    p_assignee_id::text,
    jsonb_build_object('auto_status_change', v_old_status = 'new')
  );

  -- If status changed from new to assigned, also log a status_changed event
  IF v_old_status = 'new' THEN
    INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, new_value)
    VALUES (p_ticket_id, v_caller_id, 'status_changed', 'new', 'assigned');
  END IF;

  RETURN jsonb_build_object(
    'id', p_ticket_id,
    'assignee_id', p_assignee_id,
    'status', CASE WHEN v_old_status = 'new' THEN 'assigned' ELSE v_old_status END
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_bulk_update_tickets(p_ticket_ids uuid[], p_status text DEFAULT NULL::text, p_assignee_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID := auth.uid();
  v_updated_count INT := 0;
  v_ticket_id UUID;
  v_valid_statuses TEXT[] := ARRAY['new', 'assigned', 'in_progress', 'pending', 'resolved', 'closed', 'deleted'];
BEGIN
  -- AUTH GUARD: Must be authenticated and exist in internal_roles
  IF v_caller_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM internal_roles WHERE user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Only authenticated agents can bulk update tickets';
  END IF;

  -- Validate status if provided
  IF p_status IS NOT NULL AND NOT (p_status = ANY(v_valid_statuses)) THEN
    RAISE EXCEPTION 'Invalid status: %. Must be one of: %', p_status, array_to_string(v_valid_statuses, ', ');
  END IF;

  -- Validate ticket IDs array is not empty
  IF array_length(p_ticket_ids, 1) IS NULL OR array_length(p_ticket_ids, 1) = 0 THEN
    RAISE EXCEPTION 'At least one ticket ID is required';
  END IF;

  -- Update status if provided
  IF p_status IS NOT NULL THEN
    UPDATE support_tickets
    SET
      status = p_status,
      resolved_at = CASE WHEN p_status = 'resolved' THEN now() ELSE resolved_at END,
      closed_at = CASE WHEN p_status = 'closed' THEN now() ELSE closed_at END,
      pending_reason = CASE WHEN p_status != 'pending' THEN NULL ELSE pending_reason END
    WHERE id = ANY(p_ticket_ids);

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;

    -- Log events for each ticket
    INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, new_value, metadata)
    SELECT
      t.id,
      v_caller_id,
      'status_changed',
      t.status,
      p_status,
      jsonb_build_object('bulk_action', true)
    FROM support_tickets t
    WHERE t.id = ANY(p_ticket_ids);
  END IF;

  -- Update assignee if provided
  IF p_assignee_id IS NOT NULL THEN
    UPDATE support_tickets
    SET
      assignee_id = p_assignee_id,
      status = CASE
        WHEN status = 'new' THEN 'assigned'
        ELSE status
      END
    WHERE id = ANY(p_ticket_ids);

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;

    -- Log assignment events
    INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, new_value, metadata)
    SELECT
      t.id,
      v_caller_id,
      'assigned',
      t.assignee_id::text,
      p_assignee_id::text,
      jsonb_build_object('bulk_action', true)
    FROM support_tickets t
    WHERE t.id = ANY(p_ticket_ids);
  END IF;

  RETURN jsonb_build_object(
    'updated_count', v_updated_count,
    'ticket_ids', to_jsonb(p_ticket_ids)
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_bulk_update_tickets(p_ticket_ids uuid[], p_status text DEFAULT NULL::text, p_assignee_id uuid DEFAULT NULL::uuid, p_priority text DEFAULT NULL::text, p_category_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID := auth.uid();
  v_updated_count INT := 0;
  v_valid_statuses TEXT[] := ARRAY['new', 'assigned', 'in_progress', 'pending', 'resolved', 'closed', 'deleted'];
  v_valid_priorities TEXT[] := ARRAY['low', 'normal', 'high', 'urgent'];
BEGIN
  -- AUTH GUARD
  IF v_caller_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM internal_roles WHERE user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Only authenticated agents can bulk update tickets';
  END IF;

  IF p_status IS NOT NULL AND NOT (p_status = ANY(v_valid_statuses)) THEN
    RAISE EXCEPTION 'Invalid status: %', p_status;
  END IF;

  IF p_priority IS NOT NULL AND NOT (p_priority = ANY(v_valid_priorities)) THEN
    RAISE EXCEPTION 'Invalid priority: %', p_priority;
  END IF;

  IF p_category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM support_categories WHERE id = p_category_id
  ) THEN
    RAISE EXCEPTION 'Invalid category_id: %', p_category_id;
  END IF;

  IF array_length(p_ticket_ids, 1) IS NULL OR array_length(p_ticket_ids, 1) = 0 THEN
    RAISE EXCEPTION 'At least one ticket ID is required';
  END IF;

  -- Update status
  IF p_status IS NOT NULL THEN
    UPDATE support_tickets
    SET
      status = p_status,
      resolved_at = CASE WHEN p_status = 'resolved' THEN now() ELSE resolved_at END,
      closed_at = CASE WHEN p_status = 'closed' THEN now() ELSE closed_at END,
      pending_reason = CASE WHEN p_status != 'pending' THEN NULL ELSE pending_reason END,
      updated_at = now()
    WHERE id = ANY(p_ticket_ids);
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;

    INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, new_value, metadata)
    SELECT t.id, v_caller_id, 'status_changed', t.status, p_status,
      jsonb_build_object('bulk_action', true)
    FROM support_tickets t WHERE t.id = ANY(p_ticket_ids);
  END IF;

  -- Update assignee
  IF p_assignee_id IS NOT NULL THEN
    UPDATE support_tickets
    SET
      assignee_id = p_assignee_id,
      status = CASE WHEN status = 'new' THEN 'assigned' ELSE status END,
      updated_at = now()
    WHERE id = ANY(p_ticket_ids);
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;

    INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, new_value, metadata)
    SELECT t.id, v_caller_id, 'assigned', t.assignee_id::text, p_assignee_id::text,
      jsonb_build_object('bulk_action', true)
    FROM support_tickets t WHERE t.id = ANY(p_ticket_ids);
  END IF;

  -- Update priority
  IF p_priority IS NOT NULL THEN
    UPDATE support_tickets
    SET priority = p_priority, updated_at = now()
    WHERE id = ANY(p_ticket_ids);
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;

    INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, new_value, metadata)
    SELECT t.id, v_caller_id, 'priority_changed', t.priority, p_priority,
      jsonb_build_object('bulk_action', true)
    FROM support_tickets t WHERE t.id = ANY(p_ticket_ids);
  END IF;

  -- Update category
  IF p_category_id IS NOT NULL THEN
    UPDATE support_tickets
    SET category_id = p_category_id, updated_at = now()
    WHERE id = ANY(p_ticket_ids);
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;

    INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, new_value, metadata)
    SELECT t.id, v_caller_id, 'category_changed', t.category_id::text, p_category_id::text,
      jsonb_build_object('bulk_action', true)
    FROM support_tickets t WHERE t.id = ANY(p_ticket_ids);
  END IF;

  RETURN jsonb_build_object(
    'updated_count', v_updated_count,
    'ticket_ids', to_jsonb(p_ticket_ids)
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_bulk_update_tickets(p_ticket_ids uuid[], p_status text DEFAULT NULL::text, p_assignee_id uuid DEFAULT NULL::uuid, p_priority text DEFAULT NULL::text, p_category_id uuid DEFAULT NULL::uuid, p_unassign boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID := auth.uid();
  v_updated_count INT := 0;
  v_valid_statuses TEXT[] := ARRAY['new', 'assigned', 'in_progress', 'pending', 'resolved', 'closed', 'deleted'];
  v_valid_priorities TEXT[] := ARRAY['low', 'normal', 'high', 'urgent'];
BEGIN
  IF v_caller_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM internal_roles WHERE user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Only authenticated agents can bulk update tickets';
  END IF;

  IF p_status IS NOT NULL AND NOT (p_status = ANY(v_valid_statuses)) THEN
    RAISE EXCEPTION 'Invalid status: %', p_status;
  END IF;

  IF p_priority IS NOT NULL AND NOT (p_priority = ANY(v_valid_priorities)) THEN
    RAISE EXCEPTION 'Invalid priority: %', p_priority;
  END IF;

  IF p_category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM support_categories WHERE id = p_category_id
  ) THEN
    RAISE EXCEPTION 'Invalid category_id: %', p_category_id;
  END IF;

  IF array_length(p_ticket_ids, 1) IS NULL OR array_length(p_ticket_ids, 1) = 0 THEN
    RAISE EXCEPTION 'At least one ticket ID is required';
  END IF;

  -- Status
  IF p_status IS NOT NULL THEN
    UPDATE support_tickets SET
      status = p_status,
      resolved_at = CASE WHEN p_status = 'resolved' THEN now() ELSE resolved_at END,
      closed_at = CASE WHEN p_status = 'closed' THEN now() ELSE closed_at END,
      pending_reason = CASE WHEN p_status != 'pending' THEN NULL ELSE pending_reason END,
      updated_at = now()
    WHERE id = ANY(p_ticket_ids);
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, new_value, metadata)
    SELECT t.id, v_caller_id, 'status_changed', t.status, p_status, jsonb_build_object('bulk_action', true)
    FROM support_tickets t WHERE t.id = ANY(p_ticket_ids);
  END IF;

  -- Unassign
  IF p_unassign THEN
    UPDATE support_tickets SET assignee_id = NULL, updated_at = now()
    WHERE id = ANY(p_ticket_ids);
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, new_value, metadata)
    SELECT t.id, v_caller_id, 'unassigned', t.assignee_id::text, NULL, jsonb_build_object('bulk_action', true)
    FROM support_tickets t WHERE t.id = ANY(p_ticket_ids);
  -- Assign
  ELSIF p_assignee_id IS NOT NULL THEN
    UPDATE support_tickets SET
      assignee_id = p_assignee_id,
      status = CASE WHEN status = 'new' THEN 'assigned' ELSE status END,
      updated_at = now()
    WHERE id = ANY(p_ticket_ids);
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, new_value, metadata)
    SELECT t.id, v_caller_id, 'assigned', t.assignee_id::text, p_assignee_id::text, jsonb_build_object('bulk_action', true)
    FROM support_tickets t WHERE t.id = ANY(p_ticket_ids);
  END IF;

  -- Priority
  IF p_priority IS NOT NULL THEN
    UPDATE support_tickets SET priority = p_priority, updated_at = now()
    WHERE id = ANY(p_ticket_ids);
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, new_value, metadata)
    SELECT t.id, v_caller_id, 'priority_changed', t.priority, p_priority, jsonb_build_object('bulk_action', true)
    FROM support_tickets t WHERE t.id = ANY(p_ticket_ids);
  END IF;

  -- Category
  IF p_category_id IS NOT NULL THEN
    UPDATE support_tickets SET category_id = p_category_id, updated_at = now()
    WHERE id = ANY(p_ticket_ids);
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, new_value, metadata)
    SELECT t.id, v_caller_id, 'category_changed', t.category_id::text, p_category_id::text, jsonb_build_object('bulk_action', true)
    FROM support_tickets t WHERE t.id = ANY(p_ticket_ids);
  END IF;

  RETURN jsonb_build_object('updated_count', v_updated_count, 'ticket_ids', to_jsonb(p_ticket_ids));
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_create_template(p_name text, p_body text, p_category text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id UUID;
  v_caller_id UUID := auth.uid();
BEGIN
  -- AUTH GUARD: Must be authenticated and exist in internal_roles (BACKLOG-1955)
  IF v_caller_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM internal_roles WHERE user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Only authenticated agents can create templates' USING ERRCODE = '42501';
  END IF;

  INSERT INTO support_response_templates (name, body, category, created_by, updated_by)
  VALUES (p_name, p_body, p_category, auth.uid(), auth.uid())
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'name', p_name);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_delete_template(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID := auth.uid();
BEGIN
  IF v_caller_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM internal_roles WHERE user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Only authenticated agents can delete templates' USING ERRCODE = '42501';
  END IF;

  DELETE FROM support_response_templates WHERE id = p_id;

  RETURN jsonb_build_object('id', p_id, 'deleted', true);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_update_template(p_id uuid, p_name text, p_body text, p_category text DEFAULT NULL::text, p_is_active boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Support agent access required' USING ERRCODE = '42501';
  END IF;

  UPDATE support_response_templates
  SET name = p_name, body = p_body, category = p_category, 
      is_active = p_is_active, updated_by = auth.uid(), updated_at = now()
  WHERE id = p_id;

  RETURN jsonb_build_object('id', p_id, 'updated', true);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_list_all_templates()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Support agent access required' USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', t.id,
        'name', t.name,
        'body', t.body,
        'category', t.category,
        'is_active', t.is_active,
        'created_by', t.created_by,
        'created_at', t.created_at,
        'updated_at', t.updated_at
      ) ORDER BY t.name
    )
    FROM support_response_templates t
  ), '[]'::jsonb);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_list_templates()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Support agent access required' USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', t.id,
        'name', t.name,
        'body', t.body,
        'category', t.category,
        'is_active', t.is_active,
        'created_by', t.created_by,
        'created_at', t.created_at,
        'updated_at', t.updated_at
      ) ORDER BY t.name
    )
    FROM support_response_templates t
    WHERE t.is_active = true
  ), '[]'::jsonb);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_get_related_tickets(p_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_requester_email TEXT;
  v_auto_related JSONB;
  v_manual_links JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Support agent access required' USING ERRCODE = '42501';
  END IF;

  SELECT requester_email INTO v_requester_email
  FROM support_tickets WHERE id = p_ticket_id;

  IF v_requester_email IS NULL THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(t)::JSONB ORDER BY t.created_at DESC), '[]'::JSONB)
  INTO v_auto_related
  FROM (
    SELECT st.id, st.ticket_number, st.subject, st.status, st.priority, st.created_at,
           'auto'::TEXT AS link_source
    FROM support_tickets st
    WHERE st.requester_email = v_requester_email
      AND st.id != p_ticket_id
    ORDER BY st.created_at DESC
    LIMIT 5
  ) t;

  SELECT COALESCE(jsonb_agg(row_to_json(t)::JSONB ORDER BY t.created_at DESC), '[]'::JSONB)
  INTO v_manual_links
  FROM (
    SELECT st.id, st.ticket_number, st.subject, st.status, st.priority, st.created_at,
           stl.link_type, 'manual'::TEXT AS link_source, stl.id AS link_id
    FROM support_ticket_links stl
    JOIN support_tickets st ON st.id = CASE
      WHEN stl.ticket_id = p_ticket_id THEN stl.linked_ticket_id
      ELSE stl.ticket_id
    END
    WHERE stl.ticket_id = p_ticket_id OR stl.linked_ticket_id = p_ticket_id
    ORDER BY st.created_at DESC
  ) t;

  RETURN jsonb_build_object(
    'auto_related', v_auto_related,
    'manual_links', v_manual_links
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_get_ticket_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_by_status JSONB;
  v_by_priority JSONB;
  v_total INT;
  v_unassigned INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Support agent access required' USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(*) INTO v_total FROM support_tickets WHERE status NOT IN ('closed');
  SELECT COUNT(*) INTO v_unassigned FROM support_tickets WHERE assignee_id IS NULL AND status NOT IN ('resolved', 'closed');

  SELECT COALESCE(jsonb_object_agg(status, cnt), '{}'::jsonb) INTO v_by_status
  FROM (SELECT status, COUNT(*) as cnt FROM support_tickets GROUP BY status) s;

  SELECT COALESCE(jsonb_object_agg(priority, cnt), '{}'::jsonb) INTO v_by_priority
  FROM (SELECT priority, COUNT(*) as cnt FROM support_tickets WHERE status NOT IN ('closed') GROUP BY priority) p;

  RETURN jsonb_build_object(
    'total_open', v_total,
    'unassigned', v_unassigned,
    'by_status', v_by_status,
    'by_priority', v_by_priority
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_link_tickets(p_ticket_id uuid, p_linked_ticket_id uuid, p_link_type text DEFAULT 'related'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID;
  v_link_id UUID;
  v_ticket_number INTEGER;
  v_linked_number INTEGER;
BEGIN
  v_caller_id := auth.uid();
  -- AUTH GUARD: Must be authenticated and exist in internal_roles (BACKLOG-1955)
  IF v_caller_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM internal_roles WHERE user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Only authenticated agents can link tickets' USING ERRCODE = '42501';
  END IF;

  SELECT ticket_number INTO v_ticket_number FROM support_tickets WHERE id = p_ticket_id;
  SELECT ticket_number INTO v_linked_number FROM support_tickets WHERE id = p_linked_ticket_id;

  IF v_ticket_number IS NULL OR v_linked_number IS NULL THEN
    RAISE EXCEPTION 'One or both tickets not found';
  END IF;

  INSERT INTO support_ticket_links (ticket_id, linked_ticket_id, link_type, linked_by)
  VALUES (p_ticket_id, p_linked_ticket_id, p_link_type, v_caller_id)
  RETURNING id INTO v_link_id;

  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, new_value)
  VALUES (p_ticket_id, v_caller_id, 'ticket_linked', '#' || v_linked_number || ' (' || p_link_type || ')');

  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, new_value)
  VALUES (p_linked_ticket_id, v_caller_id, 'ticket_linked', '#' || v_ticket_number || ' (' || p_link_type || ')');

  RETURN jsonb_build_object('link_id', v_link_id, 'linked', true);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_unlink_tickets(p_ticket_id uuid, p_linked_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID;
  v_ticket_number INTEGER;
  v_linked_number INTEGER;
BEGIN
  v_caller_id := auth.uid();
  -- AUTH GUARD: Must be authenticated and exist in internal_roles (BACKLOG-1955)
  IF v_caller_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM internal_roles WHERE user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Only authenticated agents can unlink tickets' USING ERRCODE = '42501';
  END IF;

  SELECT ticket_number INTO v_ticket_number FROM support_tickets WHERE id = p_ticket_id;
  SELECT ticket_number INTO v_linked_number FROM support_tickets WHERE id = p_linked_ticket_id;

  DELETE FROM support_ticket_links
  WHERE (ticket_id = p_ticket_id AND linked_ticket_id = p_linked_ticket_id)
     OR (ticket_id = p_linked_ticket_id AND linked_ticket_id = p_ticket_id);

  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value)
  VALUES (p_ticket_id, v_caller_id, 'ticket_unlinked', '#' || v_linked_number);

  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value)
  VALUES (p_linked_ticket_id, v_caller_id, 'ticket_unlinked', '#' || v_ticket_number);

  RETURN jsonb_build_object('unlinked', true);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_list_agents()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only allow internal users to call this
  IF NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Access denied: only internal users can list agents';
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'user_id', ir.user_id,
        'email', u.email,
        'display_name', COALESCE(u.display_name, u.email),
        'role_name', ar.name
      ) ORDER BY COALESCE(u.display_name, u.email)
    ), '[]'::jsonb)
    FROM internal_roles ir
    JOIN users u ON u.id = ir.user_id
    JOIN admin_roles ar ON ar.id = ir.role_id
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_add_participant(p_ticket_id uuid, p_email text, p_name text DEFAULT NULL::text, p_role text DEFAULT 'cc'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_participant_id uuid;
  v_adder_id uuid;
  v_user_id uuid;
BEGIN
  v_adder_id := auth.uid();

  -- Check if caller is an agent
  IF NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_adder_id) THEN
    RAISE EXCEPTION 'Only agents can add participants';
  END IF;

  -- Check if participant already exists on this ticket
  IF EXISTS (
    SELECT 1 FROM support_ticket_participants
    WHERE ticket_id = p_ticket_id AND email = p_email
  ) THEN
    RAISE EXCEPTION 'Participant already exists on this ticket';
  END IF;

  -- Try to find user_id by email
  SELECT id INTO v_user_id FROM auth.users WHERE email = p_email LIMIT 1;

  INSERT INTO support_ticket_participants (
    ticket_id, user_id, email, name, role, added_by
  ) VALUES (
    p_ticket_id, v_user_id, p_email, p_name, p_role::text, v_adder_id
  )
  RETURNING id INTO v_participant_id;

  RETURN jsonb_build_object('id', v_participant_id, 'email', p_email, 'role', p_role);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_remove_participant(p_participant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id uuid;
BEGIN
  v_caller_id := auth.uid();

  -- Check if caller is an agent
  IF NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Only agents can remove participants';
  END IF;

  DELETE FROM support_ticket_participants WHERE id = p_participant_id;

  RETURN jsonb_build_object('removed', true, 'id', p_participant_id);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_requester_recent_tickets(p_email text)
 RETURNS TABLE(id uuid, ticket_number integer, subject text, status text, priority text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Support agent access required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT st.id, st.ticket_number, st.subject, st.status, st.priority, st.created_at
  FROM support_tickets st
  WHERE st.requester_email = p_email
  ORDER BY st.created_at DESC
  LIMIT 5;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_search_requesters(p_query text)
 RETURNS TABLE(user_id uuid, email text, name text, phone text, organization_id uuid, organization_name text, open_ticket_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Support agent access required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    u.id,
    u.email::TEXT,
    COALESCE(p.display_name, u.raw_user_meta_data->>'full_name', u.email)::TEXT AS name,
    (SELECT st.requester_phone FROM support_tickets st
     WHERE st.requester_email = u.email AND st.requester_phone IS NOT NULL
     ORDER BY st.created_at DESC LIMIT 1)::TEXT AS phone,
    om.organization_id,
    o.name::TEXT AS organization_name,
    (SELECT COUNT(*) FROM support_tickets st
     WHERE st.requester_email = u.email
     AND st.status NOT IN ('resolved', 'closed')) AS open_ticket_count
  FROM auth.users u
  LEFT JOIN profiles p ON p.id = u.id
  LEFT JOIN organization_members om ON om.user_id = u.id
  LEFT JOIN organizations o ON o.id = om.organization_id
  WHERE
    u.email ILIKE '%' || p_query || '%'
    OR COALESCE(p.display_name, u.raw_user_meta_data->>'full_name', '') ILIKE '%' || p_query || '%'
    OR COALESCE(o.name, '') ILIKE '%' || p_query || '%'
  ORDER BY
    CASE WHEN u.email ILIKE p_query || '%' THEN 0 ELSE 1 END,
    COALESCE(p.display_name, u.raw_user_meta_data->>'full_name', u.email)
  LIMIT 10;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_search_tickets_for_link(p_query text, p_exclude_ticket_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, ticket_number integer, subject text, status text, requester_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Support agent access required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT st.id, st.ticket_number, st.subject, st.status, st.requester_name
  FROM support_tickets st
  WHERE (
    st.ticket_number::TEXT = p_query
    OR st.subject ILIKE '%' || p_query || '%'
  )
  AND (p_exclude_ticket_id IS NULL OR st.id != p_exclude_ticket_id)
  ORDER BY st.ticket_number DESC
  LIMIT 10;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_update_ticket_category(p_ticket_id uuid, p_category_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_category_id UUID;
  v_old_category_name TEXT;
  v_new_category_name TEXT;
  v_caller_id UUID := auth.uid();
BEGIN
  -- AUTH GUARD: Must be authenticated agent
  IF v_caller_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM internal_roles WHERE user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Only authenticated agents can update ticket category';
  END IF;

  -- Validate category exists (if not NULL / uncategorized)
  IF p_category_id IS NOT NULL THEN
    SELECT name INTO v_new_category_name
    FROM support_categories
    WHERE id = p_category_id AND is_active = true;

    IF v_new_category_name IS NULL THEN
      RAISE EXCEPTION 'Category not found or inactive: %', p_category_id;
    END IF;
  END IF;

  -- Get current category
  SELECT category_id INTO v_old_category_id
  FROM support_tickets
  WHERE id = p_ticket_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found: %', p_ticket_id;
  END IF;

  -- Resolve old category name for event log
  IF v_old_category_id IS NOT NULL THEN
    SELECT name INTO v_old_category_name
    FROM support_categories
    WHERE id = v_old_category_id;
  ELSE
    v_old_category_name := 'Uncategorized';
  END IF;

  -- Resolve new category name for event log
  IF p_category_id IS NULL THEN
    v_new_category_name := 'Uncategorized';
  END IF;

  -- No-op if same
  IF v_old_category_id IS NOT DISTINCT FROM p_category_id THEN
    RETURN jsonb_build_object(
      'id', p_ticket_id,
      'category_id', v_old_category_id,
      'changed', false
    );
  END IF;

  -- Update
  UPDATE support_tickets
  SET category_id = p_category_id
  WHERE id = p_ticket_id;

  -- Log event
  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, new_value)
  VALUES (p_ticket_id, v_caller_id, 'category_changed', v_old_category_name, v_new_category_name);

  RETURN jsonb_build_object(
    'id', p_ticket_id,
    'category_id', p_category_id,
    'changed', true
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_update_ticket_priority(p_ticket_id uuid, p_new_priority text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_priority TEXT;
  v_caller_id UUID := auth.uid();
BEGIN
  -- AUTH GUARD: Must be authenticated agent
  IF v_caller_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM internal_roles WHERE user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Only authenticated agents can update ticket priority';
  END IF;

  -- Validate priority value
  IF p_new_priority NOT IN ('low', 'normal', 'high', 'urgent') THEN
    RAISE EXCEPTION 'Invalid priority: %. Must be low, normal, high, or urgent', p_new_priority;
  END IF;

  -- Get current priority
  SELECT priority INTO v_old_priority
  FROM support_tickets
  WHERE id = p_ticket_id;

  IF v_old_priority IS NULL THEN
    RAISE EXCEPTION 'Ticket not found: %', p_ticket_id;
  END IF;

  -- No-op if same
  IF v_old_priority = p_new_priority THEN
    RETURN jsonb_build_object('id', p_ticket_id, 'priority', v_old_priority, 'changed', false);
  END IF;

  -- Update
  UPDATE support_tickets SET priority = p_new_priority WHERE id = p_ticket_id;

  -- Log event
  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, new_value)
  VALUES (p_ticket_id, v_caller_id, 'priority_changed', v_old_priority, p_new_priority);

  RETURN jsonb_build_object('id', p_ticket_id, 'priority', p_new_priority, 'changed', true);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.support_update_ticket_status(p_ticket_id uuid, p_new_status text, p_pending_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_status TEXT;
  v_transition_allowed BOOLEAN;
  v_caller_id UUID := auth.uid();
BEGIN
  -- AUTH GUARD: Must be authenticated and exist in internal_roles
  IF v_caller_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM internal_roles WHERE user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Only authenticated agents can update ticket status';
  END IF;

  -- Get current status
  SELECT status INTO v_old_status
  FROM support_tickets
  WHERE id = p_ticket_id;

  IF v_old_status IS NULL THEN
    RAISE EXCEPTION 'Ticket not found: %', p_ticket_id;
  END IF;

  -- Same status is a no-op
  IF v_old_status = p_new_status THEN
    RETURN jsonb_build_object('id', p_ticket_id, 'status', v_old_status, 'changed', false);
  END IF;

  -- Check allowed transitions
  v_transition_allowed := CASE
    WHEN v_old_status = 'new' AND p_new_status IN ('assigned', 'in_progress') THEN true
    WHEN v_old_status = 'assigned' AND p_new_status IN ('in_progress', 'pending') THEN true
    WHEN v_old_status = 'in_progress' AND p_new_status IN ('pending', 'resolved') THEN true
    WHEN v_old_status = 'pending' AND p_new_status = 'in_progress' THEN true
    WHEN v_old_status = 'resolved' AND p_new_status IN ('in_progress', 'closed') THEN true
    WHEN v_old_status = 'closed' AND p_new_status = 'in_progress' THEN true
    ELSE false
  END;

  IF NOT v_transition_allowed THEN
    RAISE EXCEPTION 'Invalid status transition from % to %', v_old_status, p_new_status;
  END IF;

  -- For closed -> in_progress, require support.admin permission
  IF v_old_status = 'closed' AND p_new_status = 'in_progress' THEN
    IF NOT EXISTS (
      SELECT 1 FROM internal_roles ir
      JOIN admin_role_permissions arp ON arp.role_id = ir.role_id
      JOIN admin_permissions ap ON ap.id = arp.permission_id
      WHERE ir.user_id = v_caller_id AND ap.key = 'support.admin'
    ) THEN
      RAISE EXCEPTION 'Only users with support.admin permission can reopen closed tickets';
    END IF;
  END IF;

  -- Validate pending_reason when transitioning to pending
  IF p_new_status = 'pending' THEN
    IF p_pending_reason IS NULL OR p_pending_reason NOT IN ('customer', 'vendor', 'internal') THEN
      RAISE EXCEPTION 'pending_reason is required when setting status to pending. Must be customer, vendor, or internal';
    END IF;
  END IF;

  -- Update the ticket
  UPDATE support_tickets
  SET
    status = p_new_status,
    pending_reason = CASE WHEN p_new_status = 'pending' THEN p_pending_reason ELSE NULL END,
    resolved_at = CASE WHEN p_new_status = 'resolved' THEN now() ELSE resolved_at END,
    closed_at = CASE WHEN p_new_status = 'closed' THEN now() ELSE closed_at END,
    reopened_count = CASE WHEN p_new_status = 'in_progress' AND v_old_status IN ('resolved', 'closed') THEN reopened_count + 1 ELSE reopened_count END
  WHERE id = p_ticket_id;

  -- Log event
  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, new_value, metadata)
  VALUES (
    p_ticket_id,
    v_caller_id,
    'status_changed',
    v_old_status,
    p_new_status,
    CASE WHEN p_new_status = 'pending'
      THEN jsonb_build_object('pending_reason', p_pending_reason)
      ELSE NULL
    END
  );

  RETURN jsonb_build_object('id', p_ticket_id, 'status', p_new_status, 'changed', true);
END;
$function$
;

DO $acl$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['public.support_agent_analytics(integer)',
                           'public.support_bulk_update_tickets(uuid[],text,uuid)',
                           'public.support_bulk_update_tickets(uuid[],text,uuid,text,uuid)',
                           'public.support_bulk_update_tickets(uuid[],text,uuid,text,uuid,boolean)',
                           'public.support_create_template(text,text,text)',
                           'public.support_get_related_tickets(uuid)',
                           'public.support_link_tickets(uuid,uuid,text)',
                           'public.support_unlink_tickets(uuid,uuid)',
                           'public.support_list_agents()',
                           'public.support_add_participant(uuid,text,text,text)',
                           'public.support_remove_participant(uuid)',
                           'public.support_requester_recent_tickets(text)',
                           'public.support_search_requesters(text)',
                           'public.support_search_tickets_for_link(text,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, postgres, anon, authenticated, service_role', s::regprocedure);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', s::regprocedure);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres', s::regprocedure);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon', s::regprocedure);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', s::regprocedure);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', s::regprocedure);
  END LOOP;
  FOREACH s IN ARRAY ARRAY['public.support_assign_ticket(uuid,uuid)',
                           'public.support_delete_template(uuid)',
                           'public.support_update_template(uuid,text,text,text,boolean)',
                           'public.support_list_all_templates()',
                           'public.support_list_templates()',
                           'public.support_get_ticket_stats()',
                           'public.support_update_ticket_category(uuid,uuid)',
                           'public.support_update_ticket_priority(uuid,text)',
                           'public.support_update_ticket_status(uuid,text,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, postgres, anon, authenticated, service_role', s::regprocedure);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres', s::regprocedure);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', s::regprocedure);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', s::regprocedure);
  END LOOP;
END
$acl$;
