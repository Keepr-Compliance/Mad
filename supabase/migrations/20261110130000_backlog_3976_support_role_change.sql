-- BACKLOG-3976: admin-portal staff with users.edit change a brokerage member's role.
--
-- admin_update_org_member_role(p_organization_id, p_user_id, p_role)
--   Caller: internal staff holding users.edit (checked inside; same order as admin_invite_user).
--   Target: a claimed member (user_id set) of that organization. Pending invites are refused.
--   The role rules are NOT re-implemented here. The UPDATE runs while the session role is still
--   'authenticated' (SECURITY DEFINER changes current_user, not the role setting), so the same
--   triggers that guard the broker-portal Users page guard this path:
--     _guard_last_admin_upd     -> 'last_admin'      (the last active admin cannot be demoted)
--     _guard_idp_role           -> 'managed_by_idp'  (the identity provider owns the role)
--     _guard_it_admin_grant_upd -> internal staff may grant it_admin (the trigger exempts them)
--   Those errors propagate; the admin-portal action maps them to wording.
--   Every change writes admin_audit_logs through log_admin_action (actor = auth.uid()).
--   org_member_change_log also records member_role_changed in billing_change_log, as for any
--   role change.

CREATE OR REPLACE FUNCTION public.admin_update_org_member_role(
  p_organization_id uuid,
  p_user_id uuid,
  p_role text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id uuid := auth.uid();
  v_member_id uuid;
  v_old_role text;
BEGIN
  IF v_caller_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  IF NOT public.has_internal_role(v_caller_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_internal_user');
  END IF;

  IF NOT public.has_permission(v_caller_id, 'users.edit') THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_permissions');
  END IF;

  IF p_role IS NULL OR p_role NOT IN ('agent', 'broker', 'admin', 'it_admin') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_role');
  END IF;

  IF p_user_id = v_caller_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'cannot_change_own_role');
  END IF;

  SELECT m.id, m.role INTO v_member_id, v_old_role
    FROM public.organization_members m
   WHERE m.organization_id = p_organization_id
     AND m.user_id = p_user_id
   FOR UPDATE;

  IF v_member_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_member');
  END IF;

  IF v_old_role = p_role THEN
    RETURN jsonb_build_object('success', false, 'error', 'role_unchanged');
  END IF;

  UPDATE public.organization_members
     SET role = p_role,
         updated_at = now()
   WHERE id = v_member_id;

  PERFORM public.log_admin_action(
    'org_member.role_change',
    'organization_member',
    v_member_id::text,
    jsonb_build_object(
      'organization_id', p_organization_id,
      'user_id', p_user_id,
      'before', jsonb_build_object('role', v_old_role),
      'after', jsonb_build_object('role', p_role)
    )
  );

  RETURN jsonb_build_object('success', true, 'old_role', v_old_role, 'new_role', p_role);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_update_org_member_role(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_org_member_role(uuid, uuid, text) TO authenticated;
