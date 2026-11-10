-- BACKLOG-4170 PR2a — 23 support-agent functions read per permission (group D)
--
-- Each function below admitted any caller holding an internal role. Each now also requires the
-- support permission the admin-portal support pages already require (route /dashboard/support needs
-- support.view). The internal-role check is kept verbatim and the permission is ORed onto the
-- refusal condition (IF NOT <internal> OR NOT <permission> THEN <refusal>), so a caller must pass
-- both. Each refusal is unchanged (same RAISE text and SQLSTATE), so no caller changes. Only the guard
-- IF line changes; every other line of each body is the production text.
--
--   support.view                         19 signatures (every function not listed below), including
--                                        support_list_templates (the reply composer's template picker)
--   support.manage or support.admin      support_create_template(text, text, text)
--                                        support_update_template(uuid, text, text, text, boolean)
--                                        support_delete_template(uuid)
--                                        support_list_all_templates()
--                                        (the same key set as the support_templates_manage table policy)
--
-- has_permission / has_any_permission are caller-bound (check_user_id = auth.uid()) SECURITY DEFINER
-- EXISTS queries and never return NULL; a NULL caller id makes them false, so the IF still refuses.
--
-- Grants: EXECUTE revoked from PUBLIC and anon on the 14 signatures that held it; the other 9 never
-- did. Granted to authenticated and service_role on all 23 (both held it). No function here is meant
-- to be callable signed out.
--
-- Pre-pin: the migration stops unless each body is the production text or this file's text.
-- Rollback: supabase/tests/backlog-4170-p2a/rollback-4170-p2a.sql (production text and ACL).

DO $pin$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT v.sig, v.prod, v.post, md5(p.prosrc) AS cur
      FROM (VALUES
        ('public.support_agent_analytics(integer)', '04e8b2ac36c410123ffcaba2831a0dbd', '18abe4fd25bbfd56d4138b424041f987'),
        ('public.support_assign_ticket(uuid,uuid)', 'cdc27dba988c5cd2e2e1e05361372e3c', 'c30a516fb95a22f71ba1bdfc094a12e9'),
        ('public.support_bulk_update_tickets(uuid[],text,uuid)', 'acdd7bf7ee40bc6ba872554438045906', '31fd7004f95c8ab28622ecc2d048589c'),
        ('public.support_bulk_update_tickets(uuid[],text,uuid,text,uuid)', 'b33cb66459a64d4f3074ead0abbdfb61', '83b9bd18035e342f8825fd0fce11328c'),
        ('public.support_bulk_update_tickets(uuid[],text,uuid,text,uuid,boolean)', '51a032512a9aa2952b1e44b5de9f5514', '244263a960e0110fb18af78108c7eec4'),
        ('public.support_create_template(text,text,text)', 'a9583ac82fb77119ab5c655602961f1a', '8ada3005bc8ddd738376f6069c944556'),
        ('public.support_delete_template(uuid)', 'e49a16a0652947c77e1a938ebf613f3f', '0cb0fc431406a837c4e1be706813e750'),
        ('public.support_update_template(uuid,text,text,text,boolean)', 'faa1972e45968cabb372a7c19f083e26', '90555dd611cdf36ae06d52ce83b3aa32'),
        ('public.support_list_all_templates()', '9b7aab726245c7d79f4f51fc830f46a1', '0c8984ec590a48c3e9ce41c43a027e16'),
        ('public.support_list_templates()', 'e0b516b7e4fa7f31d3069689bd3c8c34', '7f7806abab505a3a7cb798b45f62fd7f'),
        ('public.support_get_related_tickets(uuid)', 'f07af0dc30c78077ec0f92aec548cc15', '1829c1423857e3548a3828ec6114e70b'),
        ('public.support_get_ticket_stats()', '143268d8467069815725b63d46321c0f', '7eefb879c71d3f2d3f809417f1ab5ffc'),
        ('public.support_link_tickets(uuid,uuid,text)', '670b5c231766c25c08f138fb326b4068', 'a08829b6b19d5ba34b3c91790a6734ce'),
        ('public.support_unlink_tickets(uuid,uuid)', '471f1d402dd9eccd4f13500d75d74fdd', '89c1472d01a8da65661eb2a136143728'),
        ('public.support_list_agents()', 'c43c764d2e8774598ca42178b6278494', 'd437bec2c5b791796aa8101da8ab82dc'),
        ('public.support_add_participant(uuid,text,text,text)', 'ab0ebdddf278d4cd42189c1108a9b424', 'ee07cfcd6213395faf0eda77c896d904'),
        ('public.support_remove_participant(uuid)', '5bf202181373c0a7b5263b489bdc874e', 'da84180d65d465cd48e62ead1d1dd324'),
        ('public.support_requester_recent_tickets(text)', '386d6f8045eb6cbdcaa745354851bac3', '5020c5e27cf4657622b37b72c298df4d'),
        ('public.support_search_requesters(text)', '3ede1502ca6eaa20350f3eb6ee2b4620', 'c714b28d1dfd9d7c1baaabd8af2e9f77'),
        ('public.support_search_tickets_for_link(text,uuid)', 'ff5ea5c11488dea9623d050de194a0eb', 'd65d34da1f77e2429e61b878b6db7294'),
        ('public.support_update_ticket_category(uuid,uuid)', '6d72b79f3ab18e4184ae5a6f1bebdc43', '903c220241bf1a91ac0e1aa48fba32fd'),
        ('public.support_update_ticket_priority(uuid,text)', 'e05219f24e3214566285f714ea4c575b', '3fbf0e72a6010a207c5dd249674becd3'),
        ('public.support_update_ticket_status(uuid,text,text)', 'ca21d75b52989bb088da077908989bf3', 'c960e205a9b5245686e0b52615c1c72f')
      ) AS v(sig, prod, post)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(v.sig)
  LOOP
    IF r.cur IS NULL THEN
      RAISE EXCEPTION 'BACKLOG-4170 PR2a: % not found', r.sig;
    END IF;
    IF r.cur NOT IN (r.prod, r.post) THEN
      RAISE EXCEPTION 'BACKLOG-4170 PR2a: % body changed (md5 %); re-review before applying', r.sig, r.cur;
    END IF;
  END LOOP;
END
$pin$;

-- support.view
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

  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) OR NOT public.has_permission(auth.uid(), 'support.view') THEN
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
$function$;

