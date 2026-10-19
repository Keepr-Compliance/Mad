-- BACKLOG-3991: one writer for identity-provider names, and an admin name edit for
-- brokerages on manual user management.
--
-- 1. public.sync_profile_names_from_idp(p_first, p_last, p_display)
--    Called by the signed-in user at each portal and desktop sign-in. Writes the
--    caller's own public.users first_name / last_name / display_name. Per field: a
--    value the provider sent overwrites; an absent, empty or whitespace-only value
--    keeps the stored one. A value with a control character or a line/paragraph
--    separator inside, or longer than 200 characters, is skipped (never an error, so
--    it can never block a sign-in). No user-id parameter: only auth.uid()'s row. Never
--    INSERTs (handle_new_user owns row creation). Skips the write when nothing changes.
-- 2. public.org_names_directory_managed(p_org)
--    true (names are not editable here) unless the caller is a claimed, active admin or
--    it_admin of p_org AND the organization uses neither JIT (NULL counts as on, the
--    same default jit_join_organization uses), nor scim_enabled, nor
--    directory_sync_enabled, nor has a live SCIM token. A missing org is true.
-- 3. public.set_member_name(p_member_id, p_first, p_last)
--    An admin / it_admin edits another member's name. Claimed target: public.users
--    first_name, last_name, display_name. Unclaimed invite: organization_members
--    invited_first_name / invited_last_name. Refused: not a claimed active admin or
--    it_admin of the target's org; an admin editing an it_admin; own row; a personal
--    org; a deactivated target; a directory-managed org; a target with a claimed row in
--    any other brokerage (any license status).
--
-- CREATE OR REPLACE only; no BEGIN/COMMIT. Pre-check first: the helper functions these
-- bodies and their correctness argument rest on are the expected ones, and these three
-- are absent or already this file's body (re-running is a no-op). accept_invitation's
-- pin (37ce0577) holds on keepr-test now and on production once 20261018170000 applies;
-- production applies its ledger in version order, so it is in place before this file.
-- Rollback: supabase/tests/backlog-3991/rollback.sql (drops the three functions).

