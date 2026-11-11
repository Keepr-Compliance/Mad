-- BACKLOG-4168 PR 1 rollback (keepr-test, or production with a go).
-- Restores the seven changed functions to the bodies production held before 20261107100000. Each body
-- below is prosrc exactly as SELECTed (byte-identical on production and keepr-test on 2026-11-06;
-- md5(prosrc): add d104c223, update_user_role fb28ab2d, remove 8f5c1432, create_role 40b96420,
-- update_role_permissions b0224e65, update_role ffa1ec1c, delete_role 75a59b63). Restores anon's
-- previous table privileges on pending_internal_invitations. Restores the previous EXECUTE grants and the previous
-- internal_users_can_manage_invitations policy, removes the four new invitation policies, the four
-- new functions and the version row.

CREATE OR REPLACE FUNCTION public.admin_add_internal_user(p_email text, p_role text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $rbf$
DECLARE
  v_target_user_id UUID;
  v_role_id UUID;
  v_existing RECORD;
  v_matches INT;
BEGIN
  IF NOT public.has_internal_role(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT id INTO v_role_id FROM public.admin_roles WHERE slug = REPLACE(p_role, '_', '-');
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'Invalid role: %', p_role;
  END IF;

  SELECT count(*) INTO v_matches FROM auth.users a WHERE lower(btrim(a.email)) = lower(btrim(p_email));
  IF v_matches > 1 THEN
    RAISE EXCEPTION 'More than one account has email: %', p_email;
  END IF;

  SELECT u.id INTO v_target_user_id
    FROM auth.users a JOIN public.users u ON u.id = a.id
   WHERE lower(btrim(a.email)) = lower(btrim(p_email));
  IF v_target_user_id IS NULL THEN
    RAISE EXCEPTION 'No user found with email: %', p_email USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_existing FROM public.internal_roles WHERE user_id = v_target_user_id;
  IF FOUND THEN
    RAISE EXCEPTION 'User already has an internal role';
  END IF;

  INSERT INTO public.internal_roles (user_id, role_id, created_by)
  VALUES (v_target_user_id, v_role_id, auth.uid());

  PERFORM public.log_admin_action(
    'internal_user.add',
    'internal_role',
    v_target_user_id::TEXT,
    jsonb_build_object(
      'after', jsonb_build_object(
        'email', p_email,
        'role', p_role,
        'user_id', v_target_user_id
      )
    )
  );

  RETURN jsonb_build_object('success', true, 'user_id', v_target_user_id, 'role', p_role);
END;
$rbf$;

CREATE OR REPLACE FUNCTION public.admin_update_internal_user_role(p_user_id uuid, p_role_slug text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $rbf$
DECLARE
  v_role_id UUID;
  v_old_role TEXT;
  v_email TEXT;
BEGIN
  IF NOT public.has_permission(auth.uid(), 'internal_users.manage') THEN
    RAISE EXCEPTION 'Unauthorized: requires internal_users.manage permission';
  END IF;

  SELECT id INTO v_role_id FROM public.admin_roles WHERE slug = p_role_slug;
  IF v_role_id IS NULL THEN RAISE EXCEPTION 'Invalid role: %', p_role_slug; END IF;

  SELECT ar.name, u.email INTO v_old_role, v_email
  FROM public.internal_roles ir
  JOIN public.admin_roles ar ON ar.id = ir.role_id
  JOIN public.users u ON u.id = ir.user_id
  WHERE ir.user_id = p_user_id;

  IF v_old_role IS NULL THEN RAISE EXCEPTION 'User does not have an internal role'; END IF;

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
$rbf$;

CREATE OR REPLACE FUNCTION public.admin_remove_internal_user(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $rbf$
DECLARE
  v_role_name TEXT;
  v_email TEXT;
BEGIN
  IF NOT public.has_internal_role(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove your own admin access';
  END IF;

  SELECT ar.name, u.email INTO v_role_name, v_email
  FROM public.internal_roles ir
  JOIN public.admin_roles ar ON ar.id = ir.role_id
  JOIN public.users u ON u.id = ir.user_id
  WHERE ir.user_id = p_user_id;

  IF v_role_name IS NULL THEN
    RAISE EXCEPTION 'User does not have an internal role';
  END IF;

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
$rbf$;

CREATE OR REPLACE FUNCTION public.admin_create_role(p_name text, p_slug text, p_description text DEFAULT NULL::text, p_permission_keys text[] DEFAULT '{}'::text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $rbf$
DECLARE
  v_role_id UUID;
BEGIN
  IF NOT public.has_permission(auth.uid(), 'roles.manage') THEN
    RAISE EXCEPTION 'Unauthorized: requires roles.manage permission';
  END IF;

  INSERT INTO public.admin_roles (name, slug, description, created_by)
  VALUES (p_name, p_slug, p_description, auth.uid())
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
$rbf$;

CREATE OR REPLACE FUNCTION public.admin_update_role_permissions(p_role_id uuid, p_permission_keys text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $rbf$
DECLARE
  v_role RECORD;
  v_old_permissions TEXT[];
BEGIN
  IF NOT public.has_permission(auth.uid(), 'roles.manage') THEN
    RAISE EXCEPTION 'Unauthorized: requires roles.manage permission';
  END IF;

  SELECT * INTO v_role FROM public.admin_roles WHERE id = p_role_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Role not found'; END IF;
  IF v_role.is_system THEN RAISE EXCEPTION 'Cannot modify permissions for system role'; END IF;

  -- Capture old permissions BEFORE the delete
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
$rbf$;

CREATE OR REPLACE FUNCTION public.admin_update_role(p_role_id uuid, p_name text DEFAULT NULL::text, p_description text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $rbf$
DECLARE
  v_role RECORD;
BEGIN
  IF NOT public.has_permission(auth.uid(), 'roles.manage') THEN
    RAISE EXCEPTION 'Unauthorized: requires roles.manage permission';
  END IF;

  SELECT * INTO v_role FROM public.admin_roles WHERE id = p_role_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Role not found'; END IF;
  IF v_role.is_system THEN RAISE EXCEPTION 'Cannot modify system role'; END IF;

  UPDATE public.admin_roles
  SET name = COALESCE(p_name, name),
      description = COALESCE(p_description, description),
      updated_at = NOW()
  WHERE id = p_role_id;

  PERFORM public.log_admin_action(
    'role.update',
    'admin_role',
    p_role_id::TEXT,
    jsonb_build_object(
      'before', jsonb_build_object(
        'name', v_role.name,
        'description', v_role.description
      ),
      'after', jsonb_build_object(
        'name', COALESCE(p_name, v_role.name),
        'description', COALESCE(p_description, v_role.description)
      )
    )
  );

  RETURN jsonb_build_object('success', true, 'role_id', p_role_id);
END;
$rbf$;

CREATE OR REPLACE FUNCTION public.admin_delete_role(p_role_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $rbf$
DECLARE
  v_role RECORD;
  v_assigned_users INT;
  v_permissions TEXT[];
BEGIN
  IF NOT public.has_permission(auth.uid(), 'roles.manage') THEN
    RAISE EXCEPTION 'Unauthorized: requires roles.manage permission';
  END IF;

  SELECT * INTO v_role FROM public.admin_roles WHERE id = p_role_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Role not found'; END IF;
  IF v_role.is_system THEN RAISE EXCEPTION 'Cannot delete system role'; END IF;

  SELECT COUNT(*) INTO v_assigned_users FROM public.internal_roles WHERE role_id = p_role_id;
  IF v_assigned_users > 0 THEN
    RAISE EXCEPTION 'Cannot delete role: % user(s) are still assigned to it. Reassign them first.', v_assigned_users;
  END IF;

  -- Capture permissions before deletion
  SELECT array_agg(ap.key ORDER BY ap.key) INTO v_permissions
  FROM public.admin_role_permissions arp
  JOIN public.admin_permissions ap ON ap.id = arp.permission_id
  WHERE arp.role_id = p_role_id;

  DELETE FROM public.admin_roles WHERE id = p_role_id;

  PERFORM public.log_admin_action(
    'role.delete',
    'admin_role',
    p_role_id::TEXT,
    jsonb_build_object(
      'before', jsonb_build_object(
        'name', v_role.name,
        'slug', v_role.slug,
        'description', v_role.description,
        'permissions', COALESCE(to_jsonb(v_permissions), '[]'::jsonb)
      )
    )
  );

  RETURN jsonb_build_object('success', true, 'role_id', p_role_id);
END;
$rbf$;

-- previous grants: admin_add_internal_user had no PUBLIC/anon EXECUTE; the other six had both
GRANT EXECUTE ON FUNCTION public.admin_update_internal_user_role(uuid, text) TO PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_remove_internal_user(uuid) TO PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_role(text, text, text, text[]) TO PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_role_permissions(uuid, text[]) TO PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_role(uuid, text, text) TO PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_role(uuid) TO PUBLIC, anon;

DROP POLICY IF EXISTS internal_users_read_invitations ON public.pending_internal_invitations;
DROP POLICY IF EXISTS internal_managers_insert_invitations ON public.pending_internal_invitations;
DROP POLICY IF EXISTS internal_managers_update_invitations ON public.pending_internal_invitations;
DROP POLICY IF EXISTS internal_managers_remove_invitations ON public.pending_internal_invitations;
DROP POLICY IF EXISTS internal_users_can_manage_invitations ON public.pending_internal_invitations;
CREATE POLICY internal_users_can_manage_invitations ON public.pending_internal_invitations
  FOR ALL TO authenticated
  USING (has_internal_role(( SELECT auth.uid() AS uid)))
  WITH CHECK (has_internal_role(( SELECT auth.uid() AS uid)));

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON TABLE public.pending_internal_invitations TO anon;

DROP FUNCTION IF EXISTS public.admin_accept_internal_invitation(uuid, text);
DROP FUNCTION IF EXISTS public.can_grant_role(uuid);
DROP FUNCTION IF EXISTS public._admin_can_grant_role_as(uuid, uuid);
DROP FUNCTION IF EXISTS public._admin_keys_held(uuid, text[]);

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261107100000';