-- support.view
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
  ) OR NOT public.has_permission(v_caller_id, 'support.view') THEN
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
$function$;

-- support.view
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
  ) OR NOT public.has_permission(v_caller_id, 'support.view') THEN
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
$function$;

-- support.view
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
  ) OR NOT public.has_permission(v_caller_id, 'support.view') THEN
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
$function$;

-- support.view
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
  ) OR NOT public.has_permission(v_caller_id, 'support.view') THEN
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
$function$;

-- support.manage | support.admin
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
  ) OR NOT public.has_any_permission(v_caller_id, ARRAY['support.manage', 'support.admin']) THEN
    RAISE EXCEPTION 'Only authenticated agents can create templates' USING ERRCODE = '42501';
  END IF;

  INSERT INTO support_response_templates (name, body, category, created_by, updated_by)
  VALUES (p_name, p_body, p_category, auth.uid(), auth.uid())
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'name', p_name);
END;
$function$;

-- support.manage | support.admin
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
  ) OR NOT public.has_any_permission(v_caller_id, ARRAY['support.manage', 'support.admin']) THEN
    RAISE EXCEPTION 'Only authenticated agents can delete templates' USING ERRCODE = '42501';
  END IF;

  DELETE FROM support_response_templates WHERE id = p_id;

  RETURN jsonb_build_object('id', p_id, 'deleted', true);
END;
$function$;

-- support.manage | support.admin
CREATE OR REPLACE FUNCTION public.support_update_template(p_id uuid, p_name text, p_body text, p_category text DEFAULT NULL::text, p_is_active boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) OR NOT public.has_any_permission(auth.uid(), ARRAY['support.manage', 'support.admin']) THEN
    RAISE EXCEPTION 'Support agent access required' USING ERRCODE = '42501';
  END IF;

  UPDATE support_response_templates
  SET name = p_name, body = p_body, category = p_category, 
      is_active = p_is_active, updated_by = auth.uid(), updated_at = now()
  WHERE id = p_id;

  RETURN jsonb_build_object('id', p_id, 'updated', true);
