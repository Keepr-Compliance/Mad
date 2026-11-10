-- BACKLOG-4145 M1 — shared-table access helpers (additive)
--
-- Adds, changes no RLS policy (policies change in 20261108160000):
--   * support_my_requester_ids()   set of requester ids the CALLER may see through support:
--       - support.admin  -> the requester of every ticket
--       - support.view   -> the requester of every ticket assigned to the caller
--     Keyed on support_tickets.requester_id only (never requester_email). Re-evaluated on every call.
--     Intended use in a policy: id IN (SELECT public.support_my_requester_ids()).
--   * support_can_view_requester(uuid)   boolean wrapper over the set, for per-request checks.
--   * pm_list_backlog_ticket_links(uuid)   ticket number, subject and status of the tickets linked to
--     one backlog item. Caller must hold an internal role and pm.view.
--   * admin_list_user_devices(uuid)   same signature and output; now also allowed when the caller can
--     see the user as a support requester (users.view OR support_can_view_requester).
--
-- Grants: every function here has EXECUTE revoked from PUBLIC and anon. The three new functions are
-- granted to authenticated; admin_list_user_devices to authenticated and service_role.
--
-- Idempotent: every statement can run twice.
-- Rollback: supabase/tests/backlog-4145-m1/rollback-4145-m1.sql.

-- ---------------------------------------------------------------------------
-- support_my_requester_ids
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_my_requester_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT t.requester_id
  FROM public.support_tickets t
  WHERE t.requester_id IS NOT NULL
    AND (
      (SELECT public.has_permission((SELECT auth.uid()), 'support.admin'))
      OR (
        t.assignee_id = (SELECT auth.uid())
        AND (SELECT public.has_permission((SELECT auth.uid()), 'support.view'))
      )
    )
$$;

REVOKE EXECUTE ON FUNCTION public.support_my_requester_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.support_my_requester_ids() TO authenticated;

-- ---------------------------------------------------------------------------
-- support_can_view_requester
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_can_view_requester(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_user_id IS NOT NULL
     AND p_user_id IN (SELECT public.support_my_requester_ids())
$$;

REVOKE EXECUTE ON FUNCTION public.support_can_view_requester(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.support_can_view_requester(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- pm_list_backlog_ticket_links
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pm_list_backlog_ticket_links(p_backlog_item_id uuid)
RETURNS TABLE (ticket_number integer, subject text, status text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL
     OR NOT public.has_internal_role(v_uid)
     OR NOT public.has_permission(v_uid, 'pm.view')
  THEN
    RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT t.ticket_number, t.subject, t.status
  FROM public.support_ticket_backlog_links l
  JOIN public.support_tickets t ON t.id = l.ticket_id
  WHERE l.backlog_item_id = p_backlog_item_id
  ORDER BY l.created_at DESC;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.pm_list_backlog_ticket_links(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pm_list_backlog_ticket_links(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- admin_list_user_devices (signature and output unchanged)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_user_devices(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_devices JSONB;
BEGIN
  IF NOT public.has_internal_role(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF NOT (public.has_permission(auth.uid(), 'users.view')
          OR public.support_can_view_requester(p_user_id)) THEN
    RAISE EXCEPTION 'Missing permission: users.view';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', d.id,
      'device_name', d.device_name,
      'device_id', d.device_id,
      'os', d.os,
      'app_version', d.app_version,
      'platform', d.platform,
      'is_active', d.is_active,
      'last_seen_at', d.last_seen_at,
      'activated_at', d.activated_at
    ) ORDER BY d.last_seen_at DESC NULLS LAST
  ), '[]'::jsonb)
  INTO v_devices
  FROM public.devices d
  WHERE d.user_id = p_user_id;

  RETURN v_devices;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_list_user_devices(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_user_devices(uuid) TO authenticated, service_role;
