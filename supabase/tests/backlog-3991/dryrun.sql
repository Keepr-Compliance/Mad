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
--    Skips the write for a claimed, non-deactivated member of an organization with
--    scim_enabled, directory_sync_enabled or a live SCIM token: their names come from
--    that directory sync only (supabase/functions/scim, supabase/functions/directory-sync).
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
    ('public.sync_profile_names_from_idp(text,text,text)', '984dc45b04f369274a1f003344042cae'),
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

  -- A claimed, non-deactivated member of a brokerage whose directory pushes names
  -- (scim_enabled, directory_sync_enabled, or a live SCIM token) gets names from that
  -- sync only: skip, never an error, so a sign-in is never blocked.
  IF EXISTS (
       SELECT 1 FROM public.organization_members m
         JOIN public.organizations o ON o.id = m.organization_id
        WHERE m.user_id = v_uid
          AND NOT public.member_status_is_deactivated(m.license_status)
          AND (COALESCE(o.scim_enabled, false)
               OR COALESCE(o.directory_sync_enabled, false)
               OR EXISTS (
                    SELECT 1 FROM public.scim_tokens t
                     WHERE t.organization_id = o.id
                       AND t.revoked_at IS NULL
                       AND (t.expires_at IS NULL OR t.expires_at > now())))) THEN
    RETURN jsonb_build_object('success', true, 'updated', false, 'skipped', 'directory_managed');
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

-- BACKLOG-3991 DB harness. Generated by compose.py; see README.md.
-- Generated by compose.py (BACKLOG-3991). Do not edit by hand.
-- Synthetic users '<key>-3991@example.test'; organizations "Happyhomey Test 3991 ..."
-- (test naming only, no customer data). Fixture shapes: organizations / members as
-- supabase/tests/backlog-3851/lib/fixtures-3851.sql; auth.users + public.users as
-- supabase/tests/backlog-3993/controls.sql (keepr-test's handle_new_user makes the
-- public.users row; the fixture then sets known names); unclaimed invite as
-- broker-portal/lib/actions/inviteUser.ts (invited_email, 'pending', token, expiry).
CREATE TEMP TABLE ids3991 (k text PRIMARY KEY, id uuid NOT NULL DEFAULT gen_random_uuid()) ON COMMIT DROP;
INSERT INTO ids3991 (k) SELECT unnest(ARRAY['a', 'it', 'br', 'ag', 'ad', 't1', 't2', 't3', 't4', 't5', 't6', 'ga', 'tj', 'ya', 'po', 'pt', 'sa', 'sb', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'o_m', 'o_x', 'o_y', 'o_p', 'o_j', 'o_jn', 'o_s', 'o_d', 'o_tk', 'o_tr', 'o_te', 'o_tf', 'm_a', 'm_it', 'm_br', 'm_ag', 'm_ad', 'm_t1', 'm_t2', 'm_t3', 'm_t4', 'm_t5', 'm_t6', 'x_t5', 'x_t6', 'y_ya', 'p_po', 'p_pt', 'j_ga', 'j_tj', 'jn_ga', 's_ga', 'd_ga', 'tk_ga', 'tr_ga', 'te_ga', 'tf_ga', 's_k1', 'tk_k2', 'd_k3', 's_k4', 'te_k5', 'tr_k6', 's_k7', 'm_k7', 'tf_k8', 'm_inv']);
CREATE TEMP TABLE guard3991 (txt text NOT NULL) ON COMMIT DROP;
INSERT INTO guard3991 VALUES ($q$DO $pre$
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
    ('public.sync_profile_names_from_idp(text,text,text)', '984dc45b04f369274a1f003344042cae'),
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
END $pre$;$q$);
CREATE FUNCTION pg_temp.i(p text) RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT id FROM ids3991 WHERE k = p $f$;
GRANT SELECT ON ids3991, guard3991 TO authenticated;
-- Identity switch used by every case: request.jwt.claims sub + SET LOCAL ROLE authenticated
-- (NULL = no JWT), and back to postgres.
CREATE FUNCTION pg_temp.asu(p uuid) RETURNS void LANGUAGE sql AS $f$
  SELECT set_config('request.jwt.claims', CASE WHEN p IS NULL THEN '' ELSE json_build_object('sub', p, 'role', 'authenticated')::text END, true);
  SELECT set_config('role', 'authenticated', true) $f$;
CREATE FUNCTION pg_temp.pgr() RETURNS void LANGUAGE sql AS $f$
  SELECT set_config('role', 'postgres', true); SELECT set_config('request.jwt.claims', '', true) $f$;
CREATE FUNCTION pg_temp.nm(p uuid) RETURNS TABLE (f text, l text, d text, c text) LANGUAGE sql AS $f$
  SELECT u.first_name, u.last_name, u.display_name, u.ctid::text FROM public.users u WHERE u.id = p $f$;
CREATE FUNCTION pg_temp.ln(ok boolean, nm text, det text) RETURNS text LANGUAGE sql AS $f$
  SELECT E'
' || CASE WHEN COALESCE(ok, false) THEN 'PASS' ELSE 'FAIL' END || '|' || nm || '|' || COALESCE(det, '') $f$;

