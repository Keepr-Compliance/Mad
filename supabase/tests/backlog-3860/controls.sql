-- BACKLOG-3860 PR-1 DB controls (solo free trial). Function-level controls and mutants.
-- Venue: keepr-test, ONE kt-sql call, ONE transaction ending in RAISE, so nothing persists.
-- compose.py puts the migration (or a migration-text mutant) in front of this file.
-- __MODES__ is replaced with a comma list of quoted mode names. Each mode runs in its own
-- subtransaction: apply the mutation (exact-once replace that raises on 0 or 2+ matches; the
-- md5 of pg_get_functiondef must change, else MUTATION NOT APPLIED), build fixtures, run every
-- check, roll back. 'base' = no mutation (every check must PASS).
-- Output: RAISE 'P3860_RESULT {mode: {mutation, pass, fail, reds}}'.
-- Fixtures: auth users p3860-*@example.test, organizations "P3860 *". Every id is generated at
-- run time. Personal organizations are made by the real functions (ensure wrapper as the
-- signed-in user, or the internal function as the service role), never inserted by hand.

DO $drv$
DECLARE
  v_modes text[] := ARRAY[__MODES__]::text[];
  v_m text;
  v_mut text;
  v_res jsonb := '{}'::jsonb;
  v_r jsonb;
  v_detail text;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);
  END $b$$f$;

  -- a query returning one jsonb value as an authenticated user: the value as text, or 'ERR ...'
  EXECUTE $f$CREATE FUNCTION pg_temp.call_as(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE v jsonb;
  BEGIN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', u::text, true);
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      EXECUTE q INTO v;
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN coalesce(v::text, 'null');
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 120);
    END;
  END $b$$f$;

  -- a query returning one jsonb value as the service role
  EXECUTE $f$CREATE FUNCTION pg_temp.call_svc(q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE v jsonb;
  BEGIN
    BEGIN
      PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);
      EXECUTE 'SET LOCAL ROLE service_role';
      EXECUTE q INTO v;
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN coalesce(v::text, 'null');
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 120);
    END;
  END $b$$f$;

  -- a statement as the database owner: 'ok' or 'ERR <sqlstate>'
  EXECUTE $f$CREATE FUNCTION pg_temp.try(q text) RETURNS text LANGUAGE plpgsql AS $b$
  BEGIN
    BEGIN
      EXECUTE q;
      RETURN 'ok';
    EXCEPTION WHEN OTHERS THEN
      RETURN 'ERR ' || SQLSTATE;
    END;
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
    RETURN 'MUTATION APPLIED ' || p_sig || ' ' || left(m1, 8) || '->' || left(m2, 8) || ' [' || left(replace(p_to, E'\n', ' '), 110) || ']';
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.pass(ok boolean, info text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || coalesce(left(info, 240), '') END
  $b$$f$;

  -- a fixture user with an active individual licence and no organization
  EXECUTE $f$CREATE FUNCTION pg_temp.mk_user(tag text) RETURNS uuid LANGUAGE plpgsql AS $b$
  DECLARE u uuid := gen_random_uuid();
  BEGIN
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (u, 'p3860-' || tag || '-' || left(u::text, 8) || '@example.test', 'authenticated', 'authenticated',
            '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now());
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    VALUES (u, 'p3860-' || tag || '-' || left(u::text, 8) || '@example.test', 'email', u::text, 'P3860 ' || tag)
    ON CONFLICT (id) DO NOTHING;
    IF NOT EXISTS (SELECT 1 FROM public.licenses WHERE user_id = u) THEN
      INSERT INTO public.licenses (user_id, license_key, status, license_type)
      VALUES (u, 'p3860-' || md5(random()::text), 'active', 'individual');
    END IF;
    RETURN u;
  END $b$$f$;

  -- the signed-in wrapper as user u (the desktop's call, electron/services/licenseService.ts:377)
  EXECUTE $f$CREATE FUNCTION pg_temp.ensure(u uuid) RETURNS text LANGUAGE sql AS $b$
    SELECT pg_temp.call_as(u, 'SELECT public.ensure_personal_organization()')
  $b$$f$;
  -- the start function called directly as the service role
  EXECUTE $f$CREATE FUNCTION pg_temp.start(u uuid) RETURNS text LANGUAGE sql AS $b$
    SELECT pg_temp.call_svc(format('SELECT public._start_solo_trial_for(%L::uuid)', u))
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.porg(u uuid) RETURNS uuid LANGUAGE sql AS $b$
    SELECT o.id FROM public.organizations o WHERE o.personal_owner_user_id = u
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.ovr(u uuid) RETURNS jsonb LANGUAGE sql AS $b$
    SELECT op.feature_overrides -> 'unlimited_transactions' FROM public.organization_plans op
     WHERE op.organization_id = (SELECT o.id FROM public.organizations o WHERE o.personal_owner_user_id = u)
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.set_ovr(u uuid, v jsonb) RETURNS void LANGUAGE sql AS $b$
    UPDATE public.organization_plans op
       SET feature_overrides = CASE WHEN v IS NULL THEN coalesce(op.feature_overrides, '{}'::jsonb) - 'unlimited_transactions'
                                    ELSE coalesce(op.feature_overrides, '{}'::jsonb) || jsonb_build_object('unlimited_transactions', v) END
     WHERE op.organization_id = (SELECT o.id FROM public.organizations o WHERE o.personal_owner_user_id = u)
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.ledger(u uuid) RETURNS int LANGUAGE sql AS $b$
    SELECT count(*)::int FROM public.solo_trials t WHERE t.user_id = u
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.switch(on_ boolean, d int) RETURNS void LANGUAGE sql AS $b$
    UPDATE public.billing_settings SET enabled = on_, days = d WHERE key = 'solo_trial'
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.st(s text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN s LIKE 'ERR%' THEN s ELSE (s::jsonb ->> 'status') END
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.why(s text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN s LIKE 'ERR%' THEN s ELSE (s::jsonb ->> 'reason') END
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.grant_for(u uuid, pt timestamptz) RETURNS text LANGUAGE sql AS $b$
    SELECT pg_temp.call_svc(format('SELECT public.grant_unlimited_from_subscription(%L::uuid, %L::timestamptz, %L)',
      u, pt, (SELECT CASE WHEN o.is_test THEN 'test' ELSE 'live' END FROM public.organizations o WHERE o.personal_owner_user_id = u)))
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE
    sf text := 'public._start_solo_trial_for(uuid)';
    wr text := 'public.ensure_personal_organization()';
    gr text := 'public.grant_unlimited_from_subscription(uuid,timestamptz,text)';
    it text := 'public._ensure_personal_organization_for(uuid)';
    se text := 'public.admin_set_solo_trial_setting(boolean,integer)';
    b1 boolean; b2 boolean;
  BEGIN
    CASE m
    WHEN 'base' THEN RETURN 'none';
    -- T1: a second trial for the same user (ledger check removed; the primary key then raises)
    WHEN 'm01_no_ledger_check' THEN RETURN pg_temp.mut_fn(sf,
      $q$IF EXISTS (SELECT 1 FROM public.solo_trials t WHERE t.user_id = p_user_id) THEN$q$, $q$IF false THEN$q$);
    -- T2: override written without paid_through (a permanent Unlimited)
    WHEN 'm02_no_paid_through' THEN RETURN pg_temp.mut_fn(sf,
      $q$jsonb_build_object('enabled', true,
                                   'paid_through', to_jsonb(v_ends),
                                   'source', 'trial')$q$,
      $q$jsonb_build_object('enabled', true,
                                   'source', 'trial')$q$);
    -- T3: the setter rewrites the end date of running trials
    WHEN 'm03_setter_rewrites_running' THEN RETURN pg_temp.mut_fn(se,
      $q$  PERFORM public.log_admin_action($q$,
      $q$  UPDATE public.organization_plans op SET feature_overrides = jsonb_set(op.feature_overrides, '{unlimited_transactions,paid_through}', to_jsonb(now() + make_interval(days => p_days))) WHERE op.feature_overrides -> 'unlimited_transactions' ->> 'source' = 'trial';
  PERFORM public.log_admin_action($q$);
    -- T4: the start call moved into the internal function (every caller, the deactivation trigger included)
    WHEN 'm04_start_in_internal' THEN RETURN pg_temp.mut_fn(it,
      $q$  GET DIAGNOSTICS v_rows = ROW_COUNT;$q$,
      $q$  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM public._start_solo_trial_for(p_user_id);$q$);
    -- T5: start function executable by any signed-in user
    WHEN 'm05_exec_authenticated' THEN
      b1 := has_function_privilege('authenticated', sf, 'EXECUTE');
      EXECUTE 'GRANT EXECUTE ON FUNCTION public._start_solo_trial_for(uuid) TO authenticated';
      b2 := has_function_privilege('authenticated', sf, 'EXECUTE');
      IF b1 = b2 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: privilege unchanged'; END IF;
      RETURN 'MUTATION APPLIED grant execute on _start_solo_trial_for to authenticated (' || b1 || '->' || b2 || ')';
    -- T5: ledger readable by signed-in users
    WHEN 'm05b_ledger_select_authenticated' THEN
      b1 := has_table_privilege('authenticated', 'public.solo_trials', 'SELECT');
      EXECUTE 'GRANT SELECT ON public.solo_trials TO authenticated';
      b2 := has_table_privilege('authenticated', 'public.solo_trials', 'SELECT');
      IF b1 = b2 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: privilege unchanged'; END IF;
      RETURN 'MUTATION APPLIED grant select on solo_trials to authenticated (' || b1 || '->' || b2 || ')';
    -- T5: setter without the permission check (any staff, or any signed-in user)
    WHEN 'm05c_setter_no_permission' THEN RETURN pg_temp.mut_fn(se,
      $q$IF NOT coalesce(public.has_permission(v_uid, 'billing.pricebook'), false) THEN$q$, $q$IF false THEN$q$);
    -- T6: a trial on any ensure answer (existing users, 'exists')
    WHEN 'm06_start_any_status' THEN RETURN pg_temp.mut_fn(wr,
      $q$IF v_res ->> 'status' = 'created' THEN$q$, $q$IF true THEN$q$);
    -- T7: switch check removed
    WHEN 'm07_no_switch_check' THEN RETURN pg_temp.mut_fn(sf,
      $q$IF v_enabled IS NOT TRUE THEN$q$, $q$IF false THEN$q$);
    -- T7 (C2): switch check not null-safe
    WHEN 'm07b_switch_not_null_safe' THEN RETURN pg_temp.mut_fn(sf,
      $q$IF v_enabled IS NOT TRUE THEN$q$, $q$IF v_enabled = false THEN$q$);
    -- T8: grant still refuses a trial override (the pre-3860 rule)
    WHEN 'm08_grant_refuses_trial' THEN RETURN pg_temp.mut_fn(gr,
      $q$
     AND (v_existing ->> 'source') IS DISTINCT FROM 'trial' THEN$q$, $q$ THEN$q$);
    -- T8: only a sourceless override is protected
    WHEN 'm08b_only_sourceless_protected' THEN RETURN pg_temp.mut_fn(gr,
      $q$  IF v_existing IS NOT NULL
     AND (v_existing ->> 'source') IS DISTINCT FROM 'stripe'
     AND (v_existing ->> 'source') IS DISTINCT FROM 'trial' THEN$q$,
      $q$  IF v_existing IS NOT NULL AND (v_existing ->> 'source') IS NULL THEN$q$);
    -- T8: the null trap (NOT IN gives NULL for a sourceless override)
    WHEN 'm08c_not_in_null_trap' THEN RETURN pg_temp.mut_fn(gr,
      $q$  IF v_existing IS NOT NULL
     AND (v_existing ->> 'source') IS DISTINCT FROM 'stripe'
     AND (v_existing ->> 'source') IS DISTINCT FROM 'trial' THEN$q$,
      $q$  IF v_existing IS NOT NULL AND (v_existing ->> 'source') NOT IN ('stripe', 'trial') THEN$q$);
    -- a trial replaces an existing (support / Stripe) override
    WHEN 'm09_trial_replaces_override' THEN RETURN pg_temp.mut_fn(sf,
      $q$  IF v_existing IS NOT NULL THEN$q$, $q$  IF false THEN$q$);
    -- a trial for a brokerage member (membership check removed in the start function)
    WHEN 'm10_no_membership_check' THEN RETURN pg_temp.mut_fn(sf,
      $q$       AND NOT public.member_status_is_deactivated(m.license_status)
  ) THEN$q$, $q$       AND false
  ) THEN$q$);
    -- a trial for a suspended licence
    WHEN 'm11_no_suspended_check' THEN RETURN pg_temp.mut_fn(sf,
      $q$IF EXISTS (SELECT 1 FROM public.licenses l WHERE l.user_id = p_user_id AND l.status = 'suspended') THEN$q$, $q$IF false THEN$q$);
    -- T13: a trial failure blocks the personal organization (exception block removed)
    WHEN 'm13_no_exception_block' THEN RETURN pg_temp.mut_fn(wr,
      $q$    BEGIN
      PERFORM public._start_solo_trial_for(v_uid);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'ensure_personal_organization: solo trial not started for % (%: %)',
        v_uid, SQLSTATE, SQLERRM;
    END;$q$, $q$    PERFORM public._start_solo_trial_for(v_uid);$q$);
    -- T14: length check removed
    WHEN 'm14_no_length_check' THEN RETURN pg_temp.mut_fn(sf,
      $q$IF v_days IS NULL OR v_days < 1 OR v_days > 90 THEN$q$, $q$IF false THEN$q$);
    ELSE RAISE EXCEPTION 'unknown mode %', m;
    END CASE;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    u1 uuid; u2 uuid; u3 uuid; u4 uuid; u5 uuid; u6 uuid; u7 uuid; u8 uuid; u9 uuid;
    ua uuid; ub uuid; uc uuid; ud uuid; ue uuid; uf uuid; ug uuid; uh uuid;
    u_super uuid; u_sales uuid; u_plain uuid;
    ob uuid;
    s text; s2 text; v jsonb; v2 jsonb; t1 timestamptz; t2 timestamptz; n int; a jsonb;
    fut timestamptz := now() + interval '30 days';
  BEGIN
    u_super := pg_temp.mk_user('super');
    INSERT INTO public.internal_roles (user_id, role_id) SELECT u_super, ar.id FROM public.admin_roles ar WHERE ar.slug = 'super-admin';
    u_sales := pg_temp.mk_user('sales');
    INSERT INTO public.internal_roles (user_id, role_id) SELECT u_sales, ar.id FROM public.admin_roles ar WHERE ar.slug = 'sales';
    u_plain := pg_temp.mk_user('plain');

    -- ---------------- T7: switch off (the shipped state) ----------------
    PERFORM pg_temp.switch(false, 14);
    u1 := pg_temp.mk_user('t7');
    s := pg_temp.ensure(u1);
    r := r || jsonb_build_object('T7a_off_ensure_created_no_trial', pg_temp.pass(
      pg_temp.st(s) = 'created' AND pg_temp.ovr(u1) IS NULL AND pg_temp.ledger(u1) = 0, s || ' ovr=' || coalesce(pg_temp.ovr(u1)::text, 'null')));
    s := pg_temp.start(u1);
    r := r || jsonb_build_object('T7b_off_direct_refused_off', pg_temp.pass(
      pg_temp.why(s) = 'off' AND pg_temp.ovr(u1) IS NULL AND pg_temp.ledger(u1) = 0, s));
    -- C2: the solo_trial row absent reads as off
    PERFORM pg_temp.try($q$DELETE FROM public.billing_settings WHERE key = 'solo_trial'$q$);
    s := pg_temp.start(u1);
    r := r || jsonb_build_object('T7c_row_absent_refused_off', pg_temp.pass(
      pg_temp.why(s) = 'off' AND pg_temp.ovr(u1) IS NULL AND pg_temp.ledger(u1) = 0, s));
    INSERT INTO public.billing_settings (key, enabled, days) VALUES ('solo_trial', false, 14);

    -- ---------------- switch on, 14 days ----------------
    PERFORM pg_temp.switch(true, 14);

    -- ---------------- T2: shape of the override and the ledger row ----------------
    u2 := pg_temp.mk_user('t2');
    s := pg_temp.ensure(u2);
    v := pg_temp.ovr(u2);
    SELECT t.started_at, t.ends_at INTO t1, t2 FROM public.solo_trials t WHERE t.user_id = u2;
    r := r || jsonb_build_object('T2a_created_and_trial_written', pg_temp.pass(
      pg_temp.st(s) = 'created' AND pg_temp.ledger(u2) = 1 AND v IS NOT NULL, s || ' ovr=' || coalesce(v::text, 'null')));
    r := r || jsonb_build_object('T2b_override_shape', pg_temp.pass(
      v ->> 'source' = 'trial' AND (v -> 'enabled') = 'true'::jsonb AND v ? 'paid_through'
      AND jsonb_typeof(v -> 'paid_through') = 'string'
      AND (v ->> 'paid_through')::timestamptz = t2
      AND t2 = t1 + interval '14 days'
      AND (SELECT length_days FROM public.solo_trials WHERE user_id = u2) = 14
      AND (SELECT organization_id FROM public.solo_trials WHERE user_id = u2) = pg_temp.porg(u2),
      coalesce(v::text, 'null') || ' started=' || coalesce(t1::text, '-') || ' ends=' || coalesce(t2::text, '-')));
    r := r || jsonb_build_object('T2c_override_effective_now', pg_temp.pass(
      public._override_effective(v) IS TRUE, coalesce(v::text, 'null')));

    -- ---------------- T1: one trial per user, asserted by the returned answer (C3) ----------------
    PERFORM pg_temp.set_ovr(u2, NULL);
    s := pg_temp.start(u2);
    r := r || jsonb_build_object('T1_second_start_refused_already_used', pg_temp.pass(
      pg_temp.st(s) = 'refused' AND pg_temp.why(s) = 'already_used'
      AND pg_temp.ledger(u2) = 1 AND pg_temp.ovr(u2) IS NULL, s || ' ovr=' || coalesce(pg_temp.ovr(u2)::text, 'null')));
    s := pg_temp.ensure(u2);
    r := r || jsonb_build_object('T1b_second_sign_in_exists_no_trial', pg_temp.pass(
      pg_temp.st(s) = 'exists' AND pg_temp.ledger(u2) = 1 AND pg_temp.ovr(u2) IS NULL, s));

    -- ---------------- T6: an existing solo user (personal org made before) ----------------
    u3 := pg_temp.mk_user('t6');
    s := pg_temp.call_svc(format('SELECT public._ensure_personal_organization_for(%L::uuid)', u3));
    s2 := pg_temp.ensure(u3);
    r := r || jsonb_build_object('T6_existing_user_exists_no_trial', pg_temp.pass(
      pg_temp.st(s) = 'created' AND pg_temp.st(s2) = 'exists' AND pg_temp.ovr(u3) IS NULL AND pg_temp.ledger(u3) = 0, s || ' / ' || s2));

    -- ---------------- T4: brokerage member, deactivated ex-member ----------------
    ob := gen_random_uuid();
    INSERT INTO public.organizations (id, name, slug, max_seats, is_test)
    VALUES (ob, 'P3860 brokerage', 'p3860-b-' || left(ob::text, 8), 20, true);
    u4 := pg_temp.mk_user('t4');
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by)
    VALUES (ob, u4, 'agent', 'active', now(), 'invite');
    s := pg_temp.ensure(u4);
    r := r || jsonb_build_object('T4a_member_has_membership_no_trial', pg_temp.pass(
      pg_temp.st(s) = 'has_membership' AND pg_temp.porg(u4) IS NULL AND pg_temp.ledger(u4) = 0, s));
    -- deactivation: the trigger attaches a personal organization through the internal function
    UPDATE public.organization_members SET license_status = 'suspended' WHERE organization_id = ob AND user_id = u4;
    r := r || jsonb_build_object('T4b_deactivated_personal_org_no_trial', pg_temp.pass(
      pg_temp.porg(u4) IS NOT NULL AND pg_temp.ovr(u4) IS NULL AND pg_temp.ledger(u4) = 0,
      'porg=' || coalesce(pg_temp.porg(u4)::text, 'null') || ' ovr=' || coalesce(pg_temp.ovr(u4)::text, 'null') || ' ledger=' || pg_temp.ledger(u4)));
    s := pg_temp.ensure(u4);
    r := r || jsonb_build_object('T4c_ex_member_later_sign_in_no_trial', pg_temp.pass(
      pg_temp.st(s) IN ('exists', 'attached') AND pg_temp.ovr(u4) IS NULL AND pg_temp.ledger(u4) = 0, s));
    -- direct start for an active member: refused has_membership
    u5 := pg_temp.mk_user('t4d');
    s := pg_temp.call_svc(format('SELECT public._ensure_personal_organization_for(%L::uuid)', u5));
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by)
    VALUES (ob, u5, 'agent', 'active', now(), 'invite');
    -- the retire trigger removed the personal membership; the personal org and plan row stay
    s := pg_temp.start(u5);
    r := r || jsonb_build_object('T4d_direct_start_member_refused', pg_temp.pass(
      pg_temp.why(s) = 'has_membership' AND pg_temp.ledger(u5) = 0 AND pg_temp.ovr(u5) IS NULL, s));
    -- suspended licence: refused
    u6 := pg_temp.mk_user('t4e');
    s := pg_temp.call_svc(format('SELECT public._ensure_personal_organization_for(%L::uuid)', u6));
    UPDATE public.licenses SET status = 'suspended' WHERE user_id = u6;
    s := pg_temp.start(u6);
    r := r || jsonb_build_object('T4e_suspended_licence_refused', pg_temp.pass(
      pg_temp.why(s) = 'licence_suspended' AND pg_temp.ledger(u6) = 0 AND pg_temp.ovr(u6) IS NULL, s));

    -- ---------------- a trial never replaces an existing grant ----------------
    u7 := pg_temp.mk_user('sup');
    s := pg_temp.call_svc(format('SELECT public._ensure_personal_organization_for(%L::uuid)', u7));
    PERFORM pg_temp.set_ovr(u7, jsonb_build_object('enabled', true, 'source', 'support', 'paid_through', fut));
    v := pg_temp.ovr(u7);
    s := pg_temp.start(u7);
    r := r || jsonb_build_object('T8z_trial_never_replaces_support', pg_temp.pass(
      pg_temp.why(s) = 'override_present' AND pg_temp.ovr(u7) = v AND pg_temp.ledger(u7) = 0, s));

    -- ---------------- T8: Stripe grant against each override shape ----------------
    -- live trial -> replaced
    u8 := pg_temp.mk_user('t8a');
    s := pg_temp.ensure(u8);
    s := pg_temp.grant_for(u8, fut);
    v := pg_temp.ovr(u8);
    r := r || jsonb_build_object('T8a_live_trial_replaced_by_stripe', pg_temp.pass(
      pg_temp.st(s) = 'granted' AND v ->> 'source' = 'stripe' AND (v ->> 'paid_through')::timestamptz = fut AND pg_temp.ledger(u8) = 1, s || ' ' || coalesce(v::text, 'null')));
    -- ended trial -> replaced
    u9 := pg_temp.mk_user('t8b');
    s := pg_temp.ensure(u9);
    PERFORM pg_temp.set_ovr(u9, jsonb_build_object('enabled', true, 'source', 'trial', 'paid_through', now() - interval '1 day'));
    s := pg_temp.grant_for(u9, fut);
    v := pg_temp.ovr(u9);
    r := r || jsonb_build_object('T8b_ended_trial_replaced_by_stripe', pg_temp.pass(
      pg_temp.st(s) = 'granted' AND v ->> 'source' = 'stripe', s || ' ' || coalesce(v::text, 'null')));
    -- sourceless (the 3845 k07 support fixture) -> refused, unchanged
    ua := pg_temp.mk_user('t8c');
    s := pg_temp.call_svc(format('SELECT public._ensure_personal_organization_for(%L::uuid)', ua));
    PERFORM pg_temp.set_ovr(ua, '{"enabled": true}'::jsonb);
    s := pg_temp.grant_for(ua, fut);
    r := r || jsonb_build_object('T8c_sourceless_refused', pg_temp.pass(
      pg_temp.why(s) = 'non_stripe_override' AND pg_temp.ovr(ua) = '{"enabled": true}'::jsonb, s || ' ' || coalesce(pg_temp.ovr(ua)::text, 'null')));
    -- source support with a paid_through -> refused, unchanged
    ub := pg_temp.mk_user('t8d');
    s := pg_temp.call_svc(format('SELECT public._ensure_personal_organization_for(%L::uuid)', ub));
    PERFORM pg_temp.set_ovr(ub, jsonb_build_object('enabled', true, 'source', 'support', 'paid_through', fut));
    v := pg_temp.ovr(ub);
    s := pg_temp.grant_for(ub, fut + interval '1 day');
    r := r || jsonb_build_object('T8d_support_refused', pg_temp.pass(
      pg_temp.why(s) = 'non_stripe_override' AND pg_temp.ovr(ub) = v, s));
    -- arbitrary other source -> refused, unchanged
    uc := pg_temp.mk_user('t8e');
    s := pg_temp.call_svc(format('SELECT public._ensure_personal_organization_for(%L::uuid)', uc));
    PERFORM pg_temp.set_ovr(uc, '{"enabled": true, "source": "partner-x"}'::jsonb);
    s := pg_temp.grant_for(uc, fut);
    r := r || jsonb_build_object('T8e_other_source_refused', pg_temp.pass(
      pg_temp.why(s) = 'non_stripe_override' AND pg_temp.ovr(uc) = '{"enabled": true, "source": "partner-x"}'::jsonb, s));
    -- an existing Stripe grant is still replaced (pre-3860 behaviour kept)
    PERFORM pg_temp.set_ovr(uc, jsonb_build_object('enabled', true, 'source', 'stripe', 'paid_through', fut));
    s := pg_temp.grant_for(uc, fut + interval '2 days');
    r := r || jsonb_build_object('T8f_stripe_replaced', pg_temp.pass(
      pg_temp.st(s) = 'granted' AND (pg_temp.ovr(uc) ->> 'paid_through')::timestamptz = fut + interval '2 days', s));

    -- ---------------- T3: a length change applies to new trials only ----------------
    ud := pg_temp.mk_user('t3a');
    s := pg_temp.ensure(ud);
    v := pg_temp.ovr(ud);
    s := pg_temp.call_as(u_super, 'SELECT public.admin_set_solo_trial_setting(true, 7)');
    r := r || jsonb_build_object('T3a_setter_ok_super_admin', pg_temp.pass(
      s NOT LIKE 'ERR%' AND (SELECT days FROM public.billing_settings WHERE key = 'solo_trial') = 7
      AND (SELECT updated_by FROM public.billing_settings WHERE key = 'solo_trial') = u_super, s));
    r := r || jsonb_build_object('T3b_running_trial_unchanged', pg_temp.pass(
      pg_temp.ovr(ud) = v AND v IS NOT NULL, coalesce(v::text, 'null') || ' -> ' || coalesce(pg_temp.ovr(ud)::text, 'null')));
    ue := pg_temp.mk_user('t3c');
    s := pg_temp.ensure(ue);
    SELECT t.started_at, t.ends_at INTO t1, t2 FROM public.solo_trials t WHERE t.user_id = ue;
    r := r || jsonb_build_object('T3c_new_trial_gets_7_days', pg_temp.pass(
      t2 = t1 + interval '7 days' AND (pg_temp.ovr(ue) ->> 'paid_through')::timestamptz = t2, s));
    SELECT a2.metadata INTO a FROM public.admin_audit_logs a2
     WHERE a2.action = 'billing.solo_trial_updated' AND a2.actor_id = u_super ORDER BY a2.created_at DESC LIMIT 1;
    r := r || jsonb_build_object('T3d_audit_row_old_and_new', pg_temp.pass(
      a = '{"new": {"days": 7, "enabled": true}, "old": {"days": 14, "enabled": true}}'::jsonb, coalesce(a::text, 'no audit row')));

    -- ---------------- T5: who can call what ----------------
    s := pg_temp.call_as(u_sales, 'SELECT public.admin_set_solo_trial_setting(true, 30)');
    s2 := pg_temp.call_as(u_plain, 'SELECT public.admin_set_solo_trial_setting(true, 30)');
    r := r || jsonb_build_object('T5a_setter_refuses_sales_and_non_staff', pg_temp.pass(
      s LIKE 'ERR 42501%' AND s2 LIKE 'ERR 42501%' AND (SELECT days FROM public.billing_settings WHERE key = 'solo_trial') = 7, s || ' / ' || s2));
    s := pg_temp.call_as(u_super, 'SELECT public.admin_set_solo_trial_setting(true, 91)');
    s2 := pg_temp.call_as(u_super, 'SELECT public.admin_set_solo_trial_setting(NULL, 14)');
    r := r || jsonb_build_object('T5b_setter_refuses_bad_input', pg_temp.pass(
      s LIKE 'ERR 22023%' AND s2 LIKE 'ERR 22004%', s || ' / ' || s2));
    s := pg_temp.call_as(u_sales, 'SELECT public.admin_get_solo_trial_setting()');
    s2 := pg_temp.call_as(u_plain, 'SELECT public.admin_get_solo_trial_setting()');
    r := r || jsonb_build_object('T5c_reader_staff_only_can_edit_flag', pg_temp.pass(
      s NOT LIKE 'ERR%' AND (s::jsonb ->> 'can_edit') = 'false' AND (s::jsonb ->> 'days') = '7'
      AND s2 LIKE 'ERR 42501%'
      AND (pg_temp.call_as(u_super, 'SELECT public.admin_get_solo_trial_setting()')::jsonb ->> 'can_edit') = 'true', s || ' / ' || s2));
    s := pg_temp.call_as(u_plain, format('SELECT public._start_solo_trial_for(%L::uuid)', u_plain));
    r := r || jsonb_build_object('T5d_start_refused_to_signed_in_user', pg_temp.pass(
      s LIKE 'ERR 42501%' AND pg_temp.ledger(u_plain) = 0, s));
    s := pg_temp.call_as(u_plain, 'SELECT to_jsonb(count(*)) FROM public.solo_trials');
    r := r || jsonb_build_object('T5e_ledger_refused_to_signed_in_user', pg_temp.pass(s LIKE 'ERR 42501%', s));
    r := r || jsonb_build_object('T5f_catalog', pg_temp.pass(
          has_function_privilege('service_role', 'public._start_solo_trial_for(uuid)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public._start_solo_trial_for(uuid)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public._start_solo_trial_for(uuid)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.ensure_personal_organization()', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.ensure_personal_organization()', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.admin_set_solo_trial_setting(boolean,integer)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.admin_get_solo_trial_setting()', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.grant_unlimited_from_subscription(uuid,timestamptz,text)', 'EXECUTE')
      AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                       WHERE p.pronamespace = 'public'::regnamespace
                         AND p.proname IN ('_start_solo_trial_for', 'ensure_personal_organization', 'admin_get_solo_trial_setting',
                                           'admin_set_solo_trial_setting', 'grant_unlimited_from_subscription')
                         AND x.grantee = 0)
      AND NOT has_table_privilege('authenticated', 'public.solo_trials', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT has_table_privilege('anon', 'public.solo_trials', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.solo_trials'::regclass),
      'catalog'));

    -- ---------------- T12c (C1): the table refuses a bad length ----------------
    r := r || jsonb_build_object('T12c_days_null_0_91_refused', pg_temp.pass(
      pg_temp.try($q$UPDATE public.billing_settings SET days = NULL WHERE key = 'solo_trial'$q$) = 'ERR 23514'
      AND pg_temp.try($q$UPDATE public.billing_settings SET days = 0 WHERE key = 'solo_trial'$q$) = 'ERR 23514'
      AND pg_temp.try($q$UPDATE public.billing_settings SET days = 91 WHERE key = 'solo_trial'$q$) = 'ERR 23514'
      AND pg_temp.try($q$INSERT INTO public.billing_settings (key, enabled) VALUES ('other_key', false)$q$) = 'ERR 23514',
      'days null/0/91 or an unknown key accepted'));

    -- ---------------- T13: a trial failure never blocks the personal organization ----------------
    -- Forced failure AFTER the ledger row is written (the override write raises), so the
    -- sub-transaction must also take the ledger row back.
    EXECUTE $q$CREATE FUNCTION pg_temp.t13_fail() RETURNS trigger LANGUAGE plpgsql AS $t$
      BEGIN
        IF NEW.feature_overrides -> 'unlimited_transactions' ->> 'source' = 'trial' THEN
          RAISE EXCEPTION 'T13 forced failure';
        END IF;
        RETURN NEW;
      END $t$$q$;
    EXECUTE 'CREATE TRIGGER p3860_t13 BEFORE UPDATE ON public.organization_plans FOR EACH ROW EXECUTE FUNCTION pg_temp.t13_fail()';
    uf := pg_temp.mk_user('t13');
    s := pg_temp.ensure(uf);
    EXECUTE 'DROP TRIGGER p3860_t13 ON public.organization_plans';
    r := r || jsonb_build_object('T13_trial_error_org_still_created', pg_temp.pass(
      pg_temp.st(s) = 'created' AND pg_temp.porg(uf) IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = uf AND m.organization_id = pg_temp.porg(uf))
      AND pg_temp.ledger(uf) = 0 AND pg_temp.ovr(uf) IS NULL, s));

    -- ---------------- T14: a null / zero / negative length never starts a trial ----------------
    -- Mechanism: the range check is removed inside this rolled-back run (the table forbids it).
    EXECUTE 'ALTER TABLE public.billing_settings DROP CONSTRAINT billing_settings_solo_trial_days_ck';
    n := 0;
    FOREACH s2 IN ARRAY ARRAY['NULL', '0', '-1', '91'] LOOP
      ug := pg_temp.mk_user('t14');
      s := pg_temp.call_svc(format('SELECT public._ensure_personal_organization_for(%L::uuid)', ug));
      EXECUTE format('UPDATE public.billing_settings SET enabled = true, days = %s WHERE key = %L', s2, 'solo_trial');
      s := pg_temp.start(ug);
      IF pg_temp.st(s) = 'refused' AND pg_temp.why(s) = 'bad_length' AND pg_temp.ledger(ug) = 0 AND pg_temp.ovr(ug) IS NULL THEN
        n := n + 1;
      ELSE
        r := r || jsonb_build_object('T14_detail_' || s2, s);
      END IF;
    END LOOP;
    r := r || jsonb_build_object('T14_bad_length_refused', pg_temp.pass(n = 4, n || ' of 4'));
    EXECUTE 'UPDATE public.billing_settings SET days = 14 WHERE key = ''solo_trial''';
    EXECUTE $q$ALTER TABLE public.billing_settings ADD CONSTRAINT billing_settings_solo_trial_days_ck
      CHECK (key <> 'solo_trial' OR (days IS NOT NULL AND days BETWEEN 1 AND 90))$q$;

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
  RAISE EXCEPTION 'P3860_RESULT %', v_res;
END
$drv$;
