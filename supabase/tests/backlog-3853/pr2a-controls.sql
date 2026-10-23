-- BACKLOG-3853 PR-2A DB controls (admin_save_deal, admin_get_org_billing, suspend/reinstate callers).
-- Venue: keepr-test, ONE call, ONE transaction that ends in RAISE, so nothing persists.
-- Run after 20261019030000 is applied, or compose it in front (compose_pr2a.py --with-migration).
-- __MODES__ is replaced with a comma list of quoted mode names. Each mode runs in its own
-- subtransaction: apply the mutation (exact-once replace, raises on 0 or 2+ matches, md5 must
-- change), build the fixtures, run every check, roll back.
-- Output: RAISE 'P3853A_RESULT {mode: {mutation, pass, fail, reds}}'.
-- Fixtures: new auth users p3853a-*@example.test, new organizations P3853A *.

DO $drv$
DECLARE
  v_modes text[] := ARRAY[__MODES__]::text[];
  v_m text;
  v_mut text;
  v_res jsonb := '{}'::jsonb;
  v_r jsonb;
  v_detail text;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.as_user(u uuid, e text) RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated', 'email', e)::text, true);
    PERFORM set_config('request.jwt.claim.sub', u::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  END $b$$f$;

  -- run one statement as an authenticated user; returns the jsonb result as text, or 'ERR <sqlstate>'
  EXECUTE $f$CREATE FUNCTION pg_temp.call_as(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE v jsonb;
  BEGIN
    BEGIN
      PERFORM pg_temp.as_user(u, 'p3853a-' || left(u::text, 8) || '@example.test');
      EXECUTE 'SET LOCAL ROLE authenticated';
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
    RETURN 'MUTATION APPLIED ' || p_sig || ' ' || left(m1, 8) || '->' || left(m2, 8);
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE s text := 'public.admin_save_deal(uuid,text,integer,integer,text,text,uuid,text,integer)';
  BEGIN
    CASE m
    WHEN 'base' THEN RETURN 'none';
    WHEN 'no_manage_check' THEN RETURN pg_temp.mut_fn(s,
      $q$IF NOT public.has_permission(v_uid, 'billing.manage') THEN$q$, 'IF false THEN');
    WHEN 'no_cap' THEN RETURN pg_temp.mut_fn(s, 'IF v_pct > v_cap THEN', 'IF false THEN');
    WHEN 'cap_floor' THEN RETURN pg_temp.mut_fn(s, 'IF v_pct > v_cap THEN', 'IF floor(v_pct) > v_cap THEN');
    WHEN 'no_approve_path' THEN RETURN pg_temp.mut_fn(s,
      $q$IF NOT public.has_permission(v_uid, 'billing.approve')$q$, 'IF true');
    WHEN 'keep_current_any' THEN RETURN pg_temp.mut_fn(s,
      'p_unit_price_cents >= v_current AND p_seats', 'p_unit_price_cents >= 0 AND p_seats');
    WHEN 'price_eq' THEN RETURN pg_temp.mut_fn(s,
      'p_unit_price_cents >= v_current AND p_seats', 'p_unit_price_cents = v_current AND p_seats');
    WHEN 'price_le' THEN RETURN pg_temp.mut_fn(s,
      'p_unit_price_cents >= v_current AND p_seats', 'p_unit_price_cents <= v_current AND p_seats');
    WHEN 'no_keep_current' THEN RETURN pg_temp.mut_fn(s,
      'AND NOT (v_current IS NOT NULL AND', 'AND NOT (false AND');
    WHEN 'no_seats_check' THEN RETURN pg_temp.mut_fn(s,
      ' AND p_seats <= v_current_seats)', ')');
    WHEN 'no_active_filter' THEN RETURN pg_temp.mut_fn(s,
      $q$
     AND d.status <> 'canceled';$q$, ';');
    WHEN 'sr_int_division' THEN RETURN pg_temp.mut_fn(s,
      'round(100.0 * (v_list - p_unit_price_cents)', 'round(100 * (v_list - p_unit_price_cents)');
    WHEN 'no_reason_check' THEN RETURN pg_temp.mut_fn(s, 'IF v_reason IS NULL THEN', 'IF false THEN');
    WHEN 'mode_hardcoded_test' THEN RETURN pg_temp.mut_fn(s,
      $q$'stripe_mode', p_stripe_mode,
      'seats', p_seats,$q$, $q$'stripe_mode', 'test',
      'seats', p_seats,$q$);
    WHEN 'live_unguarded' THEN RETURN pg_temp.mut_fn('public._billing_save_deal(uuid,jsonb,uuid,text,integer)',
      $q$IF v_mode = 'live' AND NOT public._billing_brokerage_live() THEN$q$, 'IF false THEN');
    WHEN 'no_audit' THEN RETURN pg_temp.mut_fn(s,
      $q$IF coalesce((v_res ->> 'success')::boolean, false) THEN$q$, 'IF false THEN');
    WHEN 'get_no_perm' THEN RETURN pg_temp.mut_fn('public.admin_get_org_billing(uuid)',
      $q$IF NOT public.has_permission(v_uid, 'billing.view') THEN$q$, 'IF false THEN');
    WHEN 'suspend_no_perm' THEN RETURN pg_temp.mut_fn('public.admin_suspend_org(uuid,text,text)',
      $q$IF NOT public.has_permission(v_uid, 'billing.suspend') THEN$q$, 'IF false THEN');
    WHEN 'reinstate_no_perm' THEN RETURN pg_temp.mut_fn('public.admin_reinstate_org(uuid,text)',
      $q$IF NOT public.has_permission(v_uid, 'billing.suspend') THEN$q$, 'IF false THEN');
    WHEN 'am_check_caller_only' THEN RETURN pg_temp.mut_fn(s,
      'WHERE ir2.user_id = p_account_manager_id AND',
      'WHERE ir2.user_id = p_account_manager_id AND p_account_manager_id = (SELECT auth.uid()) AND');
    WHEN 'am_list_caller_only' THEN RETURN pg_temp.mut_fn('public.admin_get_org_billing(uuid)',
      'WHERE ir2.user_id = ir.user_id AND',
      'WHERE ir2.user_id = ir.user_id AND ir.user_id = (SELECT auth.uid()) AND');
    ELSE RAISE EXCEPTION 'unknown mode %', m;
    END CASE;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    o_a uuid := gen_random_uuid();   -- is_test: Sales at 2000c (19.97% off), then suspend/reinstate
    o_d uuid := gen_random_uuid();   -- is_test: Sales at 1999c (20.008% off) -> refused
    o_s uuid := gen_random_uuid();   -- is_test: Super Admin at 1999c -> saved; Sales keeps / deepens
    o_r uuid := gen_random_uuid();   -- is_test: reason / contact / account-manager refusals
    o_l uuid := gen_random_uuid();   -- NOT is_test: live deal while the switch is off
    o_c uuid := gen_random_uuid();   -- is_test: deep price on a deal that is then canceled
    o_k uuid := gen_random_uuid();   -- is_test: approved 1500c, Sales raises to 1800c (still past the cap) -> saved
    o_m uuid := gen_random_uuid();   -- is_test: approved 1500c, Sales lowers to 1400c -> refused
    u_sales uuid := gen_random_uuid(); u_super uuid := gen_random_uuid(); u_exec uuid := gen_random_uuid();
    u_sup uuid := gen_random_uuid(); u_none uuid := gen_random_uuid();
    v_team uuid; s text; n int;
    q_save text := 'SELECT public.admin_save_deal(%L::uuid, %L, %s, %s, %L, %L, %L::uuid, %L, %s)';
  BEGIN
    SELECT id INTO v_team FROM public.plans WHERE name = 'Team';
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT x, 'p3853a-' || left(x::text, 8) || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM unnest(ARRAY[u_sales, u_super, u_exec, u_sup, u_none]) x;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id)
    SELECT x, 'p3853a-' || left(x::text, 8) || '@example.test', 'email', x::text
      FROM unnest(ARRAY[u_sales, u_super, u_exec, u_sup, u_none]) x
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.internal_roles (user_id, role_id)
    SELECT x.u, ar.id FROM (VALUES (u_sales, 'sales'), (u_super, 'super-admin'), (u_exec, 'executive'), (u_sup, 'support-agent')) x(u, slug)
      JOIN public.admin_roles ar ON ar.slug = x.slug;

    INSERT INTO public.organizations (id, name, slug, max_seats, is_test) VALUES
      (o_a, 'P3853A A', 'p3853a-a-' || left(o_a::text, 8), 10, true),
      (o_d, 'P3853A D', 'p3853a-d-' || left(o_d::text, 8), 10, true),
      (o_s, 'P3853A S', 'p3853a-s-' || left(o_s::text, 8), 10, true),
      (o_r, 'P3853A R', 'p3853a-r-' || left(o_r::text, 8), 10, true),
      (o_l, 'P3853A L', 'p3853a-l-' || left(o_l::text, 8), 10, false),
      (o_c, 'P3853A C', 'p3853a-c-' || left(o_c::text, 8), 10, true),
      (o_k, 'P3853A K', 'p3853a-k-' || left(o_k::text, 8), 10, true),
      (o_m, 'P3853A M', 'p3853a-m-' || left(o_m::text, 8), 10, true);
    INSERT INTO public.organization_plans (organization_id, plan_id)
    SELECT x, v_team FROM unnest(ARRAY[o_a, o_d, o_s, o_r, o_l, o_c, o_k, o_m]) x;

    -- ===== who may call =====
    s := pg_temp.call_as(u_none, format(q_save, o_r, 'test', 5, 2499, 'B', 'b@example.test', NULL, 'new deal', 'NULL'));
    r := r || jsonb_build_object('C_nonstaff_save_refused', CASE WHEN s LIKE 'ERR 42501%' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sup, format(q_save, o_r, 'test', 5, 2499, 'B', 'b@example.test', NULL, 'new deal', 'NULL'));
    r := r || jsonb_build_object('C_support_save_refused', CASE WHEN s LIKE 'ERR 42501%' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_exec, format(q_save, o_r, 'test', 5, 2499, 'B', 'b@example.test', NULL, 'new deal', 'NULL'));
    r := r || jsonb_build_object('C_exec_view_only_save_refused', CASE WHEN s LIKE 'ERR 42501%' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sup, format('SELECT public.admin_get_org_billing(%L::uuid)', o_r));
    r := r || jsonb_build_object('C_support_view_refused', CASE WHEN s LIKE 'ERR 42501%' THEN 'PASS' ELSE 'FAIL ' || left(s, 60) END);
    s := pg_temp.call_as(u_exec, format('SELECT public.admin_get_org_billing(%L::uuid)', o_r));
    r := r || jsonb_build_object('P0_exec_can_view', CASE WHEN s NOT LIKE 'ERR%' AND (pg_temp.j(s) ->> 'can_manage') = 'false' THEN 'PASS' ELSE 'FAIL ' || left(s, 80) END);
    r := r || jsonb_build_object('C_no_deal_after_refusals', CASE WHEN NOT EXISTS (SELECT 1 FROM public.org_deals WHERE organization_id = o_r) THEN 'PASS' ELSE 'FAIL deal written' END);

    -- ===== reason, contact, account manager =====
    s := pg_temp.call_as(u_sales, format(q_save, o_r, 'test', 5, 2499, 'B', 'b@example.test', NULL, NULL, 'NULL'));
    r := r || jsonb_build_object('C_reason_null_refused', CASE WHEN pg_temp.j(s) ->> 'error' = 'reason_required' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sales, format(q_save, o_r, 'test', 5, 2499, 'B', 'b@example.test', NULL, '   ', 'NULL'));
    r := r || jsonb_build_object('C_reason_blank_refused', CASE WHEN pg_temp.j(s) ->> 'error' = 'reason_required' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sales, format(q_save, o_r, 'test', 5, 2499, 'B', '', NULL, 'new deal', 'NULL'));
    r := r || jsonb_build_object('C_contact_required', CASE WHEN pg_temp.j(s) ->> 'error' = 'billing_contact_required' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sales, format(q_save, o_r, 'test', 5, 2499, 'B', 'b@example.test', u_exec, 'new deal', 'NULL'));
    r := r || jsonb_build_object('C_account_manager_must_be_sales', CASE WHEN pg_temp.j(s) ->> 'error' = 'invalid_account_manager' THEN 'PASS' ELSE 'FAIL ' || s END);
    r := r || jsonb_build_object('C_no_deal_after_input_refusals', CASE WHEN NOT EXISTS (SELECT 1 FROM public.org_deals WHERE organization_id = o_r) THEN 'PASS' ELSE 'FAIL deal written' END);

    -- ===== the Sales cap (list 2499; 2000 = 19.97% off, 1999 = 20.008% off) =====
    s := pg_temp.call_as(u_sales, format(q_save, o_a, 'test', 5, 2000, 'Bea', 'bea@example.test', u_super, 'signed at 2000', 'NULL'));
    r := r || jsonb_build_object('C_sales_within_cap_saved', CASE WHEN pg_temp.j(s) ->> 'success' = 'true'
      AND (SELECT unit_price_cents FROM public.org_deal_lines WHERE organization_id = o_a) = 2000
      AND (SELECT account_manager_id FROM public.org_deals WHERE organization_id = o_a) = u_super THEN 'PASS' ELSE 'FAIL ' || s END);
    r := r || jsonb_build_object('C_audit_row_with_reason', CASE WHEN EXISTS (SELECT 1 FROM public.admin_audit_logs
       WHERE action = 'billing.deal_saved' AND target_id = o_a::text AND actor_id = u_sales
         AND metadata ->> 'reason' = 'signed at 2000' AND (metadata ->> 'unit_price_cents')::int = 2000) THEN 'PASS' ELSE 'FAIL no audit row' END);
    r := r || jsonb_build_object('C_change_log_with_reason', CASE WHEN EXISTS (SELECT 1 FROM public.billing_change_log
       WHERE organization_id = o_a AND action = 'deal_saved' AND detail ->> 'reason' = 'signed at 2000') THEN 'PASS' ELSE 'FAIL' END);

    s := pg_temp.call_as(u_sales, format(q_save, o_d, 'test', 5, 1999, 'Bea', 'bea@example.test', NULL, 'too deep', 'NULL'));
    r := r || jsonb_build_object('C_sales_deeper_than_cap_refused', CASE WHEN pg_temp.j(s) ->> 'error' = 'discount_needs_approval'
      AND NOT EXISTS (SELECT 1 FROM public.org_deals WHERE organization_id = o_d) THEN 'PASS' ELSE 'FAIL ' || s END);

    s := pg_temp.call_as(u_super, format(q_save, o_s, 'test', 5, 1999, 'Bea', 'bea@example.test', NULL, 'approved deep', 'NULL'));
    r := r || jsonb_build_object('C_super_deeper_allowed', CASE WHEN pg_temp.j(s) ->> 'success' = 'true'
      AND (SELECT unit_price_cents FROM public.org_deal_lines WHERE organization_id = o_s) = 1999
      AND EXISTS (SELECT 1 FROM public.admin_audit_logs WHERE target_id = o_s::text AND (metadata ->> 'over_cap')::boolean)
      THEN 'PASS' ELSE 'FAIL ' || s END);
    -- founder ruling: on a deep price Sales may keep it exactly, change contact / manager, lower seats
    s := pg_temp.call_as(u_sales, format(q_save, o_s, 'test', 5, 1999, 'Cal', 'cal@example.test', u_sales, 'new contact', '1'));
    r := r || jsonb_build_object('C_sales_keeps_price_changes_contact', CASE WHEN pg_temp.j(s) ->> 'success' = 'true'
      AND (SELECT billing_contact_email FROM public.org_deals WHERE organization_id = o_s) = 'cal@example.test' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sales, format(q_save, o_s, 'test', 4, 1999, 'Cal', 'cal@example.test', NULL, 'one seat fewer', '2'));
    r := r || jsonb_build_object('C_sales_keeps_price_lowers_seats', CASE WHEN pg_temp.j(s) ->> 'success' = 'true'
      AND (SELECT seats FROM public.org_deals WHERE organization_id = o_s) = 4 THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sales, format(q_save, o_s, 'test', 6, 1999, 'Cal', 'cal@example.test', NULL, 'more seats', '3'));
    r := r || jsonb_build_object('C_sales_keeps_price_raises_seats_refused', CASE WHEN pg_temp.j(s) ->> 'error' = 'discount_needs_approval'
      AND (SELECT seats FROM public.org_deals WHERE organization_id = o_s) = 4 THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sales, format(q_save, o_s, 'test', 4, 1998, 'Cal', 'cal@example.test', NULL, 'a cent lower', '3'));
    r := r || jsonb_build_object('C_sales_cannot_go_deeper_than_approved', CASE WHEN pg_temp.j(s) ->> 'error' = 'discount_needs_approval'
      AND (SELECT unit_price_cents FROM public.org_deal_lines WHERE organization_id = o_s) = 1999 THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_super, format(q_save, o_s, 'test', 7, 1999, 'Cal', 'cal@example.test', NULL, 'approved more seats', '3'));
    r := r || jsonb_build_object('C_super_raises_seats_allowed', CASE WHEN pg_temp.j(s) ->> 'success' = 'true'
      AND (SELECT seats FROM public.org_deals WHERE organization_id = o_s) = 7 THEN 'PASS' ELSE 'FAIL ' || s END);
    -- SR: raising to list forfeits the kept price; lowering back needs approval
    s := pg_temp.call_as(u_sales, format(q_save, o_s, 'test', 7, 2499, 'Cal', 'cal@example.test', NULL, 'back to list', '4'));
    r := r || jsonb_build_object('C_SR_raise_to_list_saved', CASE WHEN pg_temp.j(s) ->> 'success' = 'true'
      AND (SELECT unit_price_cents FROM public.org_deal_lines WHERE organization_id = o_s) = 2499 THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sales, format(q_save, o_s, 'test', 7, 1999, 'Cal', 'cal@example.test', NULL, 'deep again', '5'));
    r := r || jsonb_build_object('C_SR_raise_then_lower_refused', CASE WHEN pg_temp.j(s) ->> 'error' = 'discount_needs_approval'
      AND (SELECT unit_price_cents FROM public.org_deal_lines WHERE organization_id = o_s) = 2499 THEN 'PASS' ELSE 'FAIL ' || s END);

    -- the kept price counts only from a deal that is not canceled
    s := pg_temp.call_as(u_super, format(q_save, o_c, 'test', 5, 1999, 'Cal', 'cal@example.test', NULL, 'deep deal', 'NULL'));
    r := r || jsonb_build_object('P0_canceled_fixture_saved', CASE WHEN pg_temp.j(s) ->> 'success' = 'true' THEN 'PASS' ELSE 'FAIL ' || s END);
    UPDATE public.org_deals SET status = 'canceled' WHERE organization_id = o_c;
    s := pg_temp.call_as(u_sales, format(q_save, o_c, 'test', 5, 1999, 'Cal', 'cal@example.test', NULL, 'revive', '1'));
    r := r || jsonb_build_object('C_canceled_deal_price_not_kept', CASE WHEN pg_temp.j(s) ->> 'error' = 'discount_needs_approval'
      AND (SELECT status FROM public.org_deals WHERE organization_id = o_c) = 'canceled' THEN 'PASS' ELSE 'FAIL ' || s END);

    -- founder ruling: Sales may raise an approved deep price toward list even while still past the cap
    -- (1500c = 39.98% off, 1800c = 27.97% off); lowering it needs approval
    s := pg_temp.call_as(u_super, format(q_save, o_k, 'test', 5, 1500, 'Cal', 'cal@example.test', NULL, 'approved deep', 'NULL'));
    r := r || jsonb_build_object('P0_raise_fixture_saved', CASE WHEN pg_temp.j(s) ->> 'success' = 'true' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sales, format(q_save, o_k, 'test', 5, 1800, 'Cal', 'cal@example.test', NULL, 'raise but still deep', '1'));
    r := r || jsonb_build_object('C_SR3_sales_raise_still_deep_saved', CASE WHEN pg_temp.j(s) ->> 'success' = 'true'
      AND (SELECT unit_price_cents FROM public.org_deal_lines WHERE organization_id = o_k) = 1800 THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_super, format(q_save, o_m, 'test', 5, 1500, 'Cal', 'cal@example.test', NULL, 'approved deep', 'NULL'));
    r := r || jsonb_build_object('P0_lower_fixture_saved', CASE WHEN pg_temp.j(s) ->> 'success' = 'true' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sales, format(q_save, o_m, 'test', 5, 1400, 'Cal', 'cal@example.test', NULL, 'lower', '1'));
    r := r || jsonb_build_object('C_SR3_sales_lower_deep_refused', CASE WHEN pg_temp.j(s) ->> 'error' = 'discount_needs_approval'
      AND (SELECT unit_price_cents FROM public.org_deal_lines WHERE organization_id = o_m) = 1500 THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== darkness: live deal while the switch is off =====
    s := pg_temp.call_as(u_super, format(q_save, o_l, 'live', 5, 2499, 'Bea', 'bea@example.test', NULL, 'live deal', 'NULL'));
    r := r || jsonb_build_object('C_live_deal_refused_while_dark', CASE WHEN s NOT LIKE 'ERR%' AND pg_temp.j(s) ->> 'error' = 'billing_not_live'
      AND NOT EXISTS (SELECT 1 FROM public.org_deals WHERE organization_id = o_l) THEN 'PASS' ELSE 'FAIL ' || s END);
    r := r || jsonb_build_object('P0_switch_is_off', CASE WHEN NOT public._billing_brokerage_live() THEN 'PASS' ELSE 'FAIL switch on' END);

    -- ===== read payload =====
    s := pg_temp.call_as(u_sales, format('SELECT public.admin_get_org_billing(%L::uuid)', o_a));
    r := r || jsonb_build_object('C_view_payload', CASE WHEN s NOT LIKE 'ERR%'
      AND (pg_temp.j(s) -> 'deal' ->> 'seats')::int = 5 AND (pg_temp.j(s) -> 'seat_line' ->> 'unit_price_cents')::int = 2000
      AND (pg_temp.j(s) ->> 'list_price_cents')::int = 2499 AND (pg_temp.j(s) ->> 'cap_pct')::numeric = 20
      AND (pg_temp.j(s) ->> 'is_test')::boolean AND NOT (pg_temp.j(s) ->> 'billing_live')::boolean
      AND (pg_temp.j(s) ->> 'can_manage')::boolean AND NOT (pg_temp.j(s) ->> 'can_approve')::boolean
      AND NOT (pg_temp.j(s) -> 'deal' ? 'entitlement_prior')
      AND jsonb_array_length(pg_temp.j(s) -> 'log') >= 1
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(pg_temp.j(s) -> 'account_managers') e WHERE e ->> 'id' = u_sales::text)
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(pg_temp.j(s) -> 'account_managers') e WHERE e ->> 'id' = u_super::text)
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pg_temp.j(s) -> 'account_managers') e WHERE e ->> 'id' = u_exec::text)
      THEN 'PASS' ELSE 'FAIL ' || left(s, 120) END);

    -- ===== suspend / reinstate =====
    s := pg_temp.call_as(u_exec, format('SELECT public.admin_suspend_org(%L::uuid, %L, %L)', o_a, 'non_payment', 'x'));
    r := r || jsonb_build_object('C_exec_suspend_refused', CASE WHEN s LIKE 'ERR 42501%' AND NOT public.org_billing_suspended(o_a) THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sup, format('SELECT public.admin_suspend_org(%L::uuid, %L, %L)', o_a, 'non_payment', 'x'));
    r := r || jsonb_build_object('C_support_suspend_refused', CASE WHEN s LIKE 'ERR 42501%' AND NOT public.org_billing_suspended(o_a) THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sales, format('SELECT public.admin_suspend_org(%L::uuid, %L, %L)', o_a, 'non_payment', 'invoice unpaid'));
    r := r || jsonb_build_object('C_sales_suspends', CASE WHEN pg_temp.j(s) ->> 'success' = 'true' AND public.org_billing_suspended(o_a) THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_exec, format('SELECT public.admin_reinstate_org(%L::uuid, %L)', o_a, 'x'));
    r := r || jsonb_build_object('C_exec_reinstate_refused', CASE WHEN s LIKE 'ERR 42501%' AND public.org_billing_suspended(o_a) THEN 'PASS' ELSE 'FAIL ' || s END);
    IF NOT public.org_billing_suspended(o_a) THEN PERFORM public._billing_suspend_org(o_a, 'non_payment', 'restore', u_sales); END IF;
    s := pg_temp.call_as(u_sales, format('SELECT public.admin_reinstate_org(%L::uuid, %L)', o_a, 'paid by transfer'));
    r := r || jsonb_build_object('C_sales_reinstates', CASE WHEN pg_temp.j(s) ->> 'success' = 'true' AND NOT public.org_billing_suspended(o_a) THEN 'PASS' ELSE 'FAIL ' || s END);

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
        v_res := v_res || jsonb_build_object(v_m, 'ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 200));
      END IF;
    END;
  END LOOP;
  RAISE EXCEPTION 'P3853A_RESULT %', v_res;
END
$drv$;
