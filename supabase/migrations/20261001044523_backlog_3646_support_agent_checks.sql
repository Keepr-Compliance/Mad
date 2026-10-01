-- Support agent lookups: require an internal_roles caller.

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
