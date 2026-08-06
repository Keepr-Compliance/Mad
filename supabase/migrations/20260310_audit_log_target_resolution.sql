-- ============================================
-- AUDIT LOG: Resolve target user email/name in admin_get_audit_logs
-- Migration: 20260310_audit_log_target_resolution
-- Backlog: BACKLOG-921
--
-- Purpose: The RPC returned target_id as a raw UUID. This adds a second
-- LEFT JOIN on auth.users to resolve target_email and target_name, so the
-- admin UI can display "on Quincy Poe" instead of "on user".
--
-- Also drops the stale 7-param overload (with p_actor_id) if it exists.
-- ============================================

-- Drop stale overload with p_actor_id parameter (never used by admin portal)
DROP FUNCTION IF EXISTS public.admin_get_audit_logs(integer, integer, text, uuid, text, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION public.admin_get_audit_logs(
  p_limit int DEFAULT 25,
  p_offset int DEFAULT 0,
  p_action text DEFAULT NULL,
  p_target_id text DEFAULT NULL,
  p_date_from timestamptz DEFAULT NULL,
  p_date_to timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_logs jsonb;
  v_total bigint;
BEGIN
  -- Verify caller has internal role
  IF NOT EXISTS (
    SELECT 1 FROM public.internal_roles WHERE user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Unauthorized: internal role required';
  END IF;

  -- Count total matching rows
  SELECT count(*) INTO v_total
  FROM public.admin_audit_logs a
  WHERE (p_action IS NULL OR a.action = p_action)
    AND (p_target_id IS NULL OR a.target_id ILIKE '%' || p_target_id || '%')
    AND (p_date_from IS NULL OR a.created_at >= p_date_from)
    AND (p_date_to IS NULL OR a.created_at <= p_date_to);

  -- Get paginated logs with actor and target info
  SELECT coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  INTO v_logs
  FROM (
    SELECT
      a.id,
      a.action,
      a.target_type,
      a.target_id,
      a.metadata,
      a.ip_address::text,
      a.user_agent,
      a.created_at,
      a.actor_id,
      u.email as actor_email,
      u.raw_user_meta_data->>'full_name' as actor_name,
      tu.email as target_email,
      tu.raw_user_meta_data->>'full_name' as target_name
    FROM public.admin_audit_logs a
    LEFT JOIN auth.users u ON u.id = a.actor_id
    LEFT JOIN auth.users tu ON a.target_type = 'user' AND tu.id = a.target_id::uuid
    WHERE (p_action IS NULL OR a.action = p_action)
      AND (p_target_id IS NULL OR a.target_id ILIKE '%' || p_target_id || '%')
      AND (p_date_from IS NULL OR a.created_at >= p_date_from)
      AND (p_date_to IS NULL OR a.created_at <= p_date_to)
    ORDER BY a.created_at DESC
    LIMIT p_limit
    OFFSET p_offset
  ) t;

  RETURN jsonb_build_object('logs', v_logs, 'total', v_total);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_get_audit_logs(int, int, text, text, timestamptz, timestamptz) TO authenticated;
