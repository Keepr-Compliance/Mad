-- BACKLOG-4168 PR 1 — internal-role grant ceiling
--
-- Rules (founder answers on BACKLOG-4168, pm_comments):
--   * Super Admin = an internal role whose admin_roles.is_system is true.
--   * A Super Admin may grant any role. Anyone else may grant a role only when they hold
--     internal_users.manage AND the role's permissions are a STRICT subset of their own. A role with
--     is_system is never grantable by a non-Super-Admin.
--   * Changing or removing someone's internal role also needs the same ceiling on their CURRENT role.
--   * Nobody changes or removes their own internal role, and the last Super Admin is never removed or
--     demoted.
--   * Role editors (roles.manage) attach only permission keys they hold themselves (Super Admins
--     exempt) and never edit the permissions of their own role. is_system roles stay read-only.
--   * Adding an email with no account creates a pending invitation and returns {pending: true}.
--   * Invitations are written only through rows the caller could grant themselves
--     (invited_by = caller). admin_accept_internal_invitation (service role only) re-checks the
--     inviter at accept time.
--
-- ONE REFUSAL. Every function changed here refuses with 'Not permitted', SQLSTATE 42501.
-- admin_update_role and admin_delete_role keep their bodies; only their grants change.
--
-- Idempotent: every statement can run twice.
-- Rollback: supabase/tests/backlog-4168/rollback-4168.sql.

-- ---------------------------------------------------------------------------
-- Private helpers (no client EXECUTE)
-- ---------------------------------------------------------------------------

-- true when p_user holds every key in p_keys
CREATE OR REPLACE FUNCTION public._admin_keys_held(p_user uuid, p_keys text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_user IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM unnest(COALESCE(p_keys, '{}'::text[])) AS k(key)
       WHERE NOT EXISTS (
         SELECT 1
         FROM public.internal_roles ir
         JOIN public.admin_role_permissions arp ON arp.role_id = ir.role_id
         JOIN public.admin_permissions ap ON ap.id = arp.permission_id
         WHERE ir.user_id = p_user
           AND ap.key = k.key
       )
     );
$$;