END;
$function$;

-- support.manage | support.admin
CREATE OR REPLACE FUNCTION public.support_list_all_templates()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) OR NOT public.has_any_permission(auth.uid(), ARRAY['support.manage', 'support.admin']) THEN
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
$function$;

-- support.view
CREATE OR REPLACE FUNCTION public.support_list_templates()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) OR NOT public.has_permission(auth.uid(), 'support.view') THEN
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
$function$;

-- support.view
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

  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) OR NOT public.has_permission(auth.uid(), 'support.view') THEN
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
$function$;

-- support.view
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
  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) OR NOT public.has_permission(auth.uid(), 'support.view') THEN
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
$function$;

-- support.view
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
  ) OR NOT public.has_permission(v_caller_id, 'support.view') THEN
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
$function$;

-- support.view
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
  ) OR NOT public.has_permission(v_caller_id, 'support.view') THEN
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
$function$;

-- support.view
CREATE OR REPLACE FUNCTION public.support_list_agents()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only allow internal users to call this
  IF NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = auth.uid()) OR NOT public.has_permission(auth.uid(), 'support.view') THEN
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
$function$;

-- support.view
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
  IF NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_adder_id) OR NOT public.has_permission(v_adder_id, 'support.view') THEN
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
$function$;

-- support.view
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
  IF NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id) OR NOT public.has_permission(v_caller_id, 'support.view') THEN
    RAISE EXCEPTION 'Only agents can remove participants';
  END IF;

  DELETE FROM support_ticket_participants WHERE id = p_participant_id;

  RETURN jsonb_build_object('removed', true, 'id', p_participant_id);
END;
$function$;

-- support.view
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

  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) OR NOT public.has_permission(auth.uid(), 'support.view') THEN
    RAISE EXCEPTION 'Support agent access required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT st.id, st.ticket_number, st.subject, st.status, st.priority, st.created_at
  FROM support_tickets st
  WHERE st.requester_email = p_email
  ORDER BY st.created_at DESC
  LIMIT 5;
END;
$function$;

-- support.view
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

  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) OR NOT public.has_permission(auth.uid(), 'support.view') THEN
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
$function$;

-- support.view
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

  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) OR NOT public.has_permission(auth.uid(), 'support.view') THEN
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
$function$;

-- support.view
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
  ) OR NOT public.has_permission(v_caller_id, 'support.view') THEN
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
$function$;

-- support.view
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
  ) OR NOT public.has_permission(v_caller_id, 'support.view') THEN
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
$function$;

-- support.view
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
  ) OR NOT public.has_permission(v_caller_id, 'support.view') THEN
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
$function$;

REVOKE EXECUTE ON FUNCTION public.support_agent_analytics(integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.support_bulk_update_tickets(uuid[], text, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.support_bulk_update_tickets(uuid[], text, uuid, text, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.support_bulk_update_tickets(uuid[], text, uuid, text, uuid, boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.support_create_template(text, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.support_get_related_tickets(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.support_link_tickets(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.support_unlink_tickets(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.support_list_agents() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.support_add_participant(uuid, text, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.support_remove_participant(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.support_requester_recent_tickets(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.support_search_requesters(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.support_search_tickets_for_link(text, uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.support_agent_analytics(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_assign_ticket(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_bulk_update_tickets(uuid[], text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_bulk_update_tickets(uuid[], text, uuid, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_bulk_update_tickets(uuid[], text, uuid, text, uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_create_template(text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_delete_template(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_update_template(uuid, text, text, text, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_list_all_templates() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_list_templates() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_get_related_tickets(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_get_ticket_stats() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_link_tickets(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_unlink_tickets(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_list_agents() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_add_participant(uuid, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_remove_participant(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_requester_recent_tickets(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_search_requesters(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_search_tickets_for_link(text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_update_ticket_category(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_update_ticket_priority(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.support_update_ticket_status(uuid, text, text) TO authenticated, service_role;
