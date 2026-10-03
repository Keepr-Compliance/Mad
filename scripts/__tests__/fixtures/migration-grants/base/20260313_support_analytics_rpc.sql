-- ============================================
-- SUPPORT TICKETING: Agent Analytics RPC
-- Migration: 20260313_support_analytics_rpc
-- Purpose: Analytics RPC for support agent performance dashboard
-- Backlog: BACKLOG-940
-- ============================================

CREATE OR REPLACE FUNCTION support_agent_analytics(p_period_days INT DEFAULT 30)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_summary JSONB;
  v_agents JSONB;
  v_period_start TIMESTAMPTZ;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  v_period_start := now() - (p_period_days || ' days')::INTERVAL;

  -- Summary stats
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

  -- Per-agent stats
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
$$;

GRANT EXECUTE ON FUNCTION support_agent_analytics TO authenticated;