-- true when p_grantor may grant p_role_id (the ceiling only; callers check internal_users.manage)
CREATE OR REPLACE FUNCTION public._admin_can_grant_role_as(p_grantor uuid, p_role_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_grantor IS NULL OR p_role_id IS NULL THEN false
    WHEN NOT EXISTS (SELECT 1 FROM public.admin_roles r WHERE r.id = p_role_id) THEN false
    WHEN EXISTS (
      SELECT 1
      FROM public.internal_roles ir
      JOIN public.admin_roles ar ON ar.id = ir.role_id
      WHERE ir.user_id = p_grantor
        AND ar.is_system
    ) THEN true
    WHEN (SELECT r.is_system FROM public.admin_roles r WHERE r.id = p_role_id) THEN false
    -- every permission of the role is held by the grantor
    WHEN EXISTS (
      SELECT 1
      FROM public.admin_role_permissions rp
      WHERE rp.role_id = p_role_id
        AND NOT EXISTS (
          SELECT 1
          FROM public.internal_roles ir
          JOIN public.admin_role_permissions gp ON gp.role_id = ir.role_id
          WHERE ir.user_id = p_grantor
            AND gp.permission_id = rp.permission_id
        )
    ) THEN false
    -- STRICT: the grantor holds at least one permission the role lacks
    ELSE EXISTS (
      SELECT 1
      FROM public.internal_roles ir
      JOIN public.admin_role_permissions gp ON gp.role_id = ir.role_id
      WHERE ir.user_id = p_grantor
        AND NOT EXISTS (
          SELECT 1
          FROM public.admin_role_permissions rp
          WHERE rp.role_id = p_role_id
            AND rp.permission_id = gp.permission_id
        )
    )
  END;
$$;

-- ---------------------------------------------------------------------------
-- can_grant_role: caller-bound ceiling check (used by the invitation policies and the admin UI)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_grant_role(p_role_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public._admin_can_grant_role_as((SELECT auth.uid()), p_role_id);
$$;

-- ---------------------------------------------------------------------------
-- admin_add_internal_user: assign a role to an existing account, or invite an unknown email
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_add_internal_user(p_email text, p_role text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_email TEXT := lower(btrim(p_email));
  v_role_id UUID;
  v_target_user_id UUID;
  v_matches INT;
  v_invite_role_id UUID;
BEGIN
  SELECT id INTO v_role_id FROM public.admin_roles WHERE slug = REPLACE(p_role, '_', '-');

  IF v_uid IS NULL
     OR v_role_id IS NULL
     OR COALESCE(v_email, '') = ''
     OR NOT public.has_permission(v_uid, 'internal_users.manage')
     OR NOT public._admin_can_grant_role_as(v_uid, v_role_id)
  THEN
    RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_matches FROM auth.users a WHERE lower(btrim(a.email)) = v_email;
  IF v_matches > 1 THEN
    RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501';
  END IF;

  SELECT u.id INTO v_target_user_id
    FROM auth.users a JOIN public.users u ON u.id = a.id
   WHERE lower(btrim(a.email)) = v_email;

  IF v_target_user_id IS NULL THEN
    -- No account yet: record (or replace) a pending invitation. The role is assigned at first sign-in
    -- by admin_accept_internal_invitation.
    SELECT role_id INTO v_invite_role_id
      FROM public.pending_internal_invitations
     WHERE email = v_email
       FOR UPDATE;
    IF FOUND AND NOT public._admin_can_grant_role_as(v_uid, v_invite_role_id) THEN
      RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.pending_internal_invitations (email, role_id, invited_by)
    VALUES (v_email, v_role_id, v_uid)
    ON CONFLICT (email) DO UPDATE
      SET role_id = EXCLUDED.role_id,
          invited_by = EXCLUDED.invited_by,
          created_at = now();

    PERFORM public.log_admin_action(
      'internal_user.invite',
      'internal_invitation',
      v_email,
      jsonb_build_object('after', jsonb_build_object('email', v_email, 'role', p_role))
    );

    RETURN jsonb_build_object('success', true, 'pending', true, 'email', v_email, 'role', p_role);
  END IF;

  IF v_target_user_id = v_uid
     OR EXISTS (SELECT 1 FROM public.internal_roles WHERE user_id = v_target_user_id)
  THEN
    RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.internal_roles (user_id, role_id, created_by)
  VALUES (v_target_user_id, v_role_id, v_uid);

  PERFORM public.log_admin_action(
    'internal_user.add',
    'internal_role',
    v_target_user_id::TEXT,
    jsonb_build_object(
      'after', jsonb_build_object(
        'email', v_email,
        'role', p_role,
        'user_id', v_target_user_id
      )
    )
  );

  RETURN jsonb_build_object('success', true, 'user_id', v_target_user_id, 'role', p_role);
END;
$$;

-- ---------------------------------------------------------------------------
-- admin_update_internal_user_role
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_update_internal_user_role(p_user_id uuid, p_role_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role_id UUID;
  v_cur_role_id UUID;
  v_old_role TEXT;
  v_email TEXT;
BEGIN
  -- serialise changes to Super Admin holders so two concurrent calls cannot leave none
  PERFORM 1
    FROM public.internal_roles ir
    JOIN public.admin_roles ar ON ar.id = ir.role_id
   WHERE ar.is_system
     FOR UPDATE OF ir;

  SELECT id INTO v_role_id FROM public.admin_roles WHERE slug = p_role_slug;
  SELECT ir.role_id INTO v_cur_role_id FROM public.internal_roles ir WHERE ir.user_id = p_user_id;

  IF v_uid IS NULL
     OR v_role_id IS NULL
     OR v_cur_role_id IS NULL
     OR NOT public.has_permission(v_uid, 'internal_users.manage')
     OR NOT public._admin_can_grant_role_as(v_uid, v_role_id)
     OR NOT public._admin_can_grant_role_as(v_uid, v_cur_role_id)
     OR p_user_id = v_uid
     OR (EXISTS (SELECT 1 FROM public.admin_roles WHERE id = v_cur_role_id AND is_system)
         AND NOT EXISTS (SELECT 1 FROM public.admin_roles WHERE id = v_role_id AND is_system)
         AND NOT EXISTS (SELECT 1 FROM public.internal_roles ir JOIN public.admin_roles ar ON ar.id = ir.role_id
                          WHERE ar.is_system AND ir.user_id <> p_user_id))
  THEN
    RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501';
  END IF;

  SELECT ar.name, u.email INTO v_old_role, v_email
  FROM public.internal_roles ir
  JOIN public.admin_roles ar ON ar.id = ir.role_id
  JOIN public.users u ON u.id = ir.user_id
  WHERE ir.user_id = p_user_id;

  UPDATE public.internal_roles SET role_id = v_role_id, updated_at = NOW()
  WHERE user_id = p_user_id;

  PERFORM public.log_admin_action(
    'internal_user.role_change',
    'internal_role',
    p_user_id::TEXT,
    jsonb_build_object(
      'before', jsonb_build_object(
        'email', COALESCE(v_email, ''),
        'role', v_old_role
      ),
      'after', jsonb_build_object(
        'email', COALESCE(v_email, ''),
        'role', p_role_slug
      )
    )
  );

  RETURN jsonb_build_object('success', true, 'user_id', p_user_id, 'new_role', p_role_slug);
END;
$$;

-- ---------------------------------------------------------------------------
-- admin_remove_internal_user
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_remove_internal_user(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_cur_role_id UUID;
  v_role_name TEXT;
  v_email TEXT;
BEGIN
  -- serialise changes to Super Admin holders so two concurrent calls cannot leave none
  PERFORM 1
    FROM public.internal_roles ir
    JOIN public.admin_roles ar ON ar.id = ir.role_id
   WHERE ar.is_system
     FOR UPDATE OF ir;

  SELECT ir.role_id INTO v_cur_role_id FROM public.internal_roles ir WHERE ir.user_id = p_user_id;

  IF v_uid IS NULL
     OR v_cur_role_id IS NULL
     OR NOT public.has_permission(v_uid, 'internal_users.manage')
     OR NOT public._admin_can_grant_role_as(v_uid, v_cur_role_id)
     OR p_user_id = v_uid
     OR (EXISTS (SELECT 1 FROM public.admin_roles WHERE id = v_cur_role_id AND is_system)
         AND NOT EXISTS (SELECT 1 FROM public.internal_roles ir JOIN public.admin_roles ar ON ar.id = ir.role_id
                          WHERE ar.is_system AND ir.user_id <> p_user_id))
  THEN
    RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501';
  END IF;

  SELECT ar.name, u.email INTO v_role_name, v_email
  FROM public.internal_roles ir
  JOIN public.admin_roles ar ON ar.id = ir.role_id
  JOIN public.users u ON u.id = ir.user_id
  WHERE ir.user_id = p_user_id;

  DELETE FROM public.internal_roles WHERE user_id = p_user_id;

  PERFORM public.log_admin_action(
    'internal_user.remove',
    'internal_role',
    p_user_id::TEXT,
    jsonb_build_object(
      'before', jsonb_build_object(
        'email', COALESCE(v_email, ''),
        'role', v_role_name,
        'user_id', p_user_id
      )
    )
  );

  RETURN jsonb_build_object('success', true, 'user_id', p_user_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- admin_create_role: keys limited to the caller's own (Super Admins exempt)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_create_role(
  p_name text,
  p_slug text,
  p_description text DEFAULT NULL::text,
  p_permission_keys text[] DEFAULT '{}'::text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role_id UUID;
BEGIN
  IF v_uid IS NULL
     OR NOT public.has_permission(v_uid, 'roles.manage')
     OR NOT (public.is_super_admin(v_uid) OR public._admin_keys_held(v_uid, p_permission_keys))
  THEN
    RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.admin_roles (name, slug, description, created_by)
  VALUES (p_name, p_slug, p_description, v_uid)
  RETURNING id INTO v_role_id;

  INSERT INTO public.admin_role_permissions (role_id, permission_id)
  SELECT v_role_id, ap.id
  FROM public.admin_permissions ap
  WHERE ap.key = ANY(p_permission_keys);

  PERFORM public.log_admin_action(
    'role.create',
    'admin_role',
    v_role_id::TEXT,
    jsonb_build_object('name', p_name, 'slug', p_slug, 'permissions', p_permission_keys)
  );

  RETURN jsonb_build_object('success', true, 'role_id', v_role_id, 'name', p_name);
END;
$$;

-- ---------------------------------------------------------------------------
-- admin_update_role_permissions: keys limited to the caller's own, never the caller's own role
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_update_role_permissions(p_role_id uuid, p_permission_keys text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role RECORD;
  v_old_permissions TEXT[];
BEGIN
  SELECT * INTO v_role FROM public.admin_roles WHERE id = p_role_id;

  IF v_uid IS NULL
     OR v_role.id IS NULL
     OR v_role.is_system
     OR NOT public.has_permission(v_uid, 'roles.manage')
     OR EXISTS (SELECT 1 FROM public.internal_roles WHERE user_id = v_uid AND role_id = p_role_id)
     OR NOT (public.is_super_admin(v_uid) OR public._admin_keys_held(v_uid, p_permission_keys))
  THEN
    RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501';
  END IF;

  -- Capture old permissions BEFORE the replace
  SELECT array_agg(ap.key ORDER BY ap.key) INTO v_old_permissions
  FROM public.admin_role_permissions arp
  JOIN public.admin_permissions ap ON ap.id = arp.permission_id
  WHERE arp.role_id = p_role_id;

  DELETE FROM public.admin_role_permissions WHERE role_id = p_role_id;

  INSERT INTO public.admin_role_permissions (role_id, permission_id)
  SELECT p_role_id, ap.id
  FROM public.admin_permissions ap
  WHERE ap.key = ANY(p_permission_keys);

  UPDATE public.admin_roles SET updated_at = NOW() WHERE id = p_role_id;

  PERFORM public.log_admin_action(
    'role.update_permissions',
    'admin_role',
    p_role_id::TEXT,
    jsonb_build_object(
      'before', jsonb_build_object(
        'name', v_role.name,
        'permissions', COALESCE(to_jsonb(v_old_permissions), '[]'::jsonb)
      ),
      'after', jsonb_build_object(
        'name', v_role.name,
        'permissions', to_jsonb(p_permission_keys)
      )
    )
  );

  RETURN jsonb_build_object('success', true, 'role_id', p_role_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- admin_accept_internal_invitation: service role only (the auth callback at first sign-in)
-- No invitation for the email -> {success: true, assigned: false}.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_accept_internal_invitation(p_user_id uuid, p_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT := lower(btrim(p_email));
  v_inv RECORD;
  v_slug TEXT;
BEGIN
  SELECT * INTO v_inv
    FROM public.pending_internal_invitations
   WHERE email = v_email
     FOR UPDATE;

  IF v_inv.id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'assigned', false);
  END IF;

  IF p_user_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM auth.users a JOIN public.users u ON u.id = a.id
                     WHERE a.id = p_user_id AND lower(btrim(a.email)) = v_email)
     OR EXISTS (SELECT 1 FROM public.internal_roles WHERE user_id = p_user_id)
     OR NOT public._admin_keys_held(v_inv.invited_by, ARRAY['internal_users.manage'])
     OR NOT public._admin_can_grant_role_as(v_inv.invited_by, v_inv.role_id)
  THEN
    RAISE EXCEPTION 'Not permitted' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.internal_roles (user_id, role_id, created_by)
  VALUES (p_user_id, v_inv.role_id, v_inv.invited_by);

  DELETE FROM public.pending_internal_invitations WHERE id = v_inv.id;

  SELECT slug INTO v_slug FROM public.admin_roles WHERE id = v_inv.role_id;

  PERFORM public.log_admin_action(
    'internal_user.accept_invitation',
    'internal_role',
    p_user_id::TEXT,
    jsonb_build_object(
      'after', jsonb_build_object(
        'email', v_email,
        'role', v_slug,
        'user_id', p_user_id,
        'invited_by', v_inv.invited_by
      )
    )
  );

  RETURN jsonb_build_object('success', true, 'assigned', true, 'user_id', p_user_id, 'role', v_slug);
END;
$$;

-- ---------------------------------------------------------------------------
-- pending_internal_invitations: replace the internal ALL policy
-- (users_can_read_own_invitation, users_can_delete_own_invitation and
--  service_role_full_access_invitations are unchanged)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS internal_users_can_manage_invitations ON public.pending_internal_invitations;

DROP POLICY IF EXISTS internal_users_read_invitations ON public.pending_internal_invitations;
CREATE POLICY internal_users_read_invitations ON public.pending_internal_invitations
  FOR SELECT TO authenticated
  USING (public.has_internal_role((SELECT auth.uid())));

DROP POLICY IF EXISTS internal_managers_insert_invitations ON public.pending_internal_invitations;
CREATE POLICY internal_managers_insert_invitations ON public.pending_internal_invitations
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_permission((SELECT auth.uid()), 'internal_users.manage')
    AND public.can_grant_role(role_id)
    AND invited_by = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS internal_managers_update_invitations ON public.pending_internal_invitations;
CREATE POLICY internal_managers_update_invitations ON public.pending_internal_invitations
  FOR UPDATE TO authenticated
  USING (
    public.has_permission((SELECT auth.uid()), 'internal_users.manage')
    AND public.can_grant_role(role_id)
  )
  WITH CHECK (
    public.has_permission((SELECT auth.uid()), 'internal_users.manage')
    AND public.can_grant_role(role_id)
    AND invited_by = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS internal_managers_remove_invitations ON public.pending_internal_invitations;
CREATE POLICY internal_managers_remove_invitations ON public.pending_internal_invitations
  FOR DELETE TO authenticated
  USING (public.has_permission((SELECT auth.uid()), 'internal_users.manage'));

-- ---------------------------------------------------------------------------
-- Grants: revoke by default, then grant only the callers
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public._admin_keys_held(uuid, text[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public._admin_can_grant_role_as(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.can_grant_role(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_grant_role(uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.admin_add_internal_user(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_add_internal_user(text, text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.admin_update_internal_user_role(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_internal_user_role(uuid, text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.admin_remove_internal_user(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_remove_internal_user(uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.admin_create_role(text, text, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_role(text, text, text, text[]) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.admin_update_role_permissions(uuid, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_role_permissions(uuid, text[]) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.admin_update_role(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_role(uuid, text, text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.admin_delete_role(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_role(uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.admin_accept_internal_invitation(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_accept_internal_invitation(uuid, text) TO service_role;
