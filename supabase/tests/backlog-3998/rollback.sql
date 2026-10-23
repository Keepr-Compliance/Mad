-- BACKLOG-3998 rollback: removes the three triggers and the four functions this
-- migration adds, drops the update policy's WITH CHECK, and re-creates handle_new_user
-- and admin_add_internal_user with the bodies measured on production and keepr-test
-- before the migration (md5(prosrc) 64c98e28c6916d1095fd70445e7812cf and
-- 058aebe462132d39c60ab4cfdf9dbd55, checked at the end). public.users.email values the
-- migration's data step rewrote are NOT restored.
-- Run as one statement batch; then delete the ledger row if it was applied through it:
--   DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261016070000';

DROP TRIGGER IF EXISTS users_email_from_auth ON public.users;
DROP TRIGGER IF EXISTS users_client_write_guard ON public.users;
DROP TRIGGER IF EXISTS on_auth_user_email_changed ON auth.users;
DROP FUNCTION IF EXISTS public.users_email_from_auth();
DROP FUNCTION IF EXISTS public.users_client_write_guard();
DROP FUNCTION IF EXISTS public.users_own_oauth_pair();
DROP FUNCTION IF EXISTS public.user_id_for_auth_email(text);
DROP FUNCTION IF EXISTS public.sync_email_from_auth();

DROP POLICY IF EXISTS users_can_update_own_user ON public.users;
CREATE POLICY users_can_update_own_user ON public.users
  FOR UPDATE USING ((SELECT auth.uid()) = id);

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_email TEXT;
  v_existing_id UUID;
BEGIN
  -- Handle null or empty email - use fallback
  v_email := COALESCE(
    NULLIF(TRIM(NEW.email), ''),
    NULLIF(TRIM(NEW.raw_user_meta_data->>'email'), ''),
    NEW.id::text || '@unknown.local'
  );

  -- Check if a user with this email already exists (orphaned from previous auth)
  SELECT id INTO v_existing_id FROM public.users WHERE email = v_email;

  IF v_existing_id IS NOT NULL AND v_existing_id != NEW.id THEN
    -- Email exists with different ID - delete orphaned record and its related data
    -- This handles the case where user was deleted from auth but not public.users
    
    -- Delete related analytics_events first (FK constraint)
    DELETE FROM public.analytics_events WHERE user_id = v_existing_id;
    
    -- Delete the orphaned user record
    DELETE FROM public.users WHERE id = v_existing_id;
  END IF;

  -- Now insert the new user (or update if somehow exists with same ID)
  INSERT INTO public.users (
    id, email, display_name, avatar_url, oauth_provider, oauth_id,
    created_at, updated_at, is_active, status
  )
  VALUES (
    NEW.id,
    v_email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', split_part(v_email, '@', 1)),
    NEW.raw_user_meta_data->>'avatar_url',
    COALESCE(NEW.raw_app_meta_data->>'provider', 'email'),
    COALESCE(NEW.raw_user_meta_data->>'provider_id', NEW.raw_user_meta_data->>'sub', NEW.id::text),
    NOW(),
    NOW(),
    true,
    'active'
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    display_name = COALESCE(EXCLUDED.display_name, public.users.display_name),
    avatar_url = COALESCE(EXCLUDED.avatar_url, public.users.avatar_url),
    updated_at = NOW();

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_add_internal_user(p_email text, p_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_target_user_id UUID;
  v_role_id UUID;
  v_existing RECORD;
BEGIN
  IF NOT public.has_internal_role(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT id INTO v_role_id FROM public.admin_roles WHERE slug = REPLACE(p_role, '_', '-');
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'Invalid role: %', p_role;
  END IF;

  SELECT id INTO v_target_user_id FROM public.users WHERE email = p_email;
  IF v_target_user_id IS NULL THEN
    RAISE EXCEPTION 'No user found with email: %', p_email;
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
$function$;

DO $chk$
DECLARE v text;
BEGIN
  SELECT string_agg(p.proname || '=' || md5(p.prosrc), ' ' ORDER BY p.proname) INTO v FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('handle_new_user', 'admin_add_internal_user');
  IF v IS DISTINCT FROM 'admin_add_internal_user=058aebe462132d39c60ab4cfdf9dbd55 handle_new_user=64c98e28c6916d1095fd70445e7812cf' THEN
    RAISE EXCEPTION '3998 rollback: restored bodies do not match the pinned md5s: %', v;
  END IF;
END $chk$;