DO $fx$
DECLARE n text;
BEGIN
  FOREACH n IN ARRAY ARRAY['a', 'it', 'br', 'ag', 'ad', 't1', 't2', 't3', 't4', 't5', 't6', 'ga', 'tj', 'ya', 'po', 'pt', 'sa', 'sb', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'] LOOP
    INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data, raw_app_meta_data)
    VALUES (pg_temp.i(n), n || '-3991@example.test', 'authenticated', 'authenticated', '{}'::jsonb,
            '{"provider":"azure","providers":["azure"]}'::jsonb);
    INSERT INTO public.users (id, email, oauth_provider, oauth_id)
    VALUES (pg_temp.i(n), n || '-3991@example.test', 'azure', 'oauth-3991-' || n)
    ON CONFLICT (id) DO NOTHING;
    UPDATE public.users SET first_name = 'F-' || n, last_name = 'L-' || n, display_name = 'D-' || n
     WHERE id = pg_temp.i(n);
  END LOOP;

  INSERT INTO public.organizations (id, name, slug, max_seats, jit_provisioning_enabled, scim_enabled, directory_sync_enabled) VALUES
    (pg_temp.i('o_m'),  'Happyhomey Test 3991 M',  'happyhomey-test-3991-m',  50, false, false, false),
    (pg_temp.i('o_x'),  'Happyhomey Test 3991 X',  'happyhomey-test-3991-x',  50, false, false, false),
    (pg_temp.i('o_y'),  'Happyhomey Test 3991 Y',  'happyhomey-test-3991-y',  50, false, false, false),
    (pg_temp.i('o_j'),  'Happyhomey Test 3991 J',  'happyhomey-test-3991-j',  50, true,  false, false),
    (pg_temp.i('o_jn'), 'Happyhomey Test 3991 JN', 'happyhomey-test-3991-jn', 50, NULL,  false, false),
    (pg_temp.i('o_s'),  'Happyhomey Test 3991 S',  'happyhomey-test-3991-s',  50, false, true,  false),
    (pg_temp.i('o_d'),  'Happyhomey Test 3991 D',  'happyhomey-test-3991-d',  50, false, false, true),
    (pg_temp.i('o_tk'), 'Happyhomey Test 3991 TK', 'happyhomey-test-3991-tk', 50, false, false, false),
    (pg_temp.i('o_tr'), 'Happyhomey Test 3991 TR', 'happyhomey-test-3991-tr', 50, false, false, false),
    (pg_temp.i('o_te'), 'Happyhomey Test 3991 TE', 'happyhomey-test-3991-te', 50, false, false, false),
    (pg_temp.i('o_tf'), 'Happyhomey Test 3991 TF', 'happyhomey-test-3991-tf', 50, false, false, false);
  INSERT INTO public.organizations (id, name, slug, max_seats, personal_owner_user_id) VALUES
    (pg_temp.i('o_p'), 'Personal', 'personal-3991-p', 5, pg_temp.i('po'));

  INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status, provisioned_by, joined_at) VALUES
    (pg_temp.i('m_a'), pg_temp.i('o_m'), pg_temp.i('a'), 'admin', 'active', 'manual', now()),
    (pg_temp.i('m_it'), pg_temp.i('o_m'), pg_temp.i('it'), 'it_admin', 'active', 'manual', now()),
    (pg_temp.i('m_br'), pg_temp.i('o_m'), pg_temp.i('br'), 'broker', 'active', 'manual', now()),
    (pg_temp.i('m_ag'), pg_temp.i('o_m'), pg_temp.i('ag'), 'agent', 'active', 'manual', now()),
    (pg_temp.i('m_ad'), pg_temp.i('o_m'), pg_temp.i('ad'), 'admin', 'suspended', 'manual', now()),
    (pg_temp.i('m_t1'), pg_temp.i('o_m'), pg_temp.i('t1'), 'agent', 'active', 'manual', now()),
    (pg_temp.i('m_t2'), pg_temp.i('o_m'), pg_temp.i('t2'), 'agent', 'suspended', 'manual', now()),
    (pg_temp.i('m_t3'), pg_temp.i('o_m'), pg_temp.i('t3'), 'agent', 'expired', 'manual', now()),
    (pg_temp.i('m_t4'), pg_temp.i('o_m'), pg_temp.i('t4'), 'agent', 'unassigned', 'manual', now()),
    (pg_temp.i('m_t5'), pg_temp.i('o_m'), pg_temp.i('t5'), 'agent', 'active', 'manual', now()),
    (pg_temp.i('m_t6'), pg_temp.i('o_m'), pg_temp.i('t6'), 'agent', 'active', 'manual', now()),
    (pg_temp.i('x_t5'), pg_temp.i('o_x'), pg_temp.i('t5'), 'agent', 'unassigned', 'manual', now()),
    (pg_temp.i('x_t6'), pg_temp.i('o_x'), pg_temp.i('t6'), 'agent', 'suspended', 'manual', now()),
    (pg_temp.i('y_ya'), pg_temp.i('o_y'), pg_temp.i('ya'), 'admin', 'active', 'manual', now()),
    (pg_temp.i('p_po'), pg_temp.i('o_p'), pg_temp.i('po'), 'admin', 'active', 'manual', now()),
    (pg_temp.i('p_pt'), pg_temp.i('o_p'), pg_temp.i('pt'), 'agent', 'active', 'manual', now()),
    (pg_temp.i('j_ga'), pg_temp.i('o_j'), pg_temp.i('ga'), 'admin', 'active', 'manual', now()),
    (pg_temp.i('j_tj'), pg_temp.i('o_j'), pg_temp.i('tj'), 'agent', 'active', 'manual', now()),
    (pg_temp.i('jn_ga'), pg_temp.i('o_jn'), pg_temp.i('ga'), 'admin', 'active', 'manual', now()),
    (pg_temp.i('s_ga'), pg_temp.i('o_s'), pg_temp.i('ga'), 'admin', 'active', 'manual', now()),
    (pg_temp.i('d_ga'), pg_temp.i('o_d'), pg_temp.i('ga'), 'admin', 'active', 'manual', now()),
    (pg_temp.i('tk_ga'), pg_temp.i('o_tk'), pg_temp.i('ga'), 'admin', 'active', 'manual', now()),
    (pg_temp.i('tr_ga'), pg_temp.i('o_tr'), pg_temp.i('ga'), 'admin', 'active', 'manual', now()),
    (pg_temp.i('te_ga'), pg_temp.i('o_te'), pg_temp.i('ga'), 'admin', 'active', 'manual', now()),
    (pg_temp.i('tf_ga'), pg_temp.i('o_tf'), pg_temp.i('ga'), 'admin', 'active', 'manual', now()),
    (pg_temp.i('s_k1'), pg_temp.i('o_s'), pg_temp.i('k1'), 'agent', 'active', 'manual', now()),
    (pg_temp.i('tk_k2'), pg_temp.i('o_tk'), pg_temp.i('k2'), 'agent', 'active', 'manual', now()),
    (pg_temp.i('d_k3'), pg_temp.i('o_d'), pg_temp.i('k3'), 'agent', 'active', 'manual', now()),
    (pg_temp.i('s_k4'), pg_temp.i('o_s'), pg_temp.i('k4'), 'agent', 'suspended', 'manual', now()),
    (pg_temp.i('te_k5'), pg_temp.i('o_te'), pg_temp.i('k5'), 'agent', 'active', 'manual', now()),
    (pg_temp.i('tr_k6'), pg_temp.i('o_tr'), pg_temp.i('k6'), 'agent', 'active', 'manual', now()),
    (pg_temp.i('s_k7'), pg_temp.i('o_s'), pg_temp.i('k7'), 'agent', 'active', 'manual', now()),
    (pg_temp.i('m_k7'), pg_temp.i('o_m'), pg_temp.i('k7'), 'agent', 'active', 'manual', now()),
    (pg_temp.i('tf_k8'), pg_temp.i('o_tf'), pg_temp.i('k8'), 'agent', 'active', 'manual', now());
  INSERT INTO public.organization_members (id, organization_id, invited_email, role, license_status,
                                           invitation_token, invitation_expires_at, invited_at, provisioned_by,
                                           invited_first_name, invited_last_name)
  VALUES (pg_temp.i('m_inv'), pg_temp.i('o_m'), 'inv-3991@example.test', 'agent', 'pending',
          'tok-3991-' || md5(pg_temp.i('m_inv')::text), now() + interval '3 days', now(), 'invite', 'InvF', 'InvL');

  INSERT INTO public.scim_tokens (organization_id, token_hash, revoked_at, expires_at) VALUES
    (pg_temp.i('o_tk'), 'h3991-' || md5(random()::text), NULL, NULL),
    (pg_temp.i('o_tr'), 'h3991-' || md5(random()::text), now() - interval '1 day', NULL),
    (pg_temp.i('o_te'), 'h3991-' || md5(random()::text), NULL, now() - interval '1 day'),
    (pg_temp.i('o_tf'), 'h3991-' || md5(random()::text), NULL, now() + interval '30 days');
