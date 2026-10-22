-- BACKLOG-3854 seats: DB controls. Venue: keepr-test, ONE call, ONE transaction ending in RAISE,
-- so nothing persists. Run after 20261021020000 is applied, or compose it in front
-- (compose.py --with-migration).
-- __MODES__ is replaced with a comma list of quoted mode names. Each mode runs in its own
-- subtransaction: apply the mutation (exact-once replace that raises on 0 or 2+ matches; the md5
-- must change, else MUTATION NOT APPLIED), build fixtures, run every check, roll back.
-- 'base' = no mutation (every check must PASS).
-- Output: RAISE 'P3854_RESULT {mode: {mutation, pass, fail, reds}}'.
-- Fixtures: auth users p3854-*@example.test, organizations "P3854 *" (is_test), Stripe ids
-- cus_p3854_* / sub_p3854_* (fictional; nothing calls Stripe).

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
    PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  END $b$$f$;

  -- run q as u with role authenticated: the jsonb text, or 'ERR <sqlstate> <message>'
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

  EXECUTE $f$CREATE FUNCTION pg_temp.j(s text) RETURNS jsonb LANGUAGE plpgsql AS $b$
  BEGIN
    IF s IS NULL OR s LIKE 'ERR%' THEN RETURN '{}'::jsonb; END IF;
    RETURN s::jsonb;
  END $b$$f$;

  -- one cell: run q as u and roll its effects back. 'allowed' | 'denied' (42501) | 'refused:<code>' | 'ERR ...'
  EXECUTE $f$CREATE FUNCTION pg_temp.cell(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE d text;
  BEGIN
    BEGIN
      d := pg_temp.call_as(u, q);
      RAISE EXCEPTION 'CELL_DONE' USING DETAIL = d;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CELL_DONE' THEN RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 60); END IF;
      GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL;
      IF d LIKE 'ERR 42501%' THEN RETURN 'denied'; END IF;
      IF d LIKE 'ERR%' THEN RETURN d; END IF;
      IF d::jsonb ->> 'success' = 'false' THEN RETURN 'refused:' || (d::jsonb ->> 'error'); END IF;
      RETURN 'allowed';
    END;
  END $b$$f$;

  -- outbox rows this feature writes, for one org
  EXECUTE $f$CREATE FUNCTION pg_temp.ob(o uuid) RETURNS int LANGUAGE sql AS $b$
    SELECT count(*)::int FROM public.billing_outbox b
     WHERE b.organization_id = o
       AND (b.kind IN ('sync_org_subscription', 'notify_seats_added')
            OR (b.kind = 'notify_account_manager' AND b.payload ->> 'reason' = 'seats_added'))
  $b$$f$;

  -- one state probe, rolled back: run setup (as the owner), then as u read broker_get_seats and
  -- call broker_add_seats(o, 1, <current version>). Returns
  -- '<add cell>|read=<cannot_add_reason>|dv=<version delta>|dob=<outbox delta>'.
  EXECUTE $f$CREATE FUNCTION pg_temp.probe(o uuid, setup text, u uuid) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE d text; v0 int; v1 int; n0 int; n1 int; rd text; c text;
  BEGIN
    BEGIN
      IF setup IS NOT NULL THEN EXECUTE setup; END IF;
      SELECT version INTO v0 FROM public.org_deals WHERE organization_id = o;
      n0 := pg_temp.ob(o);
      rd := coalesce(pg_temp.j(pg_temp.call_as(u, format('SELECT public.broker_get_seats(%L::uuid)', o))) ->> 'cannot_add_reason', 'none');
      d := pg_temp.call_as(u, format('SELECT public.broker_add_seats(%L::uuid, 1, %s)', o, coalesce(v0::text, 'NULL')));
      c := CASE WHEN d LIKE 'ERR 42501%' THEN 'denied' WHEN d LIKE 'ERR%' THEN d
                WHEN d::jsonb ->> 'success' = 'false' THEN 'refused:' || (d::jsonb ->> 'error') ELSE 'allowed' END;
      SELECT version INTO v1 FROM public.org_deals WHERE organization_id = o;
      n1 := pg_temp.ob(o);
      RAISE EXCEPTION 'PROBE_DONE' USING DETAIL = c || '|read=' || rd || '|dv=' || coalesce((v1 - v0)::text, 'x') || '|dob=' || (n1 - n0);
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'PROBE_DONE' THEN RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
      GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL;
      RETURN d;
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
    RETURN 'MUTATION APPLIED ' || p_sig || ' ' || left(m1, 8) || '->' || left(m2, 8) || ' [' || left(replace(p_to, E'\n', ' '), 70) || ']';
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.pass(ok boolean, info text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL ' || coalesce(left(info, 200), '') END
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE
    ad text := 'public.broker_add_seats(uuid,integer,integer)';
    gs text := 'public.broker_get_seats(uuid)';
    rf text := 'public._org_seat_add_refusal(public.org_deals)';
  BEGIN
    CASE m
    WHEN 'base' THEN RETURN 'none';
    -- W1: the client's number is used as the new total
    WHEN 'w1_client_total' THEN RETURN pg_temp.mut_fn(ad, 'v_to := v_deal.seats + p_add;', 'v_to := p_add;');
    -- W2: IT admin may add seats
    WHEN 'w2_it_admin_adds' THEN RETURN pg_temp.mut_fn(ad, $q$public._org_contact_caller(p_org, true) IS DISTINCT FROM 'broker'$q$,
      $q$coalesce(public._org_contact_caller(p_org, true), '') NOT IN ('broker', 'it_admin')$q$);
    -- W3: the auto-renew caller copied (admin + billing contact; Broker refused)
    WHEN 'w3_auto_renew_caller' THEN RETURN pg_temp.mut_fn(ad, $q$public._org_contact_caller(p_org, true) IS DISTINCT FROM 'broker'$q$,
      $q$coalesce(public._org_auto_renew_caller(p_org), '') NOT IN ('admin', 'billing_contact')$q$);
    -- reader: the billing contact branch dropped
    WHEN 'r_no_contact_read' THEN RETURN pg_temp.mut_fn(gs, 'IF v_caller IS NULL AND NOT v_bc THEN', 'IF v_caller IS NULL THEN');
    -- reader: the price for every reader
    WHEN 'r_price_for_all' THEN RETURN pg_temp.mut_fn(gs, $q$IF v_caller = 'broker' AND v_deal.organization_id IS NOT NULL THEN$q$,
      'IF v_deal.organization_id IS NOT NULL THEN');
    -- S6: counts only active licences (a pending invite holds a seat)
    WHEN 's6_active_only' THEN RETURN pg_temp.mut_fn(gs, 'AND public.member_row_holds_seat(m.license_status, m.invitation_expires_at, m.user_id);',
      $q$AND m.license_status = 'active';$q$);
    -- S6: free not floored
    WHEN 's6_no_floor' THEN RETURN pg_temp.mut_fn(gs, 'greatest(v_max - v_used, 0)', 'v_max - v_used');
    -- S2 sweep: each refusal dropped
    WHEN 's2_no_draft' THEN RETURN pg_temp.mut_fn(rf, $q$WHEN p_deal.status = 'draft' THEN 'deal_not_started'$q$, $q$WHEN false THEN 'deal_not_started'$q$);
    WHEN 's2_no_suspended' THEN RETURN pg_temp.mut_fn(rf, $q$WHEN p_deal.status = 'suspended' THEN 'deal_suspended'$q$, $q$WHEN false THEN 'deal_suspended'$q$);
    WHEN 's2_no_canceling' THEN RETURN pg_temp.mut_fn(rf, $q$WHEN p_deal.status = 'canceling' THEN 'deal_canceling'$q$, $q$WHEN false THEN 'deal_canceling'$q$);
    WHEN 's2_no_canceled' THEN RETURN pg_temp.mut_fn(rf, $q$WHEN p_deal.status = 'canceled' THEN 'deal_canceled'$q$, $q$WHEN false THEN 'deal_canceled'$q$);
    WHEN 's2_no_live_gate' THEN RETURN pg_temp.mut_fn(rf, $q$WHEN p_deal.stripe_mode = 'live' AND NOT public._billing_brokerage_live() THEN 'billing_not_live'$q$,
      $q$WHEN false THEN 'billing_not_live'$q$);
    WHEN 's2_no_past_due' THEN RETURN pg_temp.mut_fn(rf, $q$s.status IN ('past_due', 'unpaid')$q$, $q$s.status IN ('unpaid')$q$);
    WHEN 's2_no_unpaid' THEN RETURN pg_temp.mut_fn(rf, $q$s.status IN ('past_due', 'unpaid')$q$, $q$s.status IN ('past_due')$q$);
    WHEN 's2_no_mode_join' THEN RETURN pg_temp.mut_fn(rf, 'AND s.stripe_mode = p_deal.stripe_mode', '');
    -- S4: no expected-version check
    WHEN 's4_no_version' THEN RETURN pg_temp.mut_fn(ad, 'IF p_expected_version IS DISTINCT FROM v_deal.version THEN', 'IF false THEN');
    -- W10: a different lock key (no mutual exclusion with Edit deal / auto-renew)
    WHEN 'w10_other_lock' THEN RETURN pg_temp.mut_fn(ad, $q$hashtextextended('billing_org:' || p_org::text, 0)$q$,
      $q$hashtextextended('billing_seats:' || p_org::text, 0)$q$);
    -- S5: the billing-contact email not queued / the account-manager alert not queued
    WHEN 's5_no_email' THEN RETURN pg_temp.mut_fn(ad, $q$'notify_seats_added', p_org,$q$, $q$'notify_seats_added_off', p_org,$q$);
    WHEN 's5_no_am' THEN RETURN pg_temp.mut_fn(ad, $q$'notify_account_manager', p_org,$q$, $q$'notify_account_manager_off', p_org,$q$);
    -- S5: the email key without the version (the second add's row is lost)
    WHEN 's5_key_no_version' THEN RETURN pg_temp.mut_fn(ad, $q$':' || p_org::text || ':v' || v_version::text,$q$, $q$':' || p_org::text,$q$);
    -- grants
    WHEN 'g_add_to_anon' THEN
      EXECUTE 'GRANT EXECUTE ON FUNCTION public.broker_add_seats(uuid,integer,integer) TO anon';
      IF NOT has_function_privilege('anon', 'public.broker_add_seats(uuid,integer,integer)', 'EXECUTE') THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF;
      RETURN 'MUTATION APPLIED GRANT EXECUTE broker_add_seats TO anon';
    WHEN 'g_helper_to_authenticated' THEN
      EXECUTE 'GRANT EXECUTE ON FUNCTION public._org_seat_add_refusal(public.org_deals) TO authenticated';
      IF NOT has_function_privilege('authenticated', 'public._org_seat_add_refusal(public.org_deals)', 'EXECUTE') THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF;
      RETURN 'MUTATION APPLIED GRANT EXECUTE _org_seat_add_refusal TO authenticated';
    ELSE RAISE EXCEPTION 'unknown mode %', m;
    END CASE;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    oa uuid := gen_random_uuid();  -- main brokerage: active deal, 8 seats, 6 holding a seat
    ob uuid := gen_random_uuid();  -- the billing-only login's brokerage
    oc uuid := gen_random_uuid();  -- over its limit: 1 seat bought, 3 held
    od uuid := gen_random_uuid();  -- no seat limit (max_seats NULL)
    ox uuid := gen_random_uuid();  -- another brokerage (lock check)
    u_sales uuid := gen_random_uuid(); u_adm uuid := gen_random_uuid(); u_br uuid := gen_random_uuid();
    u_it uuid := gen_random_uuid(); u_ag uuid := gen_random_uuid(); u_bc uuid := gen_random_uuid();
    u_bo uuid := gen_random_uuid(); u_ua uuid := gen_random_uuid(); u_x uuid := gen_random_uuid();
    u_c1 uuid := gen_random_uuid(); u_c2 uuid := gen_random_uuid(); u_c3 uuid := gen_random_uuid();
    m_bc uuid; m_bo uuid; v_team uuid;
    s text; s2 text; v jsonb; v2 jsonb; v_ver int; n int;
    q_add text := 'SELECT public.broker_add_seats(%L::uuid, %s, %s)';
    q_get text := 'SELECT public.broker_get_seats(%L::uuid)';
  BEGIN
    SELECT id INTO v_team FROM public.plans WHERE name = 'Team';

    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT x, 'p3854-' || left(x::text, 8) || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM unnest(ARRAY[u_sales, u_adm, u_br, u_it, u_ag, u_bc, u_bo, u_ua, u_x, u_c1, u_c2, u_c3]) x;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    SELECT x, (SELECT a.email FROM auth.users a WHERE a.id = x), 'email', x::text, 'P3854 ' || left(x::text, 4)
      FROM unnest(ARRAY[u_sales, u_adm, u_br, u_it, u_ag, u_bc, u_bo, u_ua, u_x, u_c1, u_c2, u_c3]) x
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.internal_roles (user_id, role_id)
    SELECT u_sales, ar.id FROM public.admin_roles ar WHERE ar.slug = 'sales';

    INSERT INTO public.organizations (id, name, slug, max_seats, is_test)
    SELECT x, 'P3854 ' || left(x::text, 8), 'p3854-' || left(x::text, 8), NULL, true FROM unnest(ARRAY[oa, ob, oc, od, ox]) x;
    INSERT INTO public.organization_plans (organization_id, plan_id) SELECT x, v_team FROM unnest(ARRAY[oa, ob, oc, od, ox]) x;

    -- oa: 6 seat holders (adm, br, it, ag, bc, a pending unexpired invite); not holding: an
    -- expired invite, an unassigned admin, a suspended agent.
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, created_at) VALUES
      (oa, u_adm, 'admin', 'active', now(), now()), (oa, u_br, 'broker', 'active', now(), now()),
      (oa, u_it, 'it_admin', 'active', now(), now()), (oa, u_ag, 'agent', 'active', now(), now()),
      (oa, u_ua, 'admin', 'unassigned', now(), now());
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, created_at)
      VALUES (oa, u_bc, 'agent', 'active', now(), now()) RETURNING id INTO m_bc;
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, invited_email, invitation_expires_at, created_at) VALUES
      (oa, NULL, 'agent', 'pending', 'p3854-inv1@example.test', now() + interval '5 days', now()),
      (oa, NULL, 'agent', 'pending', 'p3854-inv2@example.test', now() - interval '1 day', now());
    INSERT INTO public.org_contacts (organization_id, role, member_id) VALUES (oa, 'billing', m_bc);
    -- ob: an admin and the billing-only login as the live contact
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, created_at)
      VALUES (ob, u_x, 'admin', 'active', now(), now());
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, created_at, provisioning_metadata)
      VALUES (ob, u_bo, 'agent', 'unassigned', now(), now(), '{"billing_only":"true"}') RETURNING id INTO m_bo;
    INSERT INTO public.org_contacts (organization_id, role, member_id) VALUES (ob, 'billing', m_bo);
    -- oc: three active, limit set to 1 afterwards
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, created_at) VALUES
      (oc, u_c1, 'admin', 'active', now(), now()), (oc, u_c2, 'agent', 'active', now(), now()), (oc, u_c3, 'agent', 'active', now(), now());
    -- od: one admin, no limit
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, created_at)
      VALUES (od, u_c1, 'admin', 'active', now(), now());
    -- ox: u_x is its admin too
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, created_at)
      VALUES (ox, u_x, 'admin', 'active', now(), now());

    UPDATE public.organizations SET max_seats = 8 WHERE id = oa;
    UPDATE public.organizations SET max_seats = 5 WHERE id IN (ob, ox);
    UPDATE public.organizations SET max_seats = 1 WHERE id = oc;
    INSERT INTO public.org_deals (organization_id, stripe_mode, plan_id, seats, start_date, status, version, account_manager_id)
    VALUES (oa, 'test', v_team, 8, current_date, 'active', 1, u_sales),
           (ob, 'test', v_team, 5, current_date, 'active', 1, NULL),
           (oc, 'test', v_team, 1, current_date, 'active', 1, NULL),
           (od, 'test', v_team, 5, current_date, 'active', 1, NULL),
           (ox, 'test', v_team, 5, current_date, 'active', 1, NULL);
    INSERT INTO public.org_deal_lines (organization_id, item_key, quantity_rule, unit_price_cents)
    SELECT x, 'brokerage_seat', 'seats', 2499 FROM unnest(ARRAY[oa, ob, oc, od, ox]) x;
    INSERT INTO public.org_billing_stripe (organization_id, stripe_mode, stripe_customer_id, stripe_subscription_id, status)
    SELECT x, 'test', 'cus_p3854_' || left(x::text, 8), 'sub_p3854_' || left(x::text, 8), 'active' FROM unnest(ARRAY[oa, ob, oc, od, ox]) x;

    -- ===== S1 caller sweep (write): cells roll back =====
    s := 'br=' || pg_temp.cell(u_br, format(q_add, oa, 1, 1)) || ' adm=' || pg_temp.cell(u_adm, format(q_add, oa, 1, 1))
      || ' it=' || pg_temp.cell(u_it, format(q_add, oa, 1, 1)) || ' ag=' || pg_temp.cell(u_ag, format(q_add, oa, 1, 1))
      || ' bc=' || pg_temp.cell(u_bc, format(q_add, oa, 1, 1)) || ' ua=' || pg_temp.cell(u_ua, format(q_add, oa, 1, 1))
      || ' x=' || pg_temp.cell(u_x, format(q_add, oa, 1, 1)) || ' staff=' || pg_temp.cell(u_sales, format(q_add, oa, 1, 1))
      || ' anon=' || pg_temp.cell(NULL, format(q_add, oa, 1, 1)) || ' bo=' || pg_temp.cell(u_bo, format(q_add, ob, 1, 1))
      || ' ob_adm=' || pg_temp.cell(u_x, format(q_add, ob, 1, 1));
    r := r || jsonb_build_object('S1_write_callers', pg_temp.pass(
      s = 'br=allowed adm=allowed it=denied ag=denied bc=denied ua=denied x=denied staff=denied anon=denied bo=denied ob_adm=allowed', s));

    -- ===== S1 caller sweep (read) =====
    s := 'it=' || coalesce(pg_temp.j(pg_temp.call_as(u_it, format(q_get, oa))) ->> 'in_use', 'ERR')
      || ' bc=' || coalesce(pg_temp.j(pg_temp.call_as(u_bc, format(q_get, oa))) ->> 'in_use', 'ERR')
      || ' bo=' || coalesce(pg_temp.j(pg_temp.call_as(u_bo, format(q_get, ob))) ->> 'in_use', 'ERR')
      || ' staff=' || coalesce(pg_temp.j(pg_temp.call_as(u_sales, format(q_get, oa))) ->> 'in_use', 'ERR')
      || ' ag=' || left(pg_temp.call_as(u_ag, format(q_get, oa)), 9)
      || ' ua=' || left(pg_temp.call_as(u_ua, format(q_get, oa)), 9)
      || ' x=' || left(pg_temp.call_as(u_x, format(q_get, oa)), 9)
      || ' anon=' || left(pg_temp.call_as(NULL, format(q_get, oa)), 9);
    r := r || jsonb_build_object('S1_read_callers', pg_temp.pass(
      s = 'it=6 bc=6 bo=1 staff=6 ag=ERR 42501 ua=ERR 42501 x=ERR 42501 anon=ERR 42501', s));
    -- can_add only for Broker/Admin; IT admin / billing contact / billing-only login read not_allowed
    s := 'br=' || coalesce(pg_temp.j(pg_temp.call_as(u_br, format(q_get, oa))) ->> 'can_add', '?')
      || ' it=' || coalesce(pg_temp.j(pg_temp.call_as(u_it, format(q_get, oa))) ->> 'cannot_add_reason', '?')
      || ' bc=' || coalesce(pg_temp.j(pg_temp.call_as(u_bc, format(q_get, oa))) ->> 'cannot_add_reason', '?')
      || ' bo=' || coalesce(pg_temp.j(pg_temp.call_as(u_bo, format(q_get, ob))) ->> 'cannot_add_reason', '?')
      || ' staff=' || coalesce(pg_temp.j(pg_temp.call_as(u_sales, format(q_get, oa))) ->> 'cannot_add_reason', '?');
    r := r || jsonb_build_object('S1_can_add_by_role', pg_temp.pass(
      s = 'br=true it=not_allowed bc=not_allowed bo=not_allowed staff=not_allowed', s));
    -- price and account manager email: Broker/Admin only (+ AM email for the billing contact)
    v := pg_temp.j(pg_temp.call_as(u_br, format(q_get, oa)));
    v2 := pg_temp.j(pg_temp.call_as(u_it, format(q_get, oa)));
    r := r || jsonb_build_object('S1_price_broker_only', pg_temp.pass(
      v ->> 'unit_price_cents' = '2499' AND v ->> 'account_manager_email' LIKE 'p3854-%@example.test'
      AND (v2 ->> 'unit_price_cents') IS NULL AND (v2 ->> 'account_manager_email') IS NULL
      AND (pg_temp.j(pg_temp.call_as(u_bc, format(q_get, oa))) ->> 'unit_price_cents') IS NULL
      AND (pg_temp.j(pg_temp.call_as(u_bc, format(q_get, oa))) ->> 'account_manager_email') IS NOT NULL,
      'br=' || v::text || ' it=' || v2::text));

    -- ===== S2 state sweep: each refused with its code, no version change, no outbox row;
    -- the read reports the same code. 'active' and a 'trialing' mirror allowed. =====
    s := pg_temp.probe(oa, NULL, u_br);
    r := r || jsonb_build_object('S2_active_allowed', pg_temp.pass(s = 'allowed|read=none|dv=1|dob=3', s));
    s := pg_temp.probe(oa, format($q$UPDATE public.org_billing_stripe SET status = 'trialing' WHERE organization_id = %L$q$, oa), u_br);
    r := r || jsonb_build_object('S2_trialing_allowed', pg_temp.pass(s = 'allowed|read=none|dv=1|dob=3', s));
    s := pg_temp.probe(oa, format($q$UPDATE public.org_deals SET status = 'draft' WHERE organization_id = %L$q$, oa), u_br);
    r := r || jsonb_build_object('S2_draft', pg_temp.pass(s = 'refused:deal_not_started|read=deal_not_started|dv=0|dob=0', s));
    s := pg_temp.probe(oa, format($q$UPDATE public.org_deals SET status = 'suspended', status_before_suspension = 'active', suspended_reason = 'other', suspended_at = now() WHERE organization_id = %L$q$, oa), u_br);
    r := r || jsonb_build_object('S2_suspended', pg_temp.pass(s = 'refused:deal_suspended|read=deal_suspended|dv=0|dob=0', s));
    s := pg_temp.probe(oa, format($q$UPDATE public.org_deals SET status = 'canceling' WHERE organization_id = %L$q$, oa), u_br);
    r := r || jsonb_build_object('S2_canceling', pg_temp.pass(s = 'refused:deal_canceling|read=deal_canceling|dv=0|dob=0', s));
    s := pg_temp.probe(oa, format($q$UPDATE public.org_deals SET status = 'canceled' WHERE organization_id = %L$q$, oa), u_br);
    r := r || jsonb_build_object('S2_canceled', pg_temp.pass(s = 'refused:deal_canceled|read=deal_canceled|dv=0|dob=0', s));
    s := pg_temp.probe(oa, format($q$UPDATE public.org_billing_stripe SET stripe_mode = 'live' WHERE organization_id = %1$L; UPDATE public.org_deals SET stripe_mode = 'live' WHERE organization_id = %1$L$q$, oa), u_br);
    r := r || jsonb_build_object('S2_live_switch_off', pg_temp.pass(
      NOT public._billing_brokerage_live() AND s = 'refused:billing_not_live|read=billing_not_live|dv=0|dob=0', s));
    s := pg_temp.probe(oa, format($q$UPDATE public.org_billing_stripe SET status = 'past_due' WHERE organization_id = %L$q$, oa), u_br);
    r := r || jsonb_build_object('S2_past_due', pg_temp.pass(s = 'refused:invoice_overdue|read=invoice_overdue|dv=0|dob=0', s));
    s := pg_temp.probe(oa, format($q$UPDATE public.org_billing_stripe SET status = 'unpaid' WHERE organization_id = %L$q$, oa), u_br);
    r := r || jsonb_build_object('S2_unpaid', pg_temp.pass(s = 'refused:invoice_overdue|read=invoice_overdue|dv=0|dob=0', s));
    -- the OTHER mode's mirror row past due: allowed (the join is on the deal's mode)
    s := pg_temp.probe(oa, format($q$INSERT INTO public.org_billing_stripe (organization_id, stripe_mode, stripe_customer_id, status) VALUES (%L, 'live', 'cus_p3854_live', 'past_due')$q$, oa), u_br);
    r := r || jsonb_build_object('S2_other_mode_past_due_allowed', pg_temp.pass(s = 'allowed|read=none|dv=1|dob=3', s));

    -- ===== S3 increase only, the total from the stored seats =====
    s := pg_temp.cell(u_br, format(q_add, oa, 'NULL', 1)) || ',' || pg_temp.cell(u_br, format(q_add, oa, 0, 1)) || ','
      || pg_temp.cell(u_br, format(q_add, oa, -1, 1)) || ',' || pg_temp.cell(u_br, format(q_add, oa, 10001, 1));
    r := r || jsonb_build_object('S3_invalid_counts', pg_temp.pass(
      s = 'refused:invalid_seats,refused:invalid_seats,refused:invalid_seats,refused:invalid_seats', s));
    -- over the limit: 1 bought, 3 held, +1 -> 2 < 3 refused (and the read says free 0)
    v := pg_temp.j(pg_temp.call_as(u_c1, format(q_get, oc)));
    s := pg_temp.cell(u_c1, format(q_add, oc, 1, 1));
    r := r || jsonb_build_object('S3_below_assigned', pg_temp.pass(
      s = 'refused:seats_below_assigned' AND v ->> 'free' = '0' AND v ->> 'in_use' = '3' AND v ->> 'bought' = '1', s || ' ' || v::text));

    -- ===== S6 counts =====
    v := pg_temp.j(pg_temp.call_as(u_br, format(q_get, oa)));
    v2 := pg_temp.j(pg_temp.call_as(u_c1, format(q_get, od)));
    r := r || jsonb_build_object('S6_counts', pg_temp.pass(
      v ->> 'bought' = '8' AND v ->> 'in_use' = '6' AND v ->> 'free' = '2' AND v ->> 'unlimited' = 'false'
      AND v ->> 'version' = '1' AND v ->> 'trialing' = 'false'
      AND v ->> 'in_use' = (SELECT count(*)::text FROM public.organization_members m WHERE m.organization_id = oa
                               AND public.member_row_holds_seat(m.license_status, m.invitation_expires_at, m.user_id)),
      v::text));
    UPDATE public.organizations SET max_seats = NULL WHERE id = od;
    v2 := pg_temp.j(pg_temp.call_as(u_c1, format(q_get, od)));
    r := r || jsonb_build_object('S6_unlimited', pg_temp.pass(
      v2 ->> 'unlimited' = 'true' AND (v2 ->> 'bought') IS NULL AND v2 ->> 'in_use' = '1', v2::text));

    -- ===== W10: the lock is the shared billing_org key (checked on a refused call, so only
    -- broker_add_seats itself took it) =====
    s := pg_temp.call_as(u_x, format(q_add, ox, 1, 99));
    r := r || jsonb_build_object('W10_lock_key', pg_temp.pass(
      pg_temp.j(s) ->> 'error' = 'version_conflict'
      AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid() AND l.objsubid = 1
                   AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended('billing_org:' || ox::text, 0)), s));

    -- ===== S4 + S5: two adds, effects persist inside this mode =====
    v := pg_temp.j(pg_temp.call_as(u_adm, format(q_add, oa, 2, 1)));
    v2 := pg_temp.j(pg_temp.call_as(u_adm, format(q_add, oa, 2, 1)));
    SELECT d.version INTO v_ver FROM public.org_deals d WHERE d.organization_id = oa;
    r := r || jsonb_build_object('S3_server_total', pg_temp.pass(
      v ->> 'success' = 'true' AND v ->> 'seats_from' = '8' AND v ->> 'seats_to' = '10'
      AND (SELECT seats FROM public.org_deals WHERE organization_id = oa) = 10, v::text));
    r := r || jsonb_build_object('S4_version_conflict', pg_temp.pass(
      v2 ->> 'error' = 'version_conflict' AND v_ver = 2 AND (SELECT seats FROM public.org_deals WHERE organization_id = oa) = 10, v2::text));
    r := r || jsonb_build_object('S5_effects', pg_temp.pass(
      (SELECT max_seats FROM public.organizations WHERE id = oa) = 10
      AND EXISTS (SELECT 1 FROM public.billing_change_log l WHERE l.organization_id = oa AND l.action = 'seats_changed'
                   AND l.actor_id = u_adm AND l.detail ->> 'from' = '8' AND l.detail ->> 'to' = '10')
      AND (SELECT count(*) FROM public.billing_outbox b WHERE b.organization_id = oa AND b.kind = 'sync_org_subscription' AND b.dedupe_key LIKE '%:v2') = 1
      AND NOT EXISTS (SELECT 1 FROM public.billing_outbox b WHERE b.organization_id = oa AND b.kind = 'sync_org_subscription' AND b.dedupe_key LIKE '%:v3'),
      'max=' || (SELECT max_seats FROM public.organizations WHERE id = oa)::text));
    r := r || jsonb_build_object('S5_two_notify_rows', pg_temp.pass(
      (SELECT count(*) FROM public.billing_outbox b WHERE b.organization_id = oa AND b.kind = 'notify_account_manager'
         AND b.payload ->> 'reason' = 'seats_added' AND b.dedupe_key = 'notify_account_manager:test:' || oa || ':seats_added:v2'
         AND b.payload ->> 'detail' LIKE 'Added by % (Admin): 8 to 10 seats. A prorated charge%') = 1
      AND (SELECT count(*) FROM public.billing_outbox b WHERE b.organization_id = oa AND b.kind = 'notify_seats_added'
         AND b.dedupe_key = 'notify_seats_added:test:' || oa || ':v2'
         AND b.payload ->> 'seats_from' = '8' AND b.payload ->> 'seats_to' = '10' AND b.payload ->> 'trialing' = 'false') = 1,
      (SELECT string_agg(b.kind || '=' || (b.payload ->> 'detail'), ' ') FROM public.billing_outbox b WHERE b.organization_id = oa AND b.kind <> 'sync_org_subscription')));
    -- a second add (fresh version) as the Broker -> four notify rows in all
    v := pg_temp.j(pg_temp.call_as(u_br, format(q_add, oa, 1, 2)));
    SELECT count(*) INTO n FROM public.billing_outbox b WHERE b.organization_id = oa
       AND (b.kind = 'notify_seats_added' OR (b.kind = 'notify_account_manager' AND b.payload ->> 'reason' = 'seats_added'));
    r := r || jsonb_build_object('S5_second_add_four_rows', pg_temp.pass(
      v ->> 'success' = 'true' AND n = 4
      AND EXISTS (SELECT 1 FROM public.billing_outbox b WHERE b.organization_id = oa AND b.kind = 'notify_account_manager'
                   AND b.payload ->> 'detail' LIKE '% (Broker): 10 to 11 seats.%'),
      v::text || ' n=' || n));
    -- S6 after an add: the limit and the bill agree
    r := r || jsonb_build_object('S6_max_equals_deal', pg_temp.pass(
      (SELECT max_seats FROM public.organizations WHERE id = oa) = (SELECT seats FROM public.org_deals WHERE organization_id = oa)
      AND pg_temp.j(pg_temp.call_as(u_br, format(q_get, oa))) ->> 'bought' = '11', 'agree'));

    -- ===== grants =====
    r := r || jsonb_build_object('G_grants', pg_temp.pass(
      NOT has_function_privilege('anon', 'public.broker_add_seats(uuid,integer,integer)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.broker_get_seats(uuid)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public._org_seat_add_refusal(public.org_deals)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.broker_add_seats(uuid,integer,integer)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.broker_get_seats(uuid)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public._org_seat_add_refusal(public.org_deals)', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.broker_add_seats(uuid,integer,integer)', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.broker_get_seats(uuid)', 'EXECUTE')
      AND has_function_privilege('service_role', 'public._org_seat_add_refusal(public.org_deals)', 'EXECUTE')
      AND (SELECT bool_and(p.proconfig @> ARRAY['search_path=""']) FROM pg_proc p
            WHERE p.oid IN ('public.broker_add_seats(uuid,integer,integer)'::regprocedure, 'public.broker_get_seats(uuid)'::regprocedure,
                            'public._org_seat_add_refusal(public.org_deals)'::regprocedure)), 'grants'));

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
  RAISE EXCEPTION 'P3854_RESULT %', v_res;
END
$drv$;
