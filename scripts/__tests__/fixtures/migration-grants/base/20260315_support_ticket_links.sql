-- ============================================
-- SUPPORT TICKETING: Ticket Links
-- Migration: 20260315_support_ticket_links
-- Purpose: Create support_ticket_links table + 4 RPCs for linking tickets
-- Sprint: SPRINT-133 / TASK-2184
-- ============================================

-- 1. Create support_ticket_links table
CREATE TABLE IF NOT EXISTS support_ticket_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  linked_ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL DEFAULT 'related'
    CHECK (link_type IN ('related', 'duplicate', 'parent', 'child')),
  linked_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(ticket_id, linked_ticket_id),
  CHECK (ticket_id != linked_ticket_id)
);

CREATE INDEX IF NOT EXISTS idx_support_ticket_links_ticket ON support_ticket_links(ticket_id);
CREATE INDEX IF NOT EXISTS idx_support_ticket_links_linked ON support_ticket_links(linked_ticket_id);

-- 2. support_get_related_tickets RPC
-- Returns both auto-related (same requester) and manually linked tickets
CREATE OR REPLACE FUNCTION support_get_related_tickets(p_ticket_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_requester_email TEXT;
  v_auto_related JSONB;
  v_manual_links JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT requester_email INTO v_requester_email
  FROM support_tickets WHERE id = p_ticket_id;

  IF v_requester_email IS NULL THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  -- Auto-related: same requester, excluding current ticket
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

  -- Manual links: bidirectional lookup
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
$$;

GRANT EXECUTE ON FUNCTION support_get_related_tickets TO authenticated;

-- 3. support_link_tickets RPC
CREATE OR REPLACE FUNCTION support_link_tickets(
  p_ticket_id UUID,
  p_linked_ticket_id UUID,
  p_link_type TEXT DEFAULT 'related'
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_caller_id UUID;
  v_link_id UUID;
  v_ticket_number INTEGER;
  v_linked_number INTEGER;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- Get ticket numbers for event logging
  SELECT ticket_number INTO v_ticket_number FROM support_tickets WHERE id = p_ticket_id;
  SELECT ticket_number INTO v_linked_number FROM support_tickets WHERE id = p_linked_ticket_id;

  IF v_ticket_number IS NULL OR v_linked_number IS NULL THEN
    RAISE EXCEPTION 'One or both tickets not found';
  END IF;

  -- Insert link (one direction -- query handles bidirectional lookup)
  INSERT INTO support_ticket_links (ticket_id, linked_ticket_id, link_type, linked_by)
  VALUES (p_ticket_id, p_linked_ticket_id, p_link_type, v_caller_id)
  RETURNING id INTO v_link_id;

  -- Log event on both tickets
  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, new_value)
  VALUES (p_ticket_id, v_caller_id, 'ticket_linked', '#' || v_linked_number || ' (' || p_link_type || ')');

  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, new_value)
  VALUES (p_linked_ticket_id, v_caller_id, 'ticket_linked', '#' || v_ticket_number || ' (' || p_link_type || ')');

  RETURN jsonb_build_object('link_id', v_link_id, 'linked', true);
END;
$$;

GRANT EXECUTE ON FUNCTION support_link_tickets TO authenticated;

-- 4. support_unlink_tickets RPC
CREATE OR REPLACE FUNCTION support_unlink_tickets(
  p_ticket_id UUID,
  p_linked_ticket_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_caller_id UUID;
  v_ticket_number INTEGER;
  v_linked_number INTEGER;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT ticket_number INTO v_ticket_number FROM support_tickets WHERE id = p_ticket_id;
  SELECT ticket_number INTO v_linked_number FROM support_tickets WHERE id = p_linked_ticket_id;

  -- Delete link (either direction)
  DELETE FROM support_ticket_links
  WHERE (ticket_id = p_ticket_id AND linked_ticket_id = p_linked_ticket_id)
     OR (ticket_id = p_linked_ticket_id AND linked_ticket_id = p_ticket_id);

  -- Log event on both tickets
  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value)
  VALUES (p_ticket_id, v_caller_id, 'ticket_unlinked', '#' || v_linked_number);

  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value)
  VALUES (p_linked_ticket_id, v_caller_id, 'ticket_unlinked', '#' || v_ticket_number);

  RETURN jsonb_build_object('unlinked', true);
END;
$$;

GRANT EXECUTE ON FUNCTION support_unlink_tickets TO authenticated;

-- 5. support_search_tickets_for_link RPC
CREATE OR REPLACE FUNCTION support_search_tickets_for_link(
  p_query TEXT,
  p_exclude_ticket_id UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  ticket_number INT,
  subject TEXT,
  status TEXT,
  requester_name TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
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
$$;

GRANT EXECUTE ON FUNCTION support_search_tickets_for_link TO authenticated;