END $fx$;
CREATE FUNCTION pg_temp.run3991() RETURNS text LANGUAGE plpgsql AS $run$
DECLARE
  rep text := ''; nm text; c record;
  r jsonb; r2 jsonb; t text; t2 text; ct text; fn text; ln text; dn text; k int;
  b boolean; b2 boolean; b3 boolean; b4 boolean;
BEGIN
  FOR c IN SELECT * FROM (VALUES ('first'), ('last'), ('display')) f(f) CROSS JOIN (VALUES
      ($q$present overwrites$q$, ('Ann')::text, ('Bob')::text, ('Bob')::text),
      ($q$null keeps$q$, ('Ann')::text, (NULL)::text, ('Ann')::text),
      ($q$empty keeps$q$, ('Ann')::text, ('')::text, ('Ann')::text),
      ($q$spaces keep$q$, ('Ann')::text, ('   ')::text, ('Ann')::text),
      ($q$tab-newline keeps (M3 case)$q$, ('Ann')::text, (E'\t\n')::text, ('Ann')::text),
      ($q$CR VT FF keep$q$, ('Ann')::text, (E'\r' || chr(11) || E'\f')::text, ('Ann')::text),
      ($q$padded is trimmed$q$, ('Ann')::text, ('  Bob ')::text, ('Bob')::text),
      ($q$null stored + present$q$, (NULL)::text, ('Bob')::text, ('Bob')::text),
      ($q$null stored + null$q$, (NULL)::text, (NULL)::text, (NULL)::text),
      ($q$control char inside keeps$q$, ('Ann')::text, ('Bo' || chr(1) || 'b')::text, ('Ann')::text),
      ($q$newline inside keeps$q$, ('Ann')::text, (E'Bo\nb')::text, ('Ann')::text),
      ($q$DEL inside keeps$q$, ('Ann')::text, ('Bo' || chr(127) || 'b')::text, ('Ann')::text),
      ($q$U+2028 inside keeps$q$, ('Ann')::text, ('Bo' || chr(8232) || 'b')::text, ('Ann')::text),
      ($q$201 chars keeps$q$, ('Ann')::text, (repeat('x', 201))::text, ('Ann')::text),
      ($q$200 chars overwrites$q$, ('Ann')::text, (repeat('x', 200))::text, (repeat('x', 200))::text),
      ($q$Trent unchanged (t edges)$q$, ('Ann')::text, ('Trent')::text, ('Trent')::text),
      ($q$Liv unchanged (v edge)$q$, ('Ann')::text, ('Liv')::text, ('Liv')::text),
      ($q$Jeff unchanged (f edge)$q$, ('Ann')::text, ('Jeff')::text, ('Jeff')::text),
      ($q$Fran unchanged (n edge)$q$, ('Ann')::text, ('Fran')::text, ('Fran')::text),
      ($q$vera unchanged (v edge)$q$, ('Ann')::text, ('vera')::text, ('vera')::text),
      ($q$rob unchanged (r edge)$q$, ('Ann')::text, ('rob')::text, ('rob')::text),
      ($q$NBSP only keeps$q$, ('Ann')::text, (chr(160))::text, ('Ann')::text),
      ($q$U+2028 only keeps$q$, ('Ann')::text, (chr(8232))::text, ('Ann')::text),
      ($q$U+2029 only keeps$q$, ('Ann')::text, (chr(8233))::text, ('Ann')::text),
      ($q$ZWSP only keeps$q$, ('Ann')::text, (chr(8203))::text, ('Ann')::text),
      ($q$BOM only keeps$q$, ('Ann')::text, (chr(65279))::text, ('Ann')::text),
      ($q$NBSP padded is trimmed$q$, ('Ann')::text, (chr(160) || 'Bob' || chr(160))::text, ('Bob')::text)
    ) v(label, st, pv, ex) LOOP
    nm := 'C21 ' || c.f || ': ' || c.label;
    BEGIN
      UPDATE public.users
         SET first_name   = CASE c.f WHEN 'first' THEN c.st WHEN 'last' THEN 'Keep' ELSE 'Old' END,
             last_name    = CASE c.f WHEN 'last' THEN c.st ELSE 'Keep' END,
             display_name = CASE c.f WHEN 'display' THEN c.st ELSE 'Old' END
       WHERE id = pg_temp.i('sa');
      PERFORM pg_temp.asu(pg_temp.i('sa'));
      r := public.sync_profile_names_from_idp(
             CASE c.f WHEN 'first' THEN c.pv WHEN 'display' THEN 'Carrier' END,
             CASE c.f WHEN 'last' THEN c.pv END,
             CASE c.f WHEN 'display' THEN c.pv ELSE 'Carrier' END);
      PERFORM pg_temp.pgr();
      SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('sa'));
      t := CASE c.f WHEN 'first' THEN fn WHEN 'last' THEN ln ELSE dn END;
      t2 := CASE c.f WHEN 'last' THEN fn ELSE ln END;
      rep := rep || pg_temp.ln((r->>'success')::boolean AND t IS NOT DISTINCT FROM c.ex AND t2 = 'Keep', nm,
                               concat_ws(' / ', r::text, left(t, 30), t2));
      RAISE SQLSTATE 'P3991';
    EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
      WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
    END;
  END LOOP;
  FOR c IN SELECT * FROM (VALUES
      ($q$C1g manual org, its admin -> editable (false)$q$, 'a', pg_temp.i('o_m'), false),
      ($q$C2 JIT on -> directory_managed$q$, 'ga', pg_temp.i('o_j'), true),
      ($q$C2 JIT NULL (scim/ds off, no token) -> directory_managed$q$, 'ga', pg_temp.i('o_jn'), true),
      ($q$C2 scim_enabled -> directory_managed$q$, 'ga', pg_temp.i('o_s'), true),
      ($q$C2 directory_sync_enabled -> directory_managed$q$, 'ga', pg_temp.i('o_d'), true),
      ($q$C3 live SCIM token, scim_enabled false -> directory_managed$q$, 'ga', pg_temp.i('o_tk'), true),
      ($q$C3 SCIM token expiring later -> directory_managed$q$, 'ga', pg_temp.i('o_tf'), true),
      ($q$C3 revoked token only -> editable$q$, 'ga', pg_temp.i('o_tr'), false),
      ($q$C3 expired token only -> editable$q$, 'ga', pg_temp.i('o_te'), false),
      ($q$C9 plain member of the org -> true$q$, 'ag', pg_temp.i('o_m'), true),
      ($q$C9 non-member -> true$q$, 'ya', pg_temp.i('o_m'), true),
      ($q$C9 deactivated admin -> true$q$, 'ad', pg_temp.i('o_m'), true),
      ($q$C9 missing org -> true$q$, 'a', gen_random_uuid(), true)
    ) v(name, who, org, ex) LOOP
    nm := c.name;
    BEGIN
      PERFORM pg_temp.asu(pg_temp.i(c.who));
      b := public.org_names_directory_managed(c.org);
      PERFORM pg_temp.pgr();
      rep := rep || pg_temp.ln(b IS NOT DISTINCT FROM c.ex, nm, b::text);
      RAISE SQLSTATE 'P3991';
    EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
      WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
    END;
  END LOOP;
  FOR c IN SELECT * FROM (VALUES
      ($q$C1 admin edits claimed agent: first, last and display_name written$q$, 'a', 'm_t1', ('New')::text, ('Name')::text, 'success', 't1', ($q$New$q$)::text, ($q$Name$q$)::text, ($q$New Name$q$)::text, false),
      ($q$C1 first only: display_name = first, last cleared$q$, 'a', 'm_t1', ('Solo')::text, (NULL)::text, 'success', 't1', ($q$Solo$q$)::text, (NULL)::text, ($q$Solo$q$)::text, false),
      ($q$C2 set_member_name in a JIT org -> directory_managed$q$, 'ga', 'j_tj', ('New')::text, ('Name')::text, 'directory_managed', 'tj', ($q$F-tj$q$)::text, ($q$L-tj$q$)::text, ($q$D-tj$q$)::text, false),
      ($q$C4 admin of another org -> not_authorized$q$, 'ya', 'm_t1', ('New')::text, ('Name')::text, 'not_authorized', 't1', ($q$F-t1$q$)::text, ($q$L-t1$q$)::text, ($q$D-t1$q$)::text, false),
      ($q$C5 broker caller -> not_authorized$q$, 'br', 'm_t1', ('New')::text, ('Name')::text, 'not_authorized', 't1', ($q$F-t1$q$)::text, ($q$L-t1$q$)::text, ($q$D-t1$q$)::text, false),
      ($q$C5 agent caller -> not_authorized$q$, 'ag', 'm_t1', ('New')::text, ('Name')::text, 'not_authorized', 't1', ($q$F-t1$q$)::text, ($q$L-t1$q$)::text, ($q$D-t1$q$)::text, false),
      ($q$C5 deactivated admin -> not_authorized$q$, 'ad', 'm_t1', ('New')::text, ('Name')::text, 'not_authorized', 't1', ($q$F-t1$q$)::text, ($q$L-t1$q$)::text, ($q$D-t1$q$)::text, false),
      ($q$C6 admin -> it_admin target refused$q$, 'a', 'm_it', ('New')::text, ('Name')::text, 'not_authorized', 'it', ($q$F-it$q$)::text, ($q$L-it$q$)::text, ($q$D-it$q$)::text, false),
      ($q$C6 it_admin -> admin target succeeds$q$, 'it', 'm_a', ('New')::text, ('Name')::text, 'success', 'a', ($q$New$q$)::text, ($q$Name$q$)::text, ($q$New Name$q$)::text, false),
      ($q$C6 own row -> own_membership$q$, 'a', 'm_a', ('New')::text, ('Name')::text, 'own_membership', 'a', ($q$F-a$q$)::text, ($q$L-a$q$)::text, ($q$D-a$q$)::text, false),
      ($q$C6 personal org -> invalid_target$q$, 'po', 'p_pt', ('New')::text, ('Name')::text, 'invalid_target', 'pt', ($q$F-pt$q$)::text, ($q$L-pt$q$)::text, ($q$D-pt$q$)::text, false),
      ($q$C6 suspended target -> invalid_target, users unchanged$q$, 'a', 'm_t2', ('New')::text, ('Name')::text, 'invalid_target', 't2', ($q$F-t2$q$)::text, ($q$L-t2$q$)::text, ($q$D-t2$q$)::text, false),
      ($q$C6 expired target -> invalid_target, users unchanged$q$, 'a', 'm_t3', ('New')::text, ('Name')::text, 'invalid_target', 't3', ($q$F-t3$q$)::text, ($q$L-t3$q$)::text, ($q$D-t3$q$)::text, false),
      ($q$C6 unassigned target -> success$q$, 'a', 'm_t4', ('New')::text, ('Name')::text, 'success', 't4', ($q$New$q$)::text, ($q$Name$q$)::text, ($q$New Name$q$)::text, false),
      ($q$C7 also in another brokerage (unassigned) -> not_authorized$q$, 'a', 'm_t5', ('New')::text, ('Name')::text, 'not_authorized', 't5', ($q$F-t5$q$)::text, ($q$L-t5$q$)::text, ($q$D-t5$q$)::text, false),
      ($q$C7 also in another brokerage (suspended) -> not_authorized$q$, 'a', 'm_t6', ('New')::text, ('Name')::text, 'not_authorized', 't6', ($q$F-t6$q$)::text, ($q$L-t6$q$)::text, ($q$D-t6$q$)::text, false),
      ($q$C10 both empty -> invalid_name$q$, 'a', 'm_t4', ('')::text, ('  ')::text, 'invalid_name', 't4', ($q$F-t4$q$)::text, ($q$L-t4$q$)::text, ($q$D-t4$q$)::text, false),
      ($q$C10 101 chars -> invalid_name$q$, 'a', 'm_t4', (repeat('x', 101))::text, ('Ok')::text, 'invalid_name', 't4', ($q$F-t4$q$)::text, ($q$L-t4$q$)::text, ($q$D-t4$q$)::text, false),
      ($q$C10 100 chars -> success$q$, 'a', 'm_t4', (repeat('x', 100))::text, ('Ok')::text, 'success', 't4', ($q$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx$q$)::text, ($q$Ok$q$)::text, ($q$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx Ok$q$)::text, false),
      ($q$C10 '  Ann ' -> 'Ann'$q$, 'a', 'm_t4', ('  Ann ')::text, (NULL)::text, 'success', 't4', ($q$Ann$q$)::text, (NULL)::text, ($q$Ann$q$)::text, false),
      ($q$C10 newline inside -> invalid_name$q$, 'a', 'm_t4', (E'An\nn')::text, ('Ok')::text, 'invalid_name', 't4', ($q$F-t4$q$)::text, ($q$L-t4$q$)::text, ($q$D-t4$q$)::text, false),
      ($q$C10 U+2028 inside -> invalid_name$q$, 'a', 'm_t4', ('An' || chr(8232) || 'n')::text, ('Ok')::text, 'invalid_name', 't4', ($q$F-t4$q$)::text, ($q$L-t4$q$)::text, ($q$D-t4$q$)::text, false),
      ($q$C10 NBSP / ZWSP only -> invalid_name$q$, 'a', 'm_t4', (chr(160))::text, (chr(8203))::text, 'invalid_name', 't4', ($q$F-t4$q$)::text, ($q$L-t4$q$)::text, ($q$D-t4$q$)::text, false),
      ($q$C19 suspended brokerage: claimed edit succeeds$q$, 'a', 'm_t1', ('Sus')::text, ('Pended')::text, 'success', 't1', ($q$Sus$q$)::text, ($q$Pended$q$)::text, ($q$Sus Pended$q$)::text, true)
    ) v(name, who, mem, pf, pl, ex, chk, xf, xl, xd, susp) LOOP
    nm := c.name;
    BEGIN
      IF c.susp THEN UPDATE public.organizations SET is_test = true WHERE id = pg_temp.i('o_m'); INSERT INTO public.org_deals (organization_id, stripe_mode, seats, status, suspended_reason, version, suspended_at) VALUES (pg_temp.i('o_m'), 'test', 3, 'suspended', 'other', 1, now()); END IF;
      PERFORM pg_temp.asu(pg_temp.i(c.who));
      r := public.set_member_name(pg_temp.i(c.mem), c.pf, c.pl);
      PERFORM pg_temp.pgr();
      SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i(c.chk));
      rep := rep || pg_temp.ln(
        CASE WHEN c.ex = 'success' THEN (r->>'success')::boolean ELSE r->>'error' = c.ex END
        AND fn IS NOT DISTINCT FROM c.xf AND ln IS NOT DISTINCT FROM c.xl AND dn IS NOT DISTINCT FROM c.xd,
        nm, concat_ws(' / ', r::text, left(fn, 20), ln, left(dn, 20)));
      RAISE SQLSTATE 'P3991';
    EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
      WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
    END;
  END LOOP;
  nm := $q$C22 as A: B row byte-identical, A row changed$q$;
  BEGIN
    SELECT row_to_json(u)::text INTO t FROM public.users u WHERE u.id = pg_temp.i('sb');
    PERFORM pg_temp.asu(pg_temp.i('sa'));
    r := public.sync_profile_names_from_idp('Zed', 'Zee', 'Zed Zee');
    PERFORM pg_temp.pgr();
    SELECT row_to_json(u)::text INTO t2 FROM public.users u WHERE u.id = pg_temp.i('sb');
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('sa'));
    rep := rep || pg_temp.ln((t = t2 AND fn = 'Zed' AND ln = 'Zee' AND dn = 'Zed Zee'), nm, (r::text)::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C22 the only signature takes no user id$q$;
  BEGIN
    SELECT string_agg(pg_get_function_arguments(p.oid), ' | ') INTO t FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'sync_profile_names_from_idp';
    rep := rep || pg_temp.ln((t = 'p_first text, p_last text, p_display text'), nm, (t)::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C23 no JWT -> not_authenticated, A row untouched$q$;
  BEGIN
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('sa'));
    t := ct;
    PERFORM pg_temp.asu(NULL);
    r := public.sync_profile_names_from_idp('Q', 'Q', 'Q');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('sa'));
    rep := rep || pg_temp.ln((r->>'error' = 'not_authenticated' AND ct = t AND fn = 'F-sa'), nm, (r::text)::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C23 no users row -> no_user_row, no row inserted$q$;
  BEGIN
    PERFORM pg_temp.asu(gen_random_uuid());
    r := public.sync_profile_names_from_idp('Q', 'Q', 'Q');
    PERFORM pg_temp.pgr();
    SELECT count(*)::int INTO k FROM public.users WHERE oauth_id = 'x' OR first_name = 'Q';
    rep := rep || pg_temp.ln((r->>'error' = 'no_user_row' AND k = 0), nm, (concat_ws(' / ', r::text, k))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C23 same values twice -> updated:false, no new row version$q$;
  BEGIN
    PERFORM pg_temp.asu(pg_temp.i('sa'));
    r := public.sync_profile_names_from_idp('Same', 'Same', 'Same Same');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('sa'));
    t := ct;
    PERFORM pg_temp.asu(pg_temp.i('sa'));
    r2 := public.sync_profile_names_from_idp(' Same', 'Same ', 'Same Same');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('sa'));
    rep := rep || pg_temp.ln(((r->>'updated')::boolean AND r2->>'updated' = 'false' AND ct = t), nm, (concat_ws(' / ', r::text, r2::text, t, ct))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C23 all three absent -> updated:false, no new row version$q$;
  BEGIN
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('sa'));
    t := ct;
    PERFORM pg_temp.asu(pg_temp.i('sa'));
    r := public.sync_profile_names_from_idp(NULL, '  ', E'\t');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('sa'));
    rep := rep || pg_temp.ln((r->>'updated' = 'false' AND (r->>'success')::boolean AND ct = t), nm, (r::text)::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C20 sync: anon no, PUBLIC no, authenticated yes, definer, search_path empty$q$;
  BEGIN
    SELECT has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE'),
           EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0), p.prosecdef,
           CASE WHEN p.proconfig = ARRAY['search_path=""'] THEN 'search_path empty' ELSE p.proconfig::text END
      INTO b, b2, b3, b4, t FROM pg_proc p WHERE p.oid = 'public.sync_profile_names_from_idp(text,text,text)'::regprocedure;
    rep := rep || pg_temp.ln((NOT b AND b2 AND NOT b3 AND b4 AND t = 'search_path empty'), nm, (concat_ws(' / ', b, b2, b3, b4, t))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C20 gate: anon no, PUBLIC no, authenticated yes, definer, search_path empty$q$;
  BEGIN
    SELECT has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE'),
           EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0), p.prosecdef,
           CASE WHEN p.proconfig = ARRAY['search_path=""'] THEN 'search_path empty' ELSE p.proconfig::text END
      INTO b, b2, b3, b4, t FROM pg_proc p WHERE p.oid = 'public.org_names_directory_managed(uuid)'::regprocedure;
    rep := rep || pg_temp.ln((NOT b AND b2 AND NOT b3 AND b4 AND t = 'search_path empty'), nm, (concat_ws(' / ', b, b2, b3, b4, t))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C20 set: anon no, PUBLIC no, authenticated yes, definer, search_path empty$q$;
  BEGIN
    SELECT has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE'),
           EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0), p.prosecdef,
           CASE WHEN p.proconfig = ARRAY['search_path=""'] THEN 'search_path empty' ELSE p.proconfig::text END
      INTO b, b2, b3, b4, t FROM pg_proc p WHERE p.oid = 'public.set_member_name(uuid,text,text)'::regprocedure;
    rep := rep || pg_temp.ln((NOT b AND b2 AND NOT b3 AND b4 AND t = 'search_path empty'), nm, (concat_ws(' / ', b, b2, b3, b4, t))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C20 sync: service_role has no EXECUTE$q$;
  BEGIN
    b := has_function_privilege('service_role', 'public.sync_profile_names_from_idp(text,text,text)', 'EXECUTE');
    rep := rep || pg_temp.ln((NOT b), nm, (b::text)::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C8 unclaimed invite -> invited_*_name written, no users row touched$q$;
  BEGIN
    PERFORM pg_temp.asu(pg_temp.i('a'));
    r := public.set_member_name(pg_temp.i('m_inv'), 'InvNew', 'InvLast');
    PERFORM pg_temp.pgr();
    SELECT m.invited_first_name, m.invited_last_name INTO fn, ln FROM public.organization_members m WHERE m.id = pg_temp.i('m_inv');
    SELECT count(*)::int INTO k FROM public.users WHERE first_name = 'InvNew';
    rep := rep || pg_temp.ln(((r->>'success')::boolean AND fn = 'InvNew' AND ln = 'InvLast' AND k = 0), nm, (concat_ws(' / ', r::text, fn, ln, k))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C19 suspended brokerage: invite edit succeeds$q$;
  BEGIN
    UPDATE public.organizations SET is_test = true WHERE id = pg_temp.i('o_m'); INSERT INTO public.org_deals (organization_id, stripe_mode, seats, status, suspended_reason, version, suspended_at) VALUES (pg_temp.i('o_m'), 'test', 3, 'suspended', 'other', 1, now());
    PERFORM pg_temp.asu(pg_temp.i('a'));
    r := public.set_member_name(pg_temp.i('m_inv'), 'SusInv', 'Last');
    PERFORM pg_temp.pgr();
    SELECT m.invited_first_name INTO fn FROM public.organization_members m WHERE m.id = pg_temp.i('m_inv');
    rep := rep || pg_temp.ln(((r->>'success')::boolean AND fn = 'SusInv'), nm, (concat_ws(' / ', r::text, fn))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C31 admin edit, then sign-in with IdP first + display: first/display replaced, admin last kept$q$;
  BEGIN
    PERFORM pg_temp.asu(pg_temp.i('a'));
    r := public.set_member_name(pg_temp.i('m_t1'), 'Admin', 'Set');
    PERFORM pg_temp.asu(pg_temp.i('t1'));
    r2 := public.sync_profile_names_from_idp('Idp', NULL, 'Idp Full');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('t1'));
    rep := rep || pg_temp.ln(((r->>'success')::boolean AND (r2->>'success')::boolean AND fn = 'Idp' AND ln = 'Set' AND dn = 'Idp Full'), nm, (concat_ws(' / ', r2::text, fn, ln, dn))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C31 admin edit, then sign-in with IdP first = null: admin first survives$q$;
  BEGIN
    PERFORM pg_temp.asu(pg_temp.i('a'));
    r := public.set_member_name(pg_temp.i('m_t1'), 'Admin', 'Set');
    PERFORM pg_temp.asu(pg_temp.i('t1'));
    r2 := public.sync_profile_names_from_idp(NULL, 'IdpLast', 'Idp Full');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('t1'));
    rep := rep || pg_temp.ln((fn = 'Admin' AND ln = 'IdpLast' AND dn = 'Idp Full'), nm, (concat_ws(' / ', r2::text, fn, ln, dn))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C40 scim_enabled member: sign-in skipped, names and row version unchanged$q$;
  BEGIN
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k1'));
    t := ct;
    PERFORM pg_temp.asu(pg_temp.i('k1'));
    r := public.sync_profile_names_from_idp('New', 'Name', 'New Name');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k1'));
    rep := rep || pg_temp.ln(((r->>'success')::boolean AND r->>'skipped' = 'directory_managed' AND fn = 'F-k1' AND ln = 'L-k1' AND dn = 'D-k1' AND ct = t), nm, (concat_ws(' / ', r::text, r2::text, fn, ln, dn))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C40 same member after scim_enabled off: refreshed$q$;
  BEGIN
    PERFORM pg_temp.asu(pg_temp.i('k1'));
    r := public.sync_profile_names_from_idp('New', 'Name', 'New Name');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k1'));
    t := fn;
    UPDATE public.organizations SET scim_enabled = false WHERE id = pg_temp.i('o_s');
    PERFORM pg_temp.asu(pg_temp.i('k1'));
    r2 := public.sync_profile_names_from_idp('New', 'Name', 'New Name');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k1'));
    rep := rep || pg_temp.ln((r->>'skipped' = 'directory_managed' AND t = 'F-k1' AND (r2->>'success')::boolean AND (r2->>'updated')::boolean AND fn = 'New' AND ln = 'Name' AND dn = 'New Name'), nm, (concat_ws(' / ', r::text, r2::text, fn, ln, dn))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C41 live SCIM token (no expiry) member: sign-in skipped$q$;
  BEGIN
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k2'));
    t := ct;
    PERFORM pg_temp.asu(pg_temp.i('k2'));
    r := public.sync_profile_names_from_idp('New', 'Name', 'New Name');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k2'));
    rep := rep || pg_temp.ln(((r->>'success')::boolean AND r->>'skipped' = 'directory_managed' AND fn = 'F-k2' AND ln = 'L-k2' AND dn = 'D-k2' AND ct = t), nm, (concat_ws(' / ', r::text, r2::text, fn, ln, dn))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C41 same member after the token is revoked: refreshed$q$;
  BEGIN
    PERFORM pg_temp.asu(pg_temp.i('k2'));
    r := public.sync_profile_names_from_idp('New', 'Name', 'New Name');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k2'));
    t := fn;
    UPDATE public.scim_tokens SET revoked_at = now() WHERE organization_id = pg_temp.i('o_tk');
    PERFORM pg_temp.asu(pg_temp.i('k2'));
    r2 := public.sync_profile_names_from_idp('New', 'Name', 'New Name');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k2'));
    rep := rep || pg_temp.ln((r->>'skipped' = 'directory_managed' AND t = 'F-k2' AND (r2->>'success')::boolean AND (r2->>'updated')::boolean AND fn = 'New' AND ln = 'Name' AND dn = 'New Name'), nm, (concat_ws(' / ', r::text, r2::text, fn, ln, dn))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C41 live SCIM token (future expiry) member: sign-in skipped$q$;
  BEGIN
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k8'));
    t := ct;
    PERFORM pg_temp.asu(pg_temp.i('k8'));
    r := public.sync_profile_names_from_idp('New', 'Name', 'New Name');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k8'));
    rep := rep || pg_temp.ln(((r->>'success')::boolean AND r->>'skipped' = 'directory_managed' AND fn = 'F-k8' AND ln = 'L-k8' AND dn = 'D-k8' AND ct = t), nm, (concat_ws(' / ', r::text, r2::text, fn, ln, dn))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C42 directory_sync_enabled member: sign-in skipped$q$;
  BEGIN
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k3'));
    t := ct;
    PERFORM pg_temp.asu(pg_temp.i('k3'));
    r := public.sync_profile_names_from_idp('New', 'Name', 'New Name');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k3'));
    rep := rep || pg_temp.ln(((r->>'success')::boolean AND r->>'skipped' = 'directory_managed' AND fn = 'F-k3' AND ln = 'L-k3' AND dn = 'D-k3' AND ct = t), nm, (concat_ws(' / ', r::text, r2::text, fn, ln, dn))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C42 same member after directory_sync_enabled off: refreshed$q$;
  BEGIN
    PERFORM pg_temp.asu(pg_temp.i('k3'));
    r := public.sync_profile_names_from_idp('New', 'Name', 'New Name');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k3'));
    t := fn;
    UPDATE public.organizations SET directory_sync_enabled = false WHERE id = pg_temp.i('o_d');
    PERFORM pg_temp.asu(pg_temp.i('k3'));
    r2 := public.sync_profile_names_from_idp('New', 'Name', 'New Name');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k3'));
    rep := rep || pg_temp.ln((r->>'skipped' = 'directory_managed' AND t = 'F-k3' AND (r2->>'success')::boolean AND (r2->>'updated')::boolean AND fn = 'New' AND ln = 'Name' AND dn = 'New Name'), nm, (concat_ws(' / ', r::text, r2::text, fn, ln, dn))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C43 JIT-org member: refreshed$q$;
  BEGIN
    PERFORM pg_temp.asu(pg_temp.i('tj'));
    r := public.sync_profile_names_from_idp('New', 'Name', 'New Name');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('tj'));
    rep := rep || pg_temp.ln(((r->>'success')::boolean AND (r->>'updated')::boolean AND r->>'skipped' IS NULL AND fn = 'New' AND ln = 'Name' AND dn = 'New Name'), nm, (concat_ws(' / ', r::text, r2::text, fn, ln, dn))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C43 manual-org member: refreshed$q$;
  BEGIN
    PERFORM pg_temp.asu(pg_temp.i('t1'));
    r := public.sync_profile_names_from_idp('New', 'Name', 'New Name');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('t1'));
    rep := rep || pg_temp.ln(((r->>'success')::boolean AND (r->>'updated')::boolean AND r->>'skipped' IS NULL AND fn = 'New' AND ln = 'Name' AND dn = 'New Name'), nm, (concat_ws(' / ', r::text, r2::text, fn, ln, dn))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C43 solo user (no brokerage): refreshed$q$;
  BEGIN
    PERFORM pg_temp.asu(pg_temp.i('sb'));
    r := public.sync_profile_names_from_idp('New', 'Name', 'New Name');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('sb'));
    rep := rep || pg_temp.ln(((r->>'success')::boolean AND (r->>'updated')::boolean AND r->>'skipped' IS NULL AND fn = 'New' AND ln = 'Name' AND dn = 'New Name'), nm, (concat_ws(' / ', r::text, r2::text, fn, ln, dn))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C44 deactivated (suspended) membership in a SCIM org: refreshed$q$;
  BEGIN
    PERFORM pg_temp.asu(pg_temp.i('k4'));
    r := public.sync_profile_names_from_idp('New', 'Name', 'New Name');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k4'));
    rep := rep || pg_temp.ln(((r->>'success')::boolean AND (r->>'updated')::boolean AND r->>'skipped' IS NULL AND fn = 'New' AND ln = 'Name' AND dn = 'New Name'), nm, (concat_ws(' / ', r::text, r2::text, fn, ln, dn))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C44 SCIM member after SCIM deprovision (suspended): refreshed$q$;
  BEGIN
    PERFORM pg_temp.asu(pg_temp.i('k1'));
    r := public.sync_profile_names_from_idp('New', 'Name', 'New Name');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k1'));
    t := fn;
    UPDATE public.organization_members SET license_status = 'suspended' WHERE id = pg_temp.i('s_k1');
    PERFORM pg_temp.asu(pg_temp.i('k1'));
    r2 := public.sync_profile_names_from_idp('New', 'Name', 'New Name');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k1'));
    rep := rep || pg_temp.ln((r->>'skipped' = 'directory_managed' AND t = 'F-k1' AND (r2->>'success')::boolean AND (r2->>'updated')::boolean AND fn = 'New' AND ln = 'Name' AND dn = 'New Name'), nm, (concat_ws(' / ', r::text, r2::text, fn, ln, dn))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C45 member whose only SCIM token is expired: refreshed$q$;
  BEGIN
    PERFORM pg_temp.asu(pg_temp.i('k5'));
    r := public.sync_profile_names_from_idp('New', 'Name', 'New Name');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k5'));
    rep := rep || pg_temp.ln(((r->>'success')::boolean AND (r->>'updated')::boolean AND r->>'skipped' IS NULL AND fn = 'New' AND ln = 'Name' AND dn = 'New Name'), nm, (concat_ws(' / ', r::text, r2::text, fn, ln, dn))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C45 member whose only SCIM token is revoked: refreshed$q$;
  BEGIN
    PERFORM pg_temp.asu(pg_temp.i('k6'));
    r := public.sync_profile_names_from_idp('New', 'Name', 'New Name');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k6'));
    rep := rep || pg_temp.ln(((r->>'success')::boolean AND (r->>'updated')::boolean AND r->>'skipped' IS NULL AND fn = 'New' AND ln = 'Name' AND dn = 'New Name'), nm, (concat_ws(' / ', r::text, r2::text, fn, ln, dn))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C46 member of a SCIM org and a manual org: sign-in skipped$q$;
  BEGIN
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k7'));
    t := ct;
    PERFORM pg_temp.asu(pg_temp.i('k7'));
    r := public.sync_profile_names_from_idp('New', 'Name', 'New Name');
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k7'));
    rep := rep || pg_temp.ln(((r->>'success')::boolean AND r->>'skipped' = 'directory_managed' AND fn = 'F-k7' AND ln = 'L-k7' AND dn = 'D-k7' AND ct = t), nm, (concat_ws(' / ', r::text, r2::text, fn, ln, dn))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C47 SCIM member, all-absent input: success, no error, unchanged$q$;
  BEGIN
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k1'));
    t := ct;
    PERFORM pg_temp.asu(pg_temp.i('k1'));
    r := public.sync_profile_names_from_idp(NULL, NULL, NULL);
    PERFORM pg_temp.pgr();
    SELECT * INTO fn, ln, dn, ct FROM pg_temp.nm(pg_temp.i('k1'));
    rep := rep || pg_temp.ln(((r->>'success')::boolean AND r->>'error' IS NULL AND fn = 'F-k1' AND ct = t), nm, (concat_ws(' / ', r::text, r2::text, fn, ln, dn))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C11 second run on the applied state is a no-op$q$;
  BEGIN
    BEGIN
      SELECT txt INTO t FROM guard3991;
      EXECUTE t;
      b := false;
    EXCEPTION WHEN raise_exception THEN b := true; t2 := SQLERRM;
    END;
    rep := rep || pg_temp.ln((NOT b), nm, (concat_ws(' / ', b, left(t2, 120)))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C11 foreign helper body aborts$q$;
  BEGIN
    EXECUTE $g$CREATE OR REPLACE FUNCTION public.member_status_grants_access(p_license_status text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path TO '' AS $b$ SELECT COALESCE(p_license_status IN ('active', 'unassigned'), false); $b$$g$;
    BEGIN
      SELECT txt INTO t FROM guard3991;
      EXECUTE t;
      b := false;
    EXCEPTION WHEN raise_exception THEN b := true; t2 := SQLERRM;
    END;
    rep := rep || pg_temp.ln((b), nm, (concat_ws(' / ', b, left(t2, 120)))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C11 JIT default true aborts$q$;
  BEGIN
    EXECUTE 'ALTER TABLE public.organizations ALTER COLUMN jit_provisioning_enabled SET DEFAULT true';
    BEGIN
      SELECT txt INTO t FROM guard3991;
      EXECUTE t;
      b := false;
    EXCEPTION WHEN raise_exception THEN b := true; t2 := SQLERRM;
    END;
    rep := rep || pg_temp.ln((b), nm, (concat_ws(' / ', b, left(t2, 120)))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C11 missing invited_first_name aborts$q$;
  BEGIN
    EXECUTE 'ALTER TABLE public.organization_members RENAME COLUMN invited_first_name TO invited_first_name_3991';
    BEGIN
      SELECT txt INTO t FROM guard3991;
      EXECUTE t;
      b := false;
    EXCEPTION WHEN raise_exception THEN b := true; t2 := SQLERRM;
    END;
    rep := rep || pg_temp.ln((b), nm, (concat_ws(' / ', b, left(t2, 120)))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  nm := $q$C11 a different body of this file's function aborts$q$;
  BEGIN
    EXECUTE $g$CREATE OR REPLACE FUNCTION public.org_names_directory_managed(p_org uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $b$ SELECT true $b$$g$;
    BEGIN
      SELECT txt INTO t FROM guard3991;
      EXECUTE t;
      b := false;
    EXCEPTION WHEN raise_exception THEN b := true; t2 := SQLERRM;
    END;
    rep := rep || pg_temp.ln((b), nm, (concat_ws(' / ', b, left(t2, 120)))::text);
    RAISE SQLSTATE 'P3991';
  EXCEPTION WHEN SQLSTATE 'P3991' THEN NULL;
    WHEN OTHERS THEN PERFORM pg_temp.pgr(); rep := rep || pg_temp.ln(false, nm, 'ERR ' || SQLSTATE || ' ' || SQLERRM);
  END;
  RETURN rep;
END
$run$;
DO $c$
DECLARE v_out text; v_nf int; v_np int; v_md5 text;
BEGIN
  SELECT string_agg(left(md5(prosrc), 8), ',' ORDER BY proname) INTO v_md5 FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN ('sync_profile_names_from_idp', 'org_names_directory_managed', 'set_member_name');
  v_out := pg_temp.run3991();
  SELECT count(*) FILTER (WHERE l LIKE 'FAIL|%'), count(*) FILTER (WHERE l LIKE 'PASS|%')
    INTO v_nf, v_np FROM regexp_split_to_table(v_out, E'\n') l;
  RAISE EXCEPTION 'REPORT 3991 CONTROLS (bodies %) red % / green % %', v_md5, v_nf, v_np, v_out;
END $c$;
