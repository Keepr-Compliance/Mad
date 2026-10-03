-- ============================================
-- SUPPORT TICKETING: Requester Lookup
-- Migration: 20260315_support_requester_lookup
-- Purpose: Add requester contact columns + search/recent RPCs
-- Sprint: SPRINT-133 / TASK-2184
-- ============================================

-- 1. Add columns to support_tickets
ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS requester_phone TEXT,
  ADD COLUMN IF NOT EXISTS preferred_contact TEXT DEFAULT 'email';

-- Add CHECK constraint if not already present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'support_tickets_preferred_contact_check'
  ) THEN
    ALTER TABLE support_tickets
      ADD CONSTRAINT support_tickets_preferred_contact_check
      CHECK (preferred_contact IN ('email', 'phone', 'either'));
  END IF;
END;
$$;

-- 2. Create support_search_requesters RPC
-- Note: profiles table has display_name but not full_name or phone.
-- Phone is stored on support_tickets.requester_phone instead.
CREATE OR REPLACE FUNCTION support_search_requesters(p_query TEXT)
RETURNS TABLE (
  user_id UUID,
  email TEXT,
  name TEXT,
  phone TEXT,
  organization_id UUID,
  organization_name TEXT,
  open_ticket_count BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  RETURN QUERY
  SELECT
    u.id,
    u.email::TEXT,
    COALESCE(p.display_name, u.email)::TEXT AS name,
    -- Get most recent phone from support_tickets for this requester
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
    OR COALESCE(p.display_name, '') ILIKE '%' || p_query || '%'
    OR COALESCE(o.name, '') ILIKE '%' || p_query || '%'
  ORDER BY
    CASE WHEN u.email ILIKE p_query || '%' THEN 0 ELSE 1 END,
    COALESCE(p.display_name, u.email)
  LIMIT 10;
END;
$$;

GRANT EXECUTE ON FUNCTION support_search_requesters TO authenticated;

-- 3. Create support_requester_recent_tickets RPC
CREATE OR REPLACE FUNCTION support_requester_recent_tickets(p_email TEXT)
RETURNS TABLE (
  id UUID,
  ticket_number INT,
  subject TEXT,
  status TEXT,
  priority TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  RETURN QUERY
  SELECT st.id, st.ticket_number, st.subject, st.status, st.priority, st.created_at
  FROM support_tickets st
  WHERE st.requester_email = p_email
  ORDER BY st.created_at DESC
  LIMIT 5;
END;
$$;

GRANT EXECUTE ON FUNCTION support_requester_recent_tickets TO authenticated;