DO $pre$
DECLARE
  v_md5 text;
  r     record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.member_status_grants_access(text)',  'f9e7a2defaa0de6e96d4feee43527c3c'),
    ('public.member_status_is_deactivated(text)', 'f1cc92b7dd9b6c84778c86dbb89aafcf'),
    ('public.handle_new_user()',                  '64c98e28c6916d1095fd70445e7812cf'),
    ('public.accept_invitation(text,text)',       '37ce05772d72d25439d5ef2bdd5a2d08')
  ) AS t(sig, expected) LOOP
    SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v_md5 IS DISTINCT FROM r.expected THEN
      RAISE EXCEPTION '3991 pre-check: % body md5 % is not the expected %', r.sig, v_md5, r.expected;
    END IF;
  END LOOP;

  FOR r IN SELECT * FROM (VALUES
    ('public.sync_profile_names_from_idp(text,text,text)', '18ee571b4bb9dd485032c1b98a0dd904'),
    ('public.org_names_directory_managed(uuid)',           '99e8d288115addafe005249f42e7d4b8'),
    ('public.set_member_name(uuid,text,text)',             'e6e1590f67f8c15f98fa32a6a94aeffb')
  ) AS t(sig, expected) LOOP
    SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v_md5 IS NOT NULL AND v_md5 <> r.expected THEN
      RAISE EXCEPTION '3991 pre-check: % exists with a different body (md5 %)', r.sig, v_md5;
    END IF;
  END LOOP;

  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'organizations'
         AND column_name = 'jit_provisioning_enabled') IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION '3991 pre-check: organizations.jit_provisioning_enabled DEFAULT is not false (20261016100100 not applied)';
  END IF;

  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((table_name = 'organization_members' AND column_name IN ('invited_first_name', 'invited_last_name'))
           OR (table_name = 'scim_tokens' AND column_name IN ('organization_id', 'revoked_at', 'expires_at'))
           OR (table_name = 'organizations' AND column_name IN ('scim_enabled', 'directory_sync_enabled', 'personal_owner_user_id')))) <> 8 THEN
    RAISE EXCEPTION '3991 pre-check: a required column is missing (invited_*_name from 20261017230000, scim_tokens, organizations)';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.sync_profile_names_from_idp(p_first text, p_last text, p_display text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  -- Space, tab, CR, LF, FF, VT (11), NBSP (160), U+2028, U+2029, zero-width space, BOM.
  v_ws      constant text := E' \t\r\n\f' || chr(11) || chr(160) || chr(8232) || chr(8233) || chr(8203) || chr(65279);
  v_bad     constant text := '[[:cntrl:]' || chr(8232) || chr(8233) || ']';
  v_first   text := NULLIF(btrim(p_first, v_ws), '');
  v_last    text := NULLIF(btrim(p_last, v_ws), '');
  v_display text := NULLIF(btrim(p_display, v_ws), '');
  v_rows    integer;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  -- A rejected value is skipped, never raised: a sign-in must not fail on a name.
  IF v_first ~ v_bad OR char_length(v_first) > 200 THEN v_first := NULL; END IF;
  IF v_last ~ v_bad OR char_length(v_last) > 200 THEN v_last := NULL; END IF;
  IF v_display ~ v_bad OR char_length(v_display) > 200 THEN v_display := NULL; END IF;

  IF v_first IS NULL AND v_last IS NULL AND v_display IS NULL THEN
    RETURN jsonb_build_object('success', true, 'updated', false);
  END IF;

  UPDATE public.users u
     SET first_name   = COALESCE(v_first, u.first_name),
         last_name    = COALESCE(v_last, u.last_name),
         display_name = COALESCE(v_display, u.display_name),
         updated_at   = now()
   WHERE u.id = v_uid
     AND (u.first_name, u.last_name, u.display_name) IS DISTINCT FROM
         (COALESCE(v_first, u.first_name), COALESCE(v_last, u.last_name), COALESCE(v_display, u.display_name));
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_uid) THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_user_row');
  END IF;

  RETURN jsonb_build_object('success', true, 'updated', v_rows > 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_profile_names_from_idp(text, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sync_profile_names_from_idp(text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.org_names_directory_managed(p_org uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  -- Only a claimed, active admin / it_admin of p_org learns the answer; everyone
  -- else gets true (hidden), so the function cannot probe another org's settings.
  IF v_uid IS NULL OR p_org IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.organization_members m
        WHERE m.organization_id = p_org
          AND m.user_id = v_uid
          AND m.role IN ('admin', 'it_admin')
          AND public.member_status_grants_access(m.license_status)) THEN
    RETURN true;
  END IF;

  RETURN NOT EXISTS (
           SELECT 1 FROM public.organizations o
            WHERE o.id = p_org
              AND NOT COALESCE(o.jit_provisioning_enabled, true)
              AND NOT COALESCE(o.scim_enabled, false)
              AND NOT COALESCE(o.directory_sync_enabled, false))
      OR EXISTS (
           SELECT 1 FROM public.scim_tokens t
            WHERE t.organization_id = p_org
              AND t.revoked_at IS NULL
              AND (t.expires_at IS NULL OR t.expires_at > now()));
END;
$function$;

REVOKE ALL ON FUNCTION public.org_names_directory_managed(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_names_directory_managed(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_member_name(p_member_id uuid, p_first text, p_last text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid         uuid := auth.uid();
  v_ws          constant text := E' \t\r\n\f' || chr(11) || chr(160) || chr(8232) || chr(8233) || chr(8203) || chr(65279);
  v_bad         constant text := '[[:cntrl:]' || chr(8232) || chr(8233) || ']';
  v_org_id      uuid;
  v_personal    boolean;
  v_caller_role text;
  v_target      record;
  v_first       text := NULLIF(btrim(p_first, v_ws), '');
  v_last        text := NULLIF(btrim(p_last, v_ws), '');
  v_display     text;
BEGIN
  IF v_uid IS NULL OR p_member_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  SELECT m.organization_id INTO v_org_id
    FROM public.organization_members m WHERE m.id = p_member_id;
  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  -- Lock first: every read below is taken under it (same order as set_member_license).
  SELECT o.personal_owner_user_id IS NOT NULL INTO v_personal
    FROM public.organizations o WHERE o.id = v_org_id
    FOR NO KEY UPDATE;

  SELECT m.role INTO v_caller_role
    FROM public.organization_members m
   WHERE m.organization_id = v_org_id
     AND m.user_id = v_uid
     AND public.member_status_grants_access(m.license_status);
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'it_admin') THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  SELECT m.id, m.user_id, m.role, m.license_status INTO v_target
    FROM public.organization_members m
   WHERE m.id = p_member_id AND m.organization_id = v_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  IF v_target.user_id = v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'own_membership');
  END IF;
  IF v_target.role = 'it_admin' AND v_caller_role <> 'it_admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  IF v_personal IS DISTINCT FROM false OR public.member_status_is_deactivated(v_target.license_status) THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_target');
  END IF;
  IF public.org_names_directory_managed(v_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'directory_managed');
  END IF;
  -- A person's users row is editable only by their one brokerage: any claimed row in
  -- another non-personal org refuses, whatever its license status.
  IF v_target.user_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.organization_members m
         JOIN public.organizations o ON o.id = m.organization_id
        WHERE m.user_id = v_target.user_id
          AND m.organization_id <> v_org_id
          AND o.personal_owner_user_id IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  IF v_first ~ v_bad OR v_last ~ v_bad
     OR char_length(v_first) > 100 OR char_length(v_last) > 100
     OR (v_first IS NULL AND v_last IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_name');
  END IF;
  v_display := concat_ws(' ', v_first, v_last);

  IF v_target.user_id IS NOT NULL THEN
    UPDATE public.users
       SET first_name = v_first, last_name = v_last, display_name = v_display, updated_at = now()
     WHERE id = v_target.user_id;
  ELSE
    UPDATE public.organization_members
       SET invited_first_name = v_first, invited_last_name = v_last
     WHERE id = v_target.id;
  END IF;

  RETURN jsonb_build_object('success', true, 'member_id', v_target.id,
                            'first_name', v_first, 'last_name', v_last, 'display_name', v_display);
END;
$function$;

REVOKE ALL ON FUNCTION public.set_member_name(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_name(uuid, text, text) TO authenticated, service_role;
