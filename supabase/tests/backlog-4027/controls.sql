-- BACKLOG-4027 PR-1 DB controls (IdP-owned roles, last active admin, the Exclude RPC).
-- (The Exclude RPC is deferred with group mapping, founder 2026-10-21.)
-- Venue: keepr-test, ONE call, ONE transaction ending in RAISE, so nothing persists. Run after
-- 20261021040000 is applied, or compose it in front (compose.py --with-migration).
-- __MODES__ is replaced with a comma list of quoted mode names. Each mode runs in its own
-- subtransaction: apply the mutation (exact-once replace that raises on 0 or 2+ matches; the md5
-- of pg_get_functiondef must change, else MUTATION NOT APPLIED), build fixtures, run every check,
-- roll back. 'base' = no mutation (every check must PASS).
-- Output: RAISE 'P4027_RESULT {mode: {mutation, pass, fail, reds}}'.
-- Fixtures: auth users p4027-*@example.test, organizations "P4027 *" (is_test). Every id is
-- generated at run time. provisioned_by 'directory_sync' is not storable yet (the CHECK lacks it,
-- BACKLOG-3523), so every IdP-provisioned fixture is 'scim'; the directory-sync side is jest (J2).

DO $drv$
DECLARE
  v_modes text[] := ARRAY[__MODES__]::text[];
  v_m text;
  v_mut text;
  v_res jsonb := '{}'::jsonb;
  v_r jsonb;
  v_detail text;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.as_user(u uuid) RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', u::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  END $b$$f$;

  -- a statement as an authenticated user: 'ok:<rows>' or 'ERR <sqlstate> <message>'
  EXECUTE $f$CREATE FUNCTION pg_temp.exec_as(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE n int;
  BEGIN
    BEGIN
      PERFORM pg_temp.as_user(u);
      EXECUTE 'SET LOCAL ROLE authenticated';
      EXECUTE q;
      GET DIAGNOSTICS n = ROW_COUNT;
      EXECUTE 'RESET ROLE';
      RETURN 'ok:' || n;
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
    END;
  END $b$$f$;

  -- a query returning one jsonb value as an authenticated user
  EXECUTE $f$CREATE FUNCTION pg_temp.call_as(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE v jsonb;
  BEGIN
    BEGIN
      PERFORM pg_temp.as_user(u);
      EXECUTE 'SET LOCAL ROLE authenticated';
      EXECUTE q INTO v;
      EXECUTE 'RESET ROLE';
      RETURN coalesce(v::text, 'null');
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
    END;
  END $b$$f$;

  -- a statement as the service role (SCIM / directory-sync / the portal's service client)
  EXECUTE $f$CREATE FUNCTION pg_temp.as_service(q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE n int;
  BEGIN
    BEGIN
      PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
      PERFORM set_config('request.jwt.claim.sub', '', true);
      EXECUTE 'SET LOCAL ROLE service_role';
      EXECUTE q;
      GET DIAGNOSTICS n = ROW_COUNT;
      EXECUTE 'RESET ROLE';
      RETURN 'ok:' || n;
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
    END;
  END $b$$f$;

  -- the RETURNING row of a service-role update (PostgREST .update().select()), as text
  EXECUTE $f$CREATE FUNCTION pg_temp.service_returning(q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE v jsonb;
  BEGIN
    BEGIN
      PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
      EXECUTE 'SET LOCAL ROLE service_role';
      EXECUTE q INTO v;
      EXECUTE 'RESET ROLE';
      RETURN coalesce(v::text, 'null');
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
    END;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.j(s text) RETURNS jsonb LANGUAGE plpgsql AS $b$
  BEGIN
    IF s IS NULL OR s LIKE 'ERR%' THEN RETURN '{}'::jsonb; END IF;
    RETURN s::jsonb;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.mut_fn(p_sig text, p_from text, p_to text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE d text; n int; d2 text; m1 text; m2 text;
  BEGIN
    d := pg_get_functiondef(to_regprocedure(p_sig));
    n := (length(d) - length(replace(d, p_from, ''))) / length(p_from);
    IF n <> 1 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: % matches in %', n, p_sig; END IF;
    m1 := md5(d);
    EXECUTE replace(d, p_from, p_to);
    d2 := pg_get_functiondef(to_regprocedure(p_sig)); m2 := md5(d2);
    IF m1 = m2 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: md5 unchanged for %', p_sig; END IF;
    RETURN 'MUTATION APPLIED ' || p_sig || ' ' || left(m1, 8) || '->' || left(m2, 8) || ' [' || left(p_to, 70) || ']';
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.pass(ok boolean, info text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || coalesce(left(info, 160), '') END
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.mem(o uuid, u uuid) RETURNS uuid LANGUAGE sql AS $b$
    SELECT m.id FROM public.organization_members m WHERE m.organization_id = o AND m.user_id = u
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.st(o uuid, u uuid) RETURNS text LANGUAGE sql AS $b$
    SELECT m.role || '/' || m.license_status FROM public.organization_members m WHERE m.organization_id = o AND m.user_id = u
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.logs(o uuid, a text) RETURNS int LANGUAGE sql AS $b$
    SELECT count(*)::int FROM public.billing_change_log b WHERE b.organization_id = o AND b.action = a
  $b$$f$;

  -- run q (kind exec | service | call), read the target's state, then roll both back:
  -- '<result>|<role/status or gone>'. A check that lets the write through cannot leak into the next.
  EXECUTE $f$CREATE FUNCTION pg_temp.rb(kind text, u uuid, q text, o uuid, tu uuid) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE d text;
  BEGIN
    BEGIN
      d := CASE kind WHEN 'exec' THEN pg_temp.exec_as(u, q) WHEN 'service' THEN pg_temp.as_service(q) ELSE pg_temp.call_as(u, q) END;
      d := d || '|' || coalesce(pg_temp.st(o, tu), 'gone');
      RAISE EXCEPTION 'RB_DONE' USING DETAIL = d;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'RB_DONE' THEN RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 60) || '|?'; END IF;
      GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL;
      RETURN d;
    END;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE
    im text := 'public._member_role_idp_managed(uuid)';
    gi text := 'public._guard_idp_role()';
    gl text := 'public._guard_last_admin()';
    d1 text; d2 text;
  BEGIN
    CASE m
    WHEN 'base' THEN RETURN 'none';
    -- M1: the last-admin count includes the row itself
    WHEN 'm1_count_includes_self' THEN RETURN pg_temp.mut_fn(gl,
      $q$_org_account_admin_member(OLD.organization_id, OLD.id)$q$, $q$_org_account_admin_member(OLD.organization_id, NULL)$q$);
    -- M2: a sync write to the last admin is refused instead of kept + logged
    WHEN 'm2_sync_refused' THEN RETURN pg_temp.mut_fn(gl,
      $q$IF TG_OP = 'UPDATE' AND v_role = 'service_role'$q$, $q$IF false AND v_role = 'service_role'$q$);
    -- M3: the per-member Exclude is ignored
    WHEN 'm3_exclude_ignored' THEN RETURN pg_temp.mut_fn(im,
      $q$       AND m.group_sync_enabled IS DISTINCT FROM false)$q$, ')');
    -- M4: the IdP guard keyed on current_user (misses every definer path)
    WHEN 'm4_idp_guard_current_user' THEN RETURN pg_temp.mut_fn(gi,
      $q$IF current_setting('role', true) IN ('authenticated', 'anon')$q$, $q$IF current_user IN ('authenticated', 'anon')$q$);
    -- M5 (most likely wrong build): service_role without the sync marker passes, so the rule is
    -- held by the app alone (deactivateUser writes with the service client)
    WHEN 'm5_service_role_passes' THEN RETURN pg_temp.mut_fn(gl,
      $q$IF v_role NOT IN ('authenticated', 'anon', 'service_role') THEN$q$, $q$IF v_role NOT IN ('authenticated', 'anon') THEN$q$);
    -- M5b: no database guard at all (the rule in the app only)
    WHEN 'm5b_no_db_guard' THEN RETURN pg_temp.mut_fn(gl,
      $q$  -- Only a row that is an active admin now$q$, $q$  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  -- Only a row that is an active admin now$q$);
    -- M6: the trigger watches role only
    WHEN 'm6_role_only' THEN
      d1 := (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE t.tgname = '_guard_last_admin_upd' AND t.tgrelid = 'public.organization_members'::regclass);
      EXECUTE 'CREATE OR REPLACE TRIGGER _guard_last_admin_upd BEFORE UPDATE OF role ON public.organization_members FOR EACH ROW EXECUTE FUNCTION public._guard_last_admin()';
      d2 := (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE t.tgname = '_guard_last_admin_upd' AND t.tgrelid = 'public.organization_members'::regclass);
      IF d1 IS NULL OR d1 = d2 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: trigger unchanged'; END IF;
      RETURN 'MUTATION APPLIED trigger _guard_last_admin_upd ' || left(md5(d1), 8) || '->' || left(md5(d2), 8) || ' [OF role]';
    -- M7: the provisioned_by term dropped (a manual member can become managed)
    WHEN 'm7_no_provisioned_by' THEN RETURN pg_temp.mut_fn(im,
      $q$       AND m.provisioned_by IN ('scim', 'directory_sync')
$q$, '');
    -- M8: an inactive identity provider still counts
    WHEN 'm8_no_is_active' THEN RETURN pg_temp.mut_fn(im,
      $q$       AND idp.is_active
$q$, '');
    -- M9: the string "true" counts as mapping on
    WHEN 'm9_string_true' THEN RETURN pg_temp.mut_fn(im,
      $q$(idp.attribute_mapping -> 'group_sync_enabled') = 'true'::jsonb$q$, $q$(idp.attribute_mapping ->> 'group_sync_enabled') = 'true'$q$);
    -- M10: no personal-organization exemption
    WHEN 'm10_no_personal_exempt' THEN RETURN pg_temp.mut_fn(gl,
      $q$po.personal_owner_user_id IS NOT NULL) THEN$q$, $q$po.personal_owner_user_id IS NOT NULL AND false) THEN$q$);
    -- M13: the IdP guard trigger watches nothing a client writes (guard removed)
    WHEN 'm13_no_idp_guard' THEN RETURN pg_temp.mut_fn(gi,
      $q$     AND public._member_role_idp_managed(OLD.id) THEN$q$, $q$     AND false THEN$q$);
    ELSE RAISE EXCEPTION 'unknown mode %', m;
    END CASE;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    o1 uuid := gen_random_uuid();  -- mapping on; one admin (u_a1, not billing contact); IT admin u_it1
    o2 uuid := gen_random_uuid();  -- mapping on; two admins (bulk shape)
    o3 uuid := gen_random_uuid();  -- mapping on but IdP inactive
    o4 uuid := gen_random_uuid();  -- mapping "true" as a JSON string
    o5 uuid := gen_random_uuid();  -- mapping OFF at provisioning time, then turned on (T11)
    op uuid := gen_random_uuid();  -- personal organization of u_p (admin row)
    u_a1 uuid := gen_random_uuid(); u_it1 uuid := gen_random_uuid(); u_s1 uuid := gen_random_uuid();
    u_x1 uuid := gen_random_uuid(); u_man1 uuid := gen_random_uuid(); u_ag1 uuid := gen_random_uuid();
    u_sit1 uuid := gen_random_uuid();
    u_a2 uuid := gen_random_uuid(); u_b2 uuid := gen_random_uuid();
    u_s3 uuid := gen_random_uuid(); u_s4 uuid := gen_random_uuid(); u_s5 uuid := gen_random_uuid(); u_s5f uuid := gen_random_uuid();
    u_a5 uuid := gen_random_uuid();
    u_p uuid := gen_random_uuid(); u_staff uuid := gen_random_uuid();
    s text; s2 text; v_ok boolean; v_inv uuid; n int;
    mapping_on text := '{"group_sync_enabled": true, "group_role_mapping": {"g-admin": "admin"}, "default_role": "agent"}';
  BEGIN
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT x, 'p4027-' || left(x::text, 8) || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM unnest(ARRAY[u_a1, u_it1, u_s1, u_x1, u_man1, u_ag1, u_sit1, u_a2, u_b2, u_s3, u_s4, u_s5, u_s5f, u_a5, u_p, u_staff]) x;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    SELECT x, (SELECT a.email FROM auth.users a WHERE a.id = x), 'email', x::text, 'P4027 ' || left(x::text, 4)
      FROM unnest(ARRAY[u_a1, u_it1, u_s1, u_x1, u_man1, u_ag1, u_sit1, u_a2, u_b2, u_s3, u_s4, u_s5, u_s5f, u_a5, u_p, u_staff]) x
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.internal_roles (user_id, role_id)
    SELECT u_staff, ar.id FROM public.admin_roles ar WHERE ar.slug = 'sales';
    INSERT INTO public.organizations (id, name, slug, max_seats, is_test)
    SELECT x, 'P4027 ' || left(x::text, 8), 'p4027-' || left(x::text, 8), 20, true FROM unnest(ARRAY[o1, o2, o3, o4, o5]) x;
    INSERT INTO public.organizations (id, name, slug, max_seats, is_test, personal_owner_user_id)
    VALUES (op, 'P4027 personal', 'p4027-p-' || left(op::text, 8), 1, true, u_p);

    -- members (as the database owner). provisioned_by: 'scim' = IdP-provisioned, NULL / 'invite' = manual.
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by, group_sync_enabled) VALUES
      (o1, u_a1,   'admin',    'active', now(), 'invite', false),  -- the only admin, manual
      (o1, u_it1,  'it_admin', 'active', now(), 'invite', false),  -- manual IT admin
      (o1, u_s1,   'agent',    'active', now(), 'scim',   true),   -- SCIM-provisioned agent: managed
      (o1, u_x1,   'agent',    'active', now(), 'scim',   false),  -- SCIM-provisioned, excluded
      (o1, u_man1, 'agent',    'active', now(), 'invite', false),  -- manual agent (decision A)
      (o1, u_ag1,  'agent',    'active', now(), NULL,     true),   -- manual row, flag set by hand
      (o1, u_sit1, 'it_admin', 'active', now(), 'scim',   true),   -- SCIM-provisioned IT admin
      (o2, u_a2,   'admin',    'active', now(), 'scim',   true),
      (o2, u_b2,   'admin',    'active', now(), 'scim',   true),
      (o3, u_s3,   'agent',    'active', now(), 'scim',   true),
      (o4, u_s4,   'agent',    'active', now(), 'scim',   true),
      (o5, u_a5,   'admin',    'active', now(), 'invite', false),
      (o5, u_s5,   'agent',    'active', now(), 'scim',   true),   -- W4 now writes true
      (o5, u_s5f,  'agent',    'active', now(), 'scim',   false),  -- what W4 wrote before (p.roleFromGroups)
      (op, u_p,    'admin',    'active', now(), NULL,     false);
    INSERT INTO public.organization_identity_providers (organization_id, provider_type, display_name, attribute_mapping, is_active) VALUES
      (o1, 'azure_ad', 'P4027 IdP', mapping_on::jsonb, true),
      (o2, 'azure_ad', 'P4027 IdP', mapping_on::jsonb, true),
      (o3, 'azure_ad', 'P4027 IdP inactive', mapping_on::jsonb, false),
      (o4, 'azure_ad', 'P4027 IdP string', '{"group_sync_enabled": "true"}'::jsonb, true),
      (o5, 'azure_ad', 'P4027 IdP off', '{"group_sync_enabled": false}'::jsonb, true);

    -- ===== the helper (decision A) =====
    r := r || jsonb_build_object('H1_scim_member_managed', pg_temp.pass(public._member_role_idp_managed(pg_temp.mem(o1, u_s1)), 'scim member not managed'));
    -- T0': a manual member is not managed with mapping on (red if a data step / NULL default ships)
    r := r || jsonb_build_object('T0_manual_member_not_managed', pg_temp.pass(
      NOT public._member_role_idp_managed(pg_temp.mem(o1, u_man1))
      AND pg_temp.exec_as(u_a1, format('UPDATE public.organization_members SET role = %L WHERE id = %L', 'broker', pg_temp.mem(o1, u_man1))) = 'ok:1',
      'manual: ' || public._member_role_idp_managed(pg_temp.mem(o1, u_man1))::text));
    -- T12a: a manual row with the flag set true by hand is still not managed (provisioned_by term)
    r := r || jsonb_build_object('T12a_manual_flag_true_not_managed', pg_temp.pass(
      NOT public._member_role_idp_managed(pg_temp.mem(o1, u_ag1)), 'manual row with flag true is managed'));
    r := r || jsonb_build_object('H2_inactive_idp_not_managed', pg_temp.pass(
      NOT public._member_role_idp_managed(pg_temp.mem(o3, u_s3)), 'inactive IdP manages'));
    r := r || jsonb_build_object('H3_string_true_not_managed', pg_temp.pass(
      NOT public._member_role_idp_managed(pg_temp.mem(o4, u_s4)), 'string "true" manages'));

    -- ===== T5 / T6: the IdP owns the role (client sessions) =====
    s := pg_temp.exec_as(u_a1, format('UPDATE public.organization_members SET role = %L WHERE id = %L', 'broker', pg_temp.mem(o1, u_s1)));
    r := r || jsonb_build_object('T5_client_change_managed_refused', pg_temp.pass(s LIKE 'ERR 42501 managed_by_idp%', s));
    s := pg_temp.exec_as(u_a1, format('UPDATE public.organization_members SET role = %L WHERE id = %L', 'broker', pg_temp.mem(o1, u_x1)));
    r := r || jsonb_build_object('T6_client_change_excluded_allowed', pg_temp.pass(s = 'ok:1' AND pg_temp.st(o1, u_x1) = 'broker/active', s));
    -- T5b: the same through a definer RPC (org_contact_save names an IT contact -> it_admin):
    -- its own refusal or the trigger; either way the role stays
    s := pg_temp.call_as(u_a1, format('SELECT public.org_contact_save(%L::uuid, %L::jsonb)', o1,
           json_build_object('role', 'it', 'member_id', pg_temp.mem(o1, u_s1), 'confirm_role_change', true)));
    r := r || jsonb_build_object('T5b_definer_rpc_role_change_refused', pg_temp.pass(
      pg_temp.st(o1, u_s1) = 'agent/active' AND (s LIKE '%managed_by_idp%'), s));

    -- ===== the last active admin =====
    -- T1: a sync demotes the last admin -> kept, idp_groups still written, one log row; the
    -- RETURNING row (what directory-sync's .update().select() reads) shows the kept values
    s := pg_temp.service_returning(format(
      'WITH u AS (UPDATE public.organization_members SET role = %L, idp_groups = ARRAY[%L], scim_synced_at = now() + interval %L WHERE id = %L RETURNING role, license_status) SELECT to_jsonb(u) FROM u',
      'agent', 'g-x', '1 second', pg_temp.mem(o1, u_a1)));
    r := r || jsonb_build_object('T1_sync_demote_last_admin_kept', pg_temp.pass(
      pg_temp.st(o1, u_a1) = 'admin/active'
      AND (SELECT idp_groups FROM public.organization_members WHERE id = pg_temp.mem(o1, u_a1)) = ARRAY['g-x']
      AND pg_temp.logs(o1, 'sync_change_skipped_last_admin') = 1
      AND pg_temp.j(s) = '{"role": "admin", "license_status": "active"}'::jsonb,
      s || ' ' || coalesce(pg_temp.st(o1, u_a1), '?') || ' logs=' || pg_temp.logs(o1, 'sync_change_skipped_last_admin')));
    UPDATE public.organization_members SET role = 'admin', license_status = 'active' WHERE id = pg_temp.mem(o1, u_a1);
    -- T2: a sync suspends the last admin -> stays active; no IdP-deprovision side effects
    s := pg_temp.as_service(format('UPDATE public.organization_members SET license_status = %L, scim_synced_at = now() + interval %L WHERE id = %L',
           'suspended', '2 seconds', pg_temp.mem(o1, u_a1)));
    r := r || jsonb_build_object('T2_sync_suspend_last_admin_kept', pg_temp.pass(
      s = 'ok:1' AND pg_temp.st(o1, u_a1) = 'admin/active' AND pg_temp.logs(o1, 'sync_change_skipped_last_admin') = 2
      AND NOT EXISTS (SELECT 1 FROM public.billing_change_log b WHERE b.organization_id = o1
                       AND b.action NOT IN ('sync_change_skipped_last_admin')),
      s || ' ' || coalesce(pg_temp.st(o1, u_a1), '?')));
    -- restore as the database owner (passes the guard), so one red does not cascade into the next
    UPDATE public.organization_members SET role = 'admin', license_status = 'active' WHERE id = pg_temp.mem(o1, u_a1);
    -- T3: a client (the IT admin) demotes the last admin -> last_admin
    s := pg_temp.rb('exec', u_it1, format('UPDATE public.organization_members SET role = %L WHERE id = %L', 'agent', pg_temp.mem(o1, u_a1)), o1, u_a1);
    r := r || jsonb_build_object('T3_client_demote_last_admin_refused', pg_temp.pass(s LIKE 'ERR P0001 last_admin%|admin/active', s));
    -- T3b (W11, deactivateUser): service_role suspend WITHOUT the sync marker -> last_admin
    s := pg_temp.rb('service', NULL, format('UPDATE public.organization_members SET license_status = %L, updated_at = now() WHERE id = %L',
           'suspended', pg_temp.mem(o1, u_a1)), o1, u_a1);
    r := r || jsonb_build_object('T3b_service_suspend_last_admin_refused', pg_temp.pass(s LIKE 'ERR P0001 last_admin%|admin/active', s));
    -- T3c: a client RPC that suspends (set_member_license, a definer RPC) -> last_admin or its own refusal
    s := pg_temp.rb('call', u_it1, format('SELECT public.set_member_license(%L::uuid, %L)', pg_temp.mem(o1, u_a1), 'unassign'), o1, u_a1);
    r := r || jsonb_build_object('T3c_definer_unassign_last_admin_refused', pg_temp.pass(s LIKE 'ERR P0001 last_admin%|admin/active', s));
    -- T8: a client removal of the last admin (not the billing contact) -> last_admin, exactly
    s := pg_temp.rb('exec', u_it1, format('DELETE FROM public.organization_members WHERE id = %L', pg_temp.mem(o1, u_a1)), o1, u_a1);
    r := r || jsonb_build_object('T8_client_remove_last_admin_refused', pg_temp.pass(s LIKE 'ERR P0001 last_admin%|admin/active', s));
    -- T10: the database owner demotes the last admin -> passes (support / migrations)
    BEGIN
      UPDATE public.organization_members SET role = 'agent' WHERE id = pg_temp.mem(o1, u_a1);
      v_ok := pg_temp.st(o1, u_a1) = 'agent/active';
      RAISE EXCEPTION 'T10_DONE';
    EXCEPTION WHEN OTHERS THEN
      r := r || jsonb_build_object('T10_owner_passes', pg_temp.pass(SQLERRM = 'T10_DONE' AND v_ok, SQLERRM));
    END;
    -- T8b: a privileged removal (cascade shape: service role) -> passes
    BEGIN
      s := pg_temp.as_service(format('DELETE FROM public.organization_members WHERE id = %L', pg_temp.mem(o1, u_a1)));
      RAISE EXCEPTION 'T8B_DONE' USING DETAIL = s;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS s2 = PG_EXCEPTION_DETAIL;
      r := r || jsonb_build_object('T8b_privileged_remove_passes', pg_temp.pass(SQLERRM = 'T8B_DONE' AND s2 = 'ok:1', SQLERRM || ' ' || coalesce(s2, '')));
    END;

    -- T4: a sync demotes an admin who is not the last -> goes through
    s := pg_temp.as_service(format('UPDATE public.organization_members SET role = %L, scim_synced_at = now() + interval %L WHERE id = %L',
           'agent', '3 seconds', pg_temp.mem(o2, u_b2)));
    r := r || jsonb_build_object('T4_sync_demote_not_last_applies', pg_temp.pass(s = 'ok:1' AND pg_temp.st(o2, u_b2) = 'agent/active'
      AND pg_temp.logs(o2, 'sync_change_skipped_last_admin') = 0, s || ' ' || pg_temp.st(o2, u_b2)));
    -- T7: one statement demoting both admins (bulkUpdateRole's shape) -> last_admin
    UPDATE public.organization_members SET role = 'admin', group_sync_enabled = false WHERE organization_id = o2;
    s := pg_temp.exec_as(u_a2, format('UPDATE public.organization_members SET role = %L WHERE organization_id = %L AND id IN (%L, %L)',
           'agent', o2, pg_temp.mem(o2, u_a2), pg_temp.mem(o2, u_b2)));
    r := r || jsonb_build_object('T7_bulk_demote_all_admins_refused', pg_temp.pass(s LIKE 'ERR P0001 last_admin%'
      AND pg_temp.st(o2, u_a2) = 'admin/active' AND pg_temp.st(o2, u_b2) = 'admin/active', s));

    -- T9: joining a brokerage retires the joiner's personal admin row inside their own session
    INSERT INTO public.organization_members (organization_id, role, license_status, invited_email, provisioned_by)
    VALUES (o5, 'agent', 'pending', (SELECT email FROM auth.users WHERE id = u_p), 'invite') RETURNING id INTO v_inv;
    CREATE FUNCTION public._p4027_accept(p_id uuid, p_user uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO '' AS $a$
      UPDATE public.organization_members SET user_id = p_user, license_status = 'active', joined_at = now(), invitation_token = NULL WHERE id = p_id;
    $a$;
    s := pg_temp.call_as(u_p, format('SELECT to_jsonb(public._p4027_accept(%L::uuid, %L::uuid))', v_inv, u_p));
    r := r || jsonb_build_object('T9_join_retires_personal_admin', pg_temp.pass(
      s NOT LIKE 'ERR%' AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = op), s));
    DROP FUNCTION public._p4027_accept(uuid, uuid);

    -- ===== T11: a SCIM member provisioned while mapping was off becomes managed when it turns on =====
    UPDATE public.organization_identity_providers SET attribute_mapping = mapping_on::jsonb WHERE organization_id = o5;
    r := r || jsonb_build_object('T11_scim_member_managed_after_mapping_on', pg_temp.pass(
      public._member_role_idp_managed(pg_temp.mem(o5, u_s5)), 'scim member (flag true) not managed'));
    -- T11b: the old W4 write (flag false) would leave them unmanaged: the reason W4 writes true
    r := r || jsonb_build_object('T11b_old_w4_flag_false_unmanaged', pg_temp.pass(
      NOT public._member_role_idp_managed(pg_temp.mem(o5, u_s5f)), 'flag false managed'));

    -- T13f: grants: no client role executes the guard or the helper; a direct client write of the
    -- member flag is refused (guard_invite_acceptance, unchanged)
    r := r || jsonb_build_object('T13f_grants', pg_temp.pass(
      NOT has_function_privilege('authenticated', 'public._guard_last_admin()', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public._guard_last_admin()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public._guard_idp_role()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public._member_role_idp_managed(uuid)', 'EXECUTE')
      AND pg_temp.exec_as(u_a1, format('UPDATE public.organization_members SET group_sync_enabled = false WHERE id = %L', pg_temp.mem(o1, u_s1))) LIKE 'ERR 42501%',
      'grants'));

    RETURN r;
  END $b$$f$;

  FOREACH v_m IN ARRAY v_modes LOOP
    BEGIN
      v_mut := pg_temp.apply_mode(v_m);
      v_r := pg_temp.run();
      RAISE EXCEPTION 'MODE_DONE' USING DETAIL = (jsonb_build_object('mutation', v_mut, 'checks', v_r))::text;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'MODE_DONE' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        v_r := v_detail::jsonb;
        v_res := v_res || jsonb_build_object(v_m, jsonb_build_object(
          'mutation', v_r->'mutation',
          'pass', (SELECT count(*) FROM jsonb_each_text(v_r->'checks') e WHERE e.value = 'PASS'),
          'fail', (SELECT count(*) FROM jsonb_each_text(v_r->'checks') e WHERE e.value <> 'PASS'),
          'reds', CASE WHEN v_m = 'base' THEN (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r->'checks') e WHERE e.value <> 'PASS')
                       ELSE (SELECT coalesce(jsonb_agg(e.key ORDER BY e.key), '[]'::jsonb) FROM jsonb_each_text(v_r->'checks') e WHERE e.value <> 'PASS') END));
      ELSE
        v_res := v_res || jsonb_build_object(v_m, 'ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 300));
      END IF;
    END;
  END LOOP;
  RAISE EXCEPTION 'P4027_RESULT %', v_res;
END
$drv$;
