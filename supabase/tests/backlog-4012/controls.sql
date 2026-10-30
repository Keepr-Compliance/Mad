-- BACKLOG-4012 controls. keepr-test, one call, ends in RAISE: nothing persists.
-- Run against the applied migration, or compose it in front (compose.py --with-migration). Each mode: own subtransaction (mutation + fixtures + checks), rolled back.
DO $drv$
DECLARE
  v_modes text[] := ARRAY[__MODES__]::text[];
  v_m text;
  v_res jsonb := '{}'::jsonb;
  v_txt text;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.as_user(u uuid) RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated',
      'session_id', (SELECT s.id FROM auth.sessions s WHERE s.user_id = u ORDER BY s.created_at DESC LIMIT 1))::text, true);
    PERFORM set_config('request.jwt.claim.sub', u::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  END $b$$f$;
  -- run q as role r (authenticated: with user u); 'OK <json>' or 'ERR <state> <msg>'
  EXECUTE $f$CREATE FUNCTION pg_temp.run_as(r text, u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE v text;
  BEGIN
    BEGIN
      IF u IS NOT NULL THEN PERFORM pg_temp.as_user(u); END IF;
      IF r IS NOT NULL THEN EXECUTE 'SET LOCAL ROLE ' || r; END IF;
      EXECUTE q INTO v;
      EXECUTE 'RESET ROLE';
      RETURN 'OK ' || coalesce(v, 'null');
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 60);
    END;
  END $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.mut_fn(p_sig text, p_from text, p_to text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE d text; n int; m1 text; m2 text;
  BEGIN
    d := pg_get_functiondef(to_regprocedure(p_sig));
    n := (length(d) - length(replace(d, p_from, ''))) / length(p_from);
    IF n <> 1 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: % matches in %', n, p_sig; END IF;
    m1 := md5(d);
    EXECUTE replace(d, p_from, p_to);
    m2 := md5(pg_get_functiondef(to_regprocedure(p_sig)));
    IF m1 = m2 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: md5 unchanged %', p_sig; END IF;
    RETURN 'MUTATION APPLIED ' || p_sig || ' ' || left(m1, 8) || '->' || left(m2, 8);
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.cfa(u uuid, o uuid, k text) RETURNS boolean LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM pg_temp.as_user(u);
    RETURN (public.check_feature_access(o, k) ->> 'allowed')::boolean;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE
    g text := 'public._billing_guard_idp_join_while_setup_pending()';
    p text := 'public._billing_org_join_blocked(uuid)';
    h text := 'public._billing_org_setup_pending(uuid)';
    j text := 'public.jit_join_organization(text,text)';
  BEGIN
    CASE m
    WHEN 'base' THEN RETURN 'none';
    WHEN 'guard_uses_member_origin_is_idp' THEN RETURN pg_temp.mut_fn(g,
      $q$IF NOT coalesce(NEW.provisioned_by IN ('jit', 'scim', 'directory_sync'), false) THEN$q$,
      $q$IF NOT public.member_origin_is_idp(NEW.provisioned_by) THEN$q$);
    WHEN 'guard_uses_member_origin_joins_unlicensed' THEN RETURN pg_temp.mut_fn(g,
      $q$IF NOT coalesce(NEW.provisioned_by IN ('jit', 'scim', 'directory_sync'), false) THEN$q$,
      $q$IF NOT public.member_origin_joins_unlicensed(NEW.provisioned_by) THEN$q$);
    WHEN 'copy_3853_verbatim' THEN RETURN pg_temp.mut_fn(g,
      $q$IF NOT coalesce(NEW.provisioned_by IN ('jit', 'scim', 'directory_sync'), false) THEN$q$,
      $q$IF false THEN$q$) || ' + ' || pg_temp.mut_fn(g,
      $q$  IF TG_OP = 'INSERT'
     OR NEW.organization_id$q$,
      $q$  IF TG_OP = 'INSERT' OR (OLD.user_id IS NULL AND NEW.user_id IS NOT NULL)
     OR NEW.organization_id$q$);
    WHEN 'guard_copies_3853_claim_rule' THEN RETURN pg_temp.mut_fn(g,
      $q$  IF TG_OP = 'INSERT'
     OR NEW.organization_id$q$,
      $q$  IF TG_OP = 'INSERT' OR (OLD.user_id IS NULL AND NEW.user_id IS NOT NULL)
     OR NEW.organization_id$q$);
    WHEN 'guard_without_provisioned_by_filter' THEN RETURN pg_temp.mut_fn(g,
      $q$IF NOT coalesce(NEW.provisioned_by IN ('jit', 'scim', 'directory_sync'), false) THEN$q$,
      $q$IF false THEN$q$);
    WHEN 'reactivation_any_writer' THEN RETURN pg_temp.mut_fn(g,
      $q$OR (current_user = 'service_role'
         AND$q$, $q$OR (true
         AND$q$);
    WHEN 'no_zero_bypass' THEN RETURN pg_temp.mut_fn(p,
      $q$AND (NOT EXISTS (SELECT 1 FROM public.org_deal_lines l WHERE l.organization_id = p_org)
          OR EXISTS$q$, $q$AND (true
          OR EXISTS$q$);
    WHEN 'no_lines_counts_as_free' THEN RETURN pg_temp.mut_fn(p,
      $q$AND (NOT EXISTS (SELECT 1 FROM public.org_deal_lines l WHERE l.organization_id = p_org)
          OR EXISTS$q$, $q$AND (false
          OR EXISTS$q$);
    WHEN 'any_zero_line_is_free' THEN RETURN pg_temp.mut_fn(p,
      $q$OR EXISTS (SELECT 1 FROM public.org_deal_lines l
                      WHERE l.organization_id = p_org AND l.unit_price_cents > 0))$q$,
      $q$OR NOT EXISTS (SELECT 1 FROM public.org_deal_lines l
                      WHERE l.organization_id = p_org AND l.unit_price_cents = 0))$q$);
    WHEN 'ignores_deal_status' THEN RETURN pg_temp.mut_fn(p,
      $q$WHERE d.organization_id = p_org AND d.status = 'draft')$q$, $q$WHERE d.organization_id = p_org)$q$);
    WHEN 'helper_4007_old_body' THEN RETURN pg_temp.mut_fn(h,
      $q$SELECT public._billing_org_join_blocked(p_org)$q$,
      $q$SELECT EXISTS (SELECT 1 FROM public.org_deals d WHERE d.organization_id = p_org AND d.status = 'draft')$q$);
    WHEN 'jit_no_identity_binding' THEN RETURN pg_temp.mut_fn(j,
      $q$
     AND lower(i.identity_data -> 'custom_claims' ->> v_claim) = v_ident$q$, '');
    WHEN 'jit_no_freshness' THEN RETURN pg_temp.mut_fn(j,
      $q$  IF v_signin_at IS NULL
     OR v_identity_at IS NULL
     OR v_identity_at < v_signin_at - interval '60 seconds' THEN$q$, '  IF false THEN');
    WHEN 'jit_freshness_no_identity_clause' THEN RETURN pg_temp.mut_fn(j,
      $q$
     OR v_identity_at < v_signin_at - interval '60 seconds' THEN$q$, ' THEN');
    WHEN 'jit_freshness_no_window' THEN RETURN pg_temp.mut_fn(j,
      $q$
     AND c.updated_at > now() - interval '15 minutes';$q$, ';');
    WHEN 'jit_freshness_any_method' THEN RETURN pg_temp.mut_fn(j,
      $q$
     AND c.authentication_method = 'oauth'$q$, '');
    WHEN 'f1_drop_override' THEN RETURN pg_temp.mut_fn('public._org_feature_allowed(uuid,text)',
      $q$  IF v_override IS NOT NULL
     AND NOT public._override_above_tier(p_key, v_feature.min_tier, v_plan.tier, v_override) THEN$q$, '  IF false THEN');
    WHEN 'jit_no_feature_check' THEN RETURN pg_temp.mut_fn(j,
      $q$     OR NOT public._org_feature_allowed(v_org.id, 'jit_provisioning') THEN$q$, ' THEN');
    WHEN 'jit_no_column_check' THEN RETURN pg_temp.mut_fn(j,
      $q$IF NOT coalesce(v_org.jit_provisioning_enabled, false)
     OR$q$, 'IF');
    WHEN 'jit_role_unclamped' THEN RETURN pg_temp.mut_fn(j,
      $q$WHEN v_org.default_member_role IN ('agent', 'broker')$q$, $q$WHEN true$q$);
    WHEN 'jit_no_pending_return' THEN RETURN pg_temp.mut_fn(j,
      $q$IF public._billing_org_join_blocked(v_org.id) THEN$q$, 'IF false THEN');
    END CASE;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.checks() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb; s text;
    o_paid uuid := gen_random_uuid(); o_free uuid := gen_random_uuid(); o_none uuid := gen_random_uuid();
    o_act uuid := gen_random_uuid(); o_nol uuid := gen_random_uuid(); o_nofeat uuid := gen_random_uuid();
    o_coloff uuid := gen_random_uuid(); o_adm uuid := gen_random_uuid(); o_g uuid := gen_random_uuid(); o_mix uuid := gen_random_uuid();
    u uuid[] := ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 40));
    v_team uuid := (SELECT id FROM public.plans WHERE tier = 'team' LIMIT 1);
    t text[] := ARRAY(SELECT gen_random_uuid()::text FROM generate_series(1, 10));
    o_j11 uuid := gen_random_uuid();
    n int;
    v_pairs_bad int;
    v_m_txt text;
  BEGIN
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT x, 'p4012-' || left(x::text, 8) || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"azure"}', '{}', now(), now() FROM unnest(u) x;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id)
    SELECT x, 'p4012-' || left(x::text, 8) || '@example.test', 'azure', 'p4012-' || x FROM unnest(u) x
    ON CONFLICT (id) DO NOTHING;
    -- azure identities: u[20+k] carries tenant t[k]; u[29] attacker carries t[9] only
    INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
    SELECT 'p4012-oid-' || k, u[20 + k], jsonb_build_object('sub', 'p4012-' || k, 'custom_claims', jsonb_build_object('tid', t[k])), 'azure', now(), now()
      FROM generate_series(1, 9) k;
    UPDATE auth.users SET raw_user_meta_data = jsonb_build_object('custom_claims', jsonb_build_object('tid', t[3])) WHERE id = u[29];
    INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
    VALUES ('p4012-g', u[19], '{"sub":"p4012-g","custom_claims":{"hd":"p4012.example.test"}}', 'google', now(), now());
    -- every honest caller (u19-u29, attacker u29 included) has a session with a fresh OAuth sign-in
    INSERT INTO auth.sessions (id, user_id, created_at, updated_at, aal)
    SELECT gen_random_uuid(), x, now(), now(), 'aal1' FROM unnest(u[19:29]) x;
    INSERT INTO auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method)
    SELECT gen_random_uuid(), s.id, now(), now(), 'oauth' FROM auth.sessions s WHERE s.user_id = ANY (u[19:29]);
    -- J11 (SR probe): tenant t[10]. u30 password session + identity last written 90 days ago;
    -- u34 OAuth sign-in 20 minutes ago (outside the window); u35 fresh OAuth claim (another
    -- provider) but the tenant identity is 90 days old; u36 no session at all; u37 fresh OAuth
    -- session but a stale 'password' identity time cannot rescue a password-only session.
    INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
    SELECT 'p4012-j11-' || x.k, u[x.k], jsonb_build_object('sub', 'p4012-j11-' || x.k, 'custom_claims', jsonb_build_object('tid', t[10])), 'azure',
           now() - interval '200 days', now() - x.age
      FROM (VALUES (30, interval '90 days'), (34, interval '20 minutes'), (35, interval '90 days'), (36, interval '0'), (37, interval '0')) x(k, age);
    INSERT INTO auth.sessions (id, user_id, created_at, updated_at, aal)
    SELECT gen_random_uuid(), x, now(), now(), 'aal1' FROM unnest(ARRAY[u[30], u[34], u[35], u[37]]) x;
    INSERT INTO auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method)
    SELECT gen_random_uuid(), s.id, now() - x.age, now() - x.age, x.m
      FROM (VALUES (30, interval '0', 'password'), (34, interval '20 minutes', 'oauth'), (35, interval '0', 'oauth'), (37, interval '0', 'password')) x(k, age, m)
      JOIN auth.sessions s ON s.user_id = u[x.k];

    INSERT INTO public.organizations (id, name, slug, max_seats, is_test, microsoft_tenant_id, jit_provisioning_enabled, default_member_role)
    SELECT o, 'P4012 ' || left(o::text, 8), 'p4012-' || left(o::text, 8), 10, true, tid, col, rl
      FROM (VALUES (o_paid, t[1], true, 'agent'), (o_free, t[2], true, 'agent'), (o_none, t[3], true, 'agent'),
                   (o_act, t[4], true, 'agent'), (o_nol, t[5], true, 'agent'), (o_nofeat, t[6], true, 'agent'),
                   (o_coloff, t[7], false, 'agent'), (o_adm, t[8], true, 'admin'), (o_g, NULL, true, 'agent'), (o_mix, NULL, true, 'agent'),
                   (o_j11, t[10], true, 'agent')) v(o, tid, col, rl);
    UPDATE public.organizations SET google_domain = 'p4012.example.test' WHERE id = o_g;
    INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
    SELECT o, v_team, CASE WHEN o = o_nofeat THEN '{}'::jsonb ELSE '{"jit_provisioning":{"enabled":true}}'::jsonb END
      FROM unnest(ARRAY[o_paid, o_free, o_none, o_act, o_nol, o_nofeat, o_coloff, o_adm, o_g, o_j11]) o;

    -- members that exist before the deal (u1 admin of o_paid, u2 admin of o_free, u3/u4 scim in o_paid)
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at) VALUES
      (o_paid, u[1], 'admin', 'active', now()), (o_free, u[2], 'admin', 'active', now());
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by) VALUES
      (o_paid, u[3], 'agent', 'active', now(), 'scim'), (o_paid, u[4], 'agent', 'active', now(), 'scim'),
      (o_paid, u[31], 'agent', 'active', now(), 'scim');
    UPDATE public.organization_members SET license_status = 'suspended' WHERE organization_id = o_paid AND user_id IN (u[3], u[4], u[31]);
    -- two unclaimed staff invites in o_paid
    INSERT INTO public.organization_members (organization_id, invited_email, role, license_status, provisioned_by, invitation_token, invitation_expires_at) VALUES
      (o_paid, 'p4012-inv1@example.test', 'broker', 'pending', 'invite', 'p4012-tok1-' || o_paid, now() + interval '7 days'),
      (o_paid, 'p4012-inv2@example.test', 'agent', 'pending', 'invite', 'p4012-tok2-' || o_paid, now() + interval '7 days'),
      (o_paid, 'p4012-' || left(u[32]::text, 8) || '@example.test', 'agent', 'pending', 'invite', 'p4012-tok4-' || o_paid, now() + interval '7 days');

    -- deals
    INSERT INTO public.org_deals (organization_id, stripe_mode, seats, status)
    VALUES (o_paid, 'test', 5, 'draft'), (o_free, 'test', 5, 'draft'), (o_act, 'test', 5, 'active'), (o_nol, 'test', 5, 'draft'), (o_mix, 'test', 5, 'draft');
    INSERT INTO public.price_book_items (key, label) VALUES ('p4012_addon', 'P4012 add-on') ON CONFLICT (key) DO NOTHING;
    INSERT INTO public.org_deal_lines (organization_id, item_key, quantity_rule, unit_price_cents, list_price_cents_at_save)
    VALUES (o_mix, 'brokerage_seat', 'seats', 0, 2499), (o_mix, 'p4012_addon', 'one', 500, 500);
    INSERT INTO public.org_deal_lines (organization_id, item_key, quantity_rule, unit_price_cents, list_price_cents_at_save)
    VALUES (o_paid, 'brokerage_seat', 'seats', 2499, 2499), (o_free, 'brokerage_seat', 'seats', 0, 2499),
           (o_act, 'brokerage_seat', 'seats', 2499, 2499);

    -- C1-C3 IdP inserts into a paid waiting org (postgres = definer owner, the JIT writer's role)
    s := pg_temp.run_as(NULL, NULL, format($q$INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by) VALUES (%L, %L, 'agent', 'active', now(), 'jit') RETURNING license_status$q$, o_paid, u[5]));
    r := r || jsonb_build_object('C1_jit_insert_paid_draft_refused', CASE WHEN s LIKE 'ERR P0001 billing_setup_incomplete%' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.run_as('service_role', NULL, format($q$INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by) VALUES (%L, %L, 'agent', 'active', now(), 'scim') RETURNING license_status$q$, o_paid, u[6]));
    r := r || jsonb_build_object('C2_scim_insert_paid_draft_refused', CASE WHEN s LIKE 'ERR P0001 billing_setup_incomplete%' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.run_as('service_role', NULL, format($q$INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by) VALUES (%L, %L, 'agent', 'active', now(), 'directory_sync') RETURNING license_status$q$, o_paid, u[7]));
    r := r || jsonb_build_object('C3_dirsync_insert_paid_draft_refused', CASE WHEN s LIKE 'ERR P0001 billing_setup_incomplete%' THEN 'PASS' ELSE 'FAIL ' || s END);
    -- C4 reactivation by the sync writer (service_role) refused; C4b by a definer path (set_member_license runs as owner) allowed
    s := pg_temp.run_as('service_role', NULL, format($q$UPDATE public.organization_members SET license_status = 'active' WHERE organization_id = %L AND user_id = %L RETURNING license_status$q$, o_paid, u[3]));
    r := r || jsonb_build_object('C4_scim_reactivation_service_role_refused', CASE WHEN s LIKE 'ERR P0001 billing_setup_incomplete%' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.run_as(NULL, NULL, format($q$UPDATE public.organization_members SET license_status = 'active' WHERE organization_id = %L AND user_id = %L RETURNING license_status$q$, o_paid, u[4]));
    r := r || jsonb_build_object('C4b_definer_reactivation_allowed', CASE WHEN s LIKE 'OK %' THEN 'PASS' ELSE 'FAIL ' || s END);
    -- C5 invite-link acceptance (accept_invitation shape: definer, provisioned_by stays 'invite')
    s := pg_temp.run_as(NULL, NULL, format($q$UPDATE public.organization_members SET user_id = %L, license_status = 'active', joined_at = now(), invitation_token = NULL WHERE organization_id = %L AND invited_email = 'p4012-inv1@example.test' RETURNING license_status$q$, u[8], o_paid));
    r := r || jsonb_build_object('C5_invite_acceptance_allowed', CASE WHEN s LIKE 'OK %' THEN 'PASS' ELSE 'FAIL ' || s END);
    -- C6 SCIM claims a staff invite (users.ts:174-190 shape, service_role)
    s := pg_temp.run_as('service_role', NULL, format($q$UPDATE public.organization_members SET user_id = %L, license_status = 'active', provisioned_by = 'scim', provisioned_at = now(), joined_at = now(), invitation_token = NULL WHERE organization_id = %L AND invited_email = 'p4012-inv2@example.test' AND user_id IS NULL RETURNING license_status$q$, u[9], o_paid));
    r := r || jsonb_build_object('C6_scim_invite_claim_allowed', CASE WHEN s LIKE 'OK %' THEN 'PASS' ELSE 'FAIL ' || s END);
    -- C7-C10 the predicate across deal shapes (JIT-origin insert as owner)
    s := pg_temp.run_as(NULL, NULL, format($q$INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by) VALUES (%L, %L, 'agent', 'active', now(), 'jit') RETURNING license_status$q$, o_free, u[10]));
    r := r || jsonb_build_object('C7_zero_dollar_draft_allowed', CASE WHEN s LIKE 'OK %' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.run_as(NULL, NULL, format($q$INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by) VALUES (%L, %L, 'agent', 'active', now(), 'jit') RETURNING license_status$q$, o_none, u[11]));
    r := r || jsonb_build_object('C8_no_deal_allowed', CASE WHEN s LIKE 'OK %' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.run_as(NULL, NULL, format($q$INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by) VALUES (%L, %L, 'agent', 'active', now(), 'jit') RETURNING license_status$q$, o_act, u[12]));
    r := r || jsonb_build_object('C9_active_deal_allowed', CASE WHEN s LIKE 'OK %' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.run_as(NULL, NULL, format($q$INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by) VALUES (%L, %L, 'agent', 'active', now(), 'jit') RETURNING license_status$q$, o_nol, u[13]));
    r := r || jsonb_build_object('C10_draft_without_lines_refused', CASE WHEN s LIKE 'ERR P0001 billing_setup_incomplete%' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.run_as(NULL, NULL, format($q$INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by) VALUES (%L, %L, 'agent', 'active', now(), 'jit') RETURNING license_status$q$, o_mix, u[15]));
    r := r || jsonb_build_object('C10b_free_seat_plus_paid_line_refused', CASE WHEN s LIKE 'ERR P0001 billing_setup_incomplete%' THEN 'PASS' ELSE 'FAIL ' || s END);
    -- C11 the 4007 invite helper honours the $0 bypass
    s := pg_temp.run_as('authenticated', u[2], format($q$SELECT public._billing_org_setup_pending(%L)::text$q$, o_free));
    r := r || jsonb_build_object('C11a_4007_helper_zero_dollar_false', CASE WHEN s = 'OK false' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.run_as('authenticated', u[1], format($q$SELECT public._billing_org_setup_pending(%L)::text$q$, o_paid));
    r := r || jsonb_build_object('C11b_4007_helper_paid_true', CASE WHEN s = 'OK true' THEN 'PASS' ELSE 'FAIL ' || s END);
    -- C12 staff invite insert (admin_invite_user shape) and C13 manual claimed insert pass
    s := pg_temp.run_as(NULL, NULL, format($q$INSERT INTO public.organization_members (organization_id, invited_email, role, license_status, provisioned_by, invitation_token) VALUES (%L, 'p4012-inv3@example.test', 'agent', 'pending', 'invite', 'p4012-tok3-' || %L) RETURNING license_status$q$, o_paid, o_paid));
    r := r || jsonb_build_object('C12_staff_invite_insert_allowed', CASE WHEN s LIKE 'OK %' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.run_as(NULL, NULL, format($q$INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by) VALUES (%L, %L, 'agent', 'active', now(), 'manual') RETURNING license_status$q$, o_paid, u[14]));
    r := r || jsonb_build_object('C13_manual_insert_allowed', CASE WHEN s LIKE 'OK %' THEN 'PASS' ELSE 'FAIL ' || s END);
    -- C4c the broker admin's real set_member_license reactivates a SCIM member while setup waits
    s := pg_temp.run_as('authenticated', u[1], format($q$SELECT public.set_member_license((SELECT id FROM public.organization_members WHERE organization_id = %L AND user_id = %L), 'reactivate')::text$q$, o_paid, u[31]));
    SELECT string_agg(license_status, ',') INTO v_m_txt FROM public.organization_members WHERE organization_id = o_paid AND user_id = u[31];
    r := r || jsonb_build_object('C4c_real_set_member_license_reactivates', CASE WHEN s LIKE '%"success": true%' AND v_m_txt = 'active' THEN 'PASS' ELSE 'FAIL ' || s || ' ' || coalesce(v_m_txt, '-') END);
    -- C5b the real accept_invitation, from the invitation link, while setup waits
    s := pg_temp.run_as('authenticated', u[32], format($q$SELECT public.accept_invitation('p4012-tok4-' || %L)::text$q$, o_paid));
    SELECT count(*) INTO n FROM public.organization_members WHERE organization_id = o_paid AND user_id = u[32];
    r := r || jsonb_build_object('C5b_real_accept_invitation_allowed', CASE WHEN s LIKE '%"success": true%' AND n = 1 THEN 'PASS' ELSE 'FAIL ' || s || ' rows=' || n END);
    -- C14 a client session cannot write an IdP-origin row into a waiting brokerage. In a fresh
    -- transaction the refusal is 42501 (the helper is not granted to authenticated: c14.sql);
    -- here plpgsql has already run the trigger as the owner in this transaction, so the cached
    -- expression skips the EXECUTE check and the trigger's own P0001 answers. Either is a refusal.
    s := pg_temp.run_as('authenticated', u[33], format($q$INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by) VALUES (%L, %L, 'agent', 'active', now(), 'jit') RETURNING license_status$q$, o_paid, u[33]));
    r := r || jsonb_build_object('C14_client_idp_insert_refused', CASE WHEN s LIKE 'ERR 42501%' OR s LIKE 'ERR P0001 billing_setup_incomplete%' THEN 'PASS' ELSE 'FAIL ' || s END);

    -- J: the restored RPC, called as each user over the authenticated role
    s := pg_temp.run_as('authenticated', u[21], format($q$SELECT public.jit_join_organization('azure_ad', %L)::text$q$, t[1]));
    SELECT count(*) INTO n FROM public.organization_members WHERE organization_id = o_paid AND user_id = u[21];
    r := r || jsonb_build_object('J1_paid_draft_clean_refusal_no_row', CASE WHEN s LIKE '%billing_setup_pending%' AND s LIKE 'OK %' AND n = 0 THEN 'PASS' ELSE 'FAIL ' || s || ' rows=' || n END);
    s := pg_temp.run_as('authenticated', u[22], format($q$SELECT public.jit_join_organization('azure_ad', %L)::text$q$, upper(t[2])));
    SELECT string_agg(license_status || '/' || role, ',') INTO v_m_txt FROM public.organization_members WHERE organization_id = o_free AND user_id = u[22];
    r := r || jsonb_build_object('J2_zero_dollar_joins_active_agent', CASE WHEN s LIKE '%"success": true%' AND v_m_txt = 'active/agent' THEN 'PASS' ELSE 'FAIL ' || s || ' ' || coalesce(v_m_txt, '-') END);
    s := pg_temp.run_as('authenticated', u[29], format($q$SELECT public.jit_join_organization('azure_ad', %L)::text$q$, t[3]));
    SELECT count(*) INTO n FROM public.organization_members WHERE organization_id = o_none AND user_id = u[29];
    r := r || jsonb_build_object('J3_foreign_tenant_refused_metadata_ignored', CASE WHEN s LIKE '%identity_mismatch%' AND n = 0 THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.run_as('authenticated', u[26], format($q$SELECT public.jit_join_organization('azure_ad', %L)::text$q$, t[6]));
    r := r || jsonb_build_object('J4_feature_off_refused', CASE WHEN s LIKE '%jit_disabled%' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.run_as('authenticated', u[27], format($q$SELECT public.jit_join_organization('azure_ad', %L)::text$q$, t[7]));
    r := r || jsonb_build_object('J5_column_off_refused', CASE WHEN s LIKE '%jit_disabled%' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.run_as('authenticated', u[28], format($q$SELECT public.jit_join_organization('azure_ad', %L)::text$q$, t[8]));
    r := r || jsonb_build_object('J6_default_admin_joins_as_agent', CASE WHEN s LIKE '%"role": "agent"%' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.run_as('authenticated', u[23], format($q$SELECT public.jit_join_organization('azure_ad', %L)::text$q$, t[3]));
    r := r || jsonb_build_object('J7_no_deal_joins', CASE WHEN s LIKE '%"success": true%' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.run_as('authenticated', u[24], format($q$SELECT public.jit_join_organization('azure_ad', %L)::text$q$, t[4]));
    r := r || jsonb_build_object('J8_active_deal_joins', CASE WHEN s LIKE '%"success": true%' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.run_as('authenticated', u[19], $q$SELECT public.jit_join_organization('google_workspace', 'P4012.example.test')::text$q$);
    r := r || jsonb_build_object('J9_google_hd_joins', CASE WHEN s LIKE '%"success": true%' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.run_as('authenticated', u[30], format($q$SELECT public.jit_join_organization('azure_ad', %L)::text$q$, t[10]));
    SELECT count(*) INTO n FROM public.organization_members WHERE organization_id = o_j11 AND user_id = u[30];
    r := r || jsonb_build_object('J11_password_session_stale_identity_refused', CASE WHEN s LIKE '%reauth_required%' AND n = 0 THEN 'PASS' ELSE 'FAIL ' || s || ' rows=' || n END);
    s := pg_temp.run_as('authenticated', u[34], format($q$SELECT public.jit_join_organization('azure_ad', %L)::text$q$, t[10]));
    r := r || jsonb_build_object('J11b_oauth_signin_older_than_15_min_refused', CASE WHEN s LIKE '%reauth_required%' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.run_as('authenticated', u[35], format($q$SELECT public.jit_join_organization('azure_ad', %L)::text$q$, t[10]));
    r := r || jsonb_build_object('J11c_fresh_signin_but_stale_tenant_identity_refused', CASE WHEN s LIKE '%reauth_required%' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.run_as('authenticated', u[36], format($q$SELECT public.jit_join_organization('azure_ad', %L)::text$q$, t[10]));
    r := r || jsonb_build_object('J11d_no_session_refused', CASE WHEN s LIKE '%reauth_required%' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.run_as('authenticated', u[37], format($q$SELECT public.jit_join_organization('azure_ad', %L)::text$q$, t[10]));
    r := r || jsonb_build_object('J11e_password_session_fresh_identity_refused', CASE WHEN s LIKE '%reauth_required%' THEN 'PASS' ELSE 'FAIL ' || s END);
    -- F1 parity: _org_feature_allowed = check_feature_access.allowed, every org with a licensed
    -- member (keepr-test + fixtures) x every feature key
    SELECT count(*), count(*) FILTER (WHERE a IS DISTINCT FROM b),
           string_agg(CASE WHEN a IS DISTINCT FROM b THEN left(o::text, 8) || ':' || k END, ',')
      INTO n, v_pairs_bad, v_m_txt
      FROM (SELECT mm.o, f.key AS k, public._org_feature_allowed(mm.o, f.key) AS a, pg_temp.cfa(mm.u, mm.o, f.key) AS b
              FROM (SELECT DISTINCT ON (m.organization_id) m.organization_id AS o, m.user_id AS u
                      FROM public.organization_members m
                     WHERE m.user_id IS NOT NULL AND public.member_status_grants_access(m.license_status)
                     ORDER BY m.organization_id, m.user_id) mm
             CROSS JOIN public.feature_definitions f) x;
    r := r || jsonb_build_object('F1_feature_parity', CASE WHEN n > 0 AND v_pairs_bad = 0 THEN 'PASS' ELSE 'FAIL pairs=' || n || ' bad=' || v_pairs_bad || ' ' || coalesce(left(v_m_txt, 120), '') END);
    r := r || jsonb_build_object('F1b_unknown_feature_closed', CASE WHEN public._org_feature_allowed(o_paid, 'p4012_no_such_feature') = false THEN 'PASS' ELSE 'FAIL' END);
    PERFORM set_config('request.jwt.claims', '', true);
    r := r || jsonb_build_object('J10_grants',
      CASE WHEN has_function_privilege('authenticated', 'public.jit_join_organization(text,text)', 'EXECUTE')
            AND NOT has_function_privilege('anon', 'public.jit_join_organization(text,text)', 'EXECUTE')
            AND NOT has_function_privilege('authenticated', 'public.jit_join_organization(text)', 'EXECUTE')
            AND NOT has_function_privilege('authenticated', 'public._billing_org_join_blocked(uuid)', 'EXECUTE')
            AND NOT has_function_privilege('authenticated', 'public._org_feature_allowed(uuid,text)', 'EXECUTE')
            AND NOT has_function_privilege('anon', 'public._billing_org_join_blocked(uuid)', 'EXECUTE')
            AND has_function_privilege('service_role', 'public._billing_org_join_blocked(uuid)', 'EXECUTE')
            AND NOT has_function_privilege('authenticated', 'public._billing_guard_idp_join_while_setup_pending()', 'EXECUTE')
            AND has_function_privilege('authenticated', 'public._billing_org_setup_pending(uuid)', 'EXECUTE')
           THEN 'PASS' ELSE 'FAIL' END);
    RETURN r;
  END $b$$f$;

  FOREACH v_m IN ARRAY v_modes LOOP
    BEGIN
      DECLARE v_mut text; v_r jsonb; v_pass int; v_fail int; v_reds jsonb;
      BEGIN
        v_mut := pg_temp.apply_mode(v_m);
        v_r := pg_temp.checks();
        SELECT count(*) FILTER (WHERE value #>> '{}' = 'PASS'), count(*) FILTER (WHERE value #>> '{}' <> 'PASS'),
               coalesce(jsonb_agg(key || ': ' || (value #>> '{}')) FILTER (WHERE value #>> '{}' <> 'PASS'), '[]'::jsonb)
          INTO v_pass, v_fail, v_reds FROM jsonb_each(v_r);
        RAISE EXCEPTION 'MODE_DONE %', jsonb_build_object('mutation', v_mut, 'pass', v_pass, 'fail', v_fail, 'reds', v_reds)::text;
      END;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'MODE_DONE %' THEN
        v_res := v_res || jsonb_build_object(v_m, substr(SQLERRM, 11)::jsonb);
      ELSE
        v_res := v_res || jsonb_build_object(v_m, 'HARNESS ERROR ' || SQLSTATE || ' ' || SQLERRM);
      END IF;
    END;
  END LOOP;
  RAISE EXCEPTION 'P4012_RESULT %', v_res::text;
END
$drv$;
