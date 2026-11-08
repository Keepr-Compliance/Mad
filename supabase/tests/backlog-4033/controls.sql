-- BACKLOG-4033 DB controls: the 365-day start-date cap in _billing_save_deal.
-- Venue: keepr-test, ONE call, ONE transaction that ends in RAISE, so nothing persists.
-- Run after 20261108210000 is applied, or compose it in front (compose.py --with-migration).
-- __MODES__ is replaced with a comma list of quoted mode names. Each mode runs in its own
-- subtransaction: apply the mutation (exact-once replace that raises on 0 or 2+ matches; the md5
-- of pg_get_functiondef must change, else MUTATION NOT APPLIED), build fixtures, run every
-- check, roll back. 'base' = no mutation (every check must PASS).
-- Output: RAISE 'P4033_RESULT {mode: {mutation, pass, fail, reds}}'.
-- Fixtures: new auth users p4033-*@example.test, new organizations P4033 *.
-- Helpers (as_user, call_as, j, mut_fn) are copied from supabase/tests/backlog-4007/controls.sql.

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

  -- run one statement as an authenticated user; jsonb result as text, or 'ERR <sqlstate> <msg>'
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

  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE
    sd text := 'public._billing_save_deal(uuid,jsonb,uuid,text,integer)';
  BEGIN
    CASE m
    WHEN 'base' THEN RETURN 'none';
    -- cap removed on an existing deal's changed date
    WHEN 'no_cap_existing' THEN RETURN pg_temp.mut_fn(sd,
      $q$      IF v_start > v_today + 365 THEN$q$, $q$      IF false THEN$q$);
    -- cap removed on a new deal
    WHEN 'no_cap_new' THEN RETURN pg_temp.mut_fn(sd,
      $q$IF v_start IS NOT NULL AND v_start > v_today + 365 THEN$q$, $q$IF false THEN$q$);
    -- off by one: +365 refused
    WHEN 'gte_existing' THEN RETURN pg_temp.mut_fn(sd,
      $q$      IF v_start > v_today + 365 THEN$q$, $q$      IF v_start >= v_today + 365 THEN$q$);
    WHEN 'gte_new' THEN RETURN pg_temp.mut_fn(sd,
      $q$IF v_start IS NOT NULL AND v_start > v_today + 365 THEN$q$, $q$IF v_start IS NOT NULL AND v_start >= v_today + 365 THEN$q$);
    -- SR: the existing-deal cap placed after the IS DISTINCT FROM block (just before the UPDATE),
    -- so an unchanged far date is re-checked
    WHEN 'cap_after_distinct_block' THEN RETURN pg_temp.mut_fn(sd,
      $q$      -- BACKLOG-4033: at most 365 days after the business date (dealRules.ts MAX_START_DAYS_AHEAD).
      IF v_start > v_today + 365 THEN
        RETURN jsonb_build_object('success', false, 'error', 'start_date_too_far', 'latest', v_today + 365);
      END IF;
    END IF;
    UPDATE public.org_deals SET$q$,
      $q$    END IF;
    IF v_start > v_today + 365 THEN
      RETURN jsonb_build_object('success', false, 'error', 'start_date_too_far', 'latest', v_today + 365);
    END IF;
    UPDATE public.org_deals SET$q$);
    -- plan: the cap checked before the lock test (inside the block, first)
    WHEN 'cap_before_lock' THEN RETURN pg_temp.mut_fn(sd,
      $q$      -- After setup the start date is the contract record (founder 2026-10-19).
      IF v_deal.status <> 'draft' THEN$q$,
      $q$      IF v_start > v_today + 365 THEN
        RETURN jsonb_build_object('success', false, 'error', 'start_date_too_far', 'latest', v_today + 365);
      END IF;
      IF v_deal.status <> 'draft' THEN$q$);
    -- calendar year instead of +365 days (differs only across a Feb 29)
    WHEN 'interval_year_new' THEN RETURN pg_temp.mut_fn(sd,
      $q$IF v_start IS NOT NULL AND v_start > v_today + 365 THEN$q$, $q$IF v_start IS NOT NULL AND v_start > v_today + interval '1 year' THEN$q$);
    -- server date instead of the business date
    WHEN 'current_date_new' THEN RETURN pg_temp.mut_fn(sd,
      $q$IF v_start IS NOT NULL AND v_start > v_today + 365 THEN$q$, $q$IF v_start IS NOT NULL AND v_start > current_date + 365 THEN$q$);
    WHEN 'current_date_existing' THEN RETURN pg_temp.mut_fn(sd,
      $q$      IF v_start > v_today + 365 THEN$q$, $q$      IF v_start > current_date + 365 THEN$q$);
    ELSE RAISE EXCEPTION 'unknown mode %', m;
    END CASE;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    n364 uuid := gen_random_uuid(); n365 uuid := gen_random_uuid(); n366 uuid := gen_random_uuid();
    e1 uuid := gen_random_uuid();   -- changed draft date, sequential +364 / +365 / +366
    u1 uuid := gen_random_uuid();   -- unchanged existing date seeded at +364 / +365 / +366 / +400
    l1 uuid := gen_random_uuid();   -- non-draft deal: lock wins
    p1 uuid := gen_random_uuid();   -- past date still refused (new + changed)
    t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid();   -- business-date pinned 2030-01-01
    y1 uuid := gen_random_uuid(); y2 uuid := gen_random_uuid();   -- business-date pinned 2027-03-01 (leap year ahead)
    t3 uuid := gen_random_uuid();   -- existing deal under the 2030 pin
    u_sales uuid := gen_random_uuid();
    v_team uuid; s text; bd date; k int; dd date;
    q10 text := 'SELECT public.admin_save_deal(%L::uuid, %L, %s, %s, NULL, NULL, NULL::uuid, %L, %s, %s)';
  BEGIN
    SELECT id INTO v_team FROM public.plans WHERE name = 'Team';
    bd := public._billing_business_date();

    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (u_sales, 'p4033-' || left(u_sales::text, 8) || '@example.test', 'authenticated', 'authenticated',
            '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now());
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    VALUES (u_sales, 'p4033-' || left(u_sales::text, 8) || '@example.test', 'email', u_sales::text, 'P4033 sales')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.internal_roles (user_id, role_id) SELECT u_sales, ar.id FROM public.admin_roles ar WHERE ar.slug = 'sales';
    INSERT INTO public.organizations (id, name, slug, max_seats, is_test)
    SELECT x, 'P4033 ' || left(x::text, 8), 'p4033-' || left(x::text, 8), 10, true
      FROM unnest(ARRAY[n364, n365, n366, e1, u1, l1, p1, t1, t2, y1, y2, t3]) x;
    INSERT INTO public.organization_plans (organization_id, plan_id) SELECT x, v_team
      FROM unnest(ARRAY[n364, n365, n366, e1, u1, l1, p1, t1, t2, y1, y2, t3]) x;

    -- ===== new deal sweep =====
    s := pg_temp.call_as(u_sales, format(q10, n364, 'test', 5, 2499, 'new', 'NULL', quote_literal((bd + 364)::text) || '::date'));
    r := r || jsonb_build_object('N364_new_deal_accepted', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND (SELECT start_date FROM public.org_deals WHERE organization_id = n364) = bd + 364 THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sales, format(q10, n365, 'test', 5, 2499, 'new', 'NULL', quote_literal((bd + 365)::text) || '::date'));
    r := r || jsonb_build_object('N365_new_deal_accepted', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND (SELECT start_date FROM public.org_deals WHERE organization_id = n365) = bd + 365 THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sales, format(q10, n366, 'test', 5, 2499, 'new', 'NULL', quote_literal((bd + 366)::text) || '::date'));
    r := r || jsonb_build_object('N366_new_deal_refused_no_row', CASE WHEN pg_temp.j(s)->>'error' = 'start_date_too_far'
      AND (pg_temp.j(s)->>'latest')::date = bd + 365
      AND NOT EXISTS (SELECT 1 FROM public.org_deals WHERE organization_id = n366) THEN 'PASS' ELSE 'FAIL ' || s END);
    -- no start date still defaults to the business date
    s := pg_temp.call_as(u_sales, format(q10, e1, 'test', 5, 2499, 'new', 'NULL', 'NULL::date'));
    r := r || jsonb_build_object('N0_new_deal_no_date_defaults_today', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND (SELECT start_date FROM public.org_deals WHERE organization_id = e1) = bd THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== changed draft date sweep (e1 is a draft at bd) =====
    s := pg_temp.call_as(u_sales, format(q10, e1, 'test', 5, 2499, 'move', (SELECT version FROM public.org_deals WHERE organization_id = e1), quote_literal((bd + 364)::text) || '::date'));
    r := r || jsonb_build_object('E364_changed_accepted', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND (SELECT start_date FROM public.org_deals WHERE organization_id = e1) = bd + 364 THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sales, format(q10, e1, 'test', 5, 2499, 'move', (SELECT version FROM public.org_deals WHERE organization_id = e1), quote_literal((bd + 365)::text) || '::date'));
    r := r || jsonb_build_object('E365_changed_accepted', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND (SELECT start_date FROM public.org_deals WHERE organization_id = e1) = bd + 365 THEN 'PASS' ELSE 'FAIL ' || s END);
    k := (SELECT version FROM public.org_deals WHERE organization_id = e1);
    s := pg_temp.call_as(u_sales, format(q10, e1, 'test', 5, 2499, 'move', k, quote_literal((bd + 366)::text) || '::date'));
    r := r || jsonb_build_object('E366_changed_refused_row_unchanged', CASE WHEN pg_temp.j(s)->>'error' = 'start_date_too_far'
      AND (pg_temp.j(s)->>'latest')::date = bd + 365
      AND (SELECT start_date FROM public.org_deals WHERE organization_id = e1) = bd + 365
      AND (SELECT version FROM public.org_deals WHERE organization_id = e1) = k THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== unchanged existing date (SR change 1): seeded directly, saved with the same date =====
    s := pg_temp.call_as(u_sales, format(q10, u1, 'test', 5, 2499, 'new', 'NULL', 'NULL::date'));
    FOREACH k IN ARRAY ARRAY[364, 365, 366, 400] LOOP
      UPDATE public.org_deals SET start_date = bd + k WHERE organization_id = u1;  -- time passing / an older rule
      s := pg_temp.call_as(u_sales, format(q10, u1, 'test', 6, 2499, 'seats', (SELECT version FROM public.org_deals WHERE organization_id = u1), quote_literal((bd + k)::text) || '::date'));
      r := r || jsonb_build_object('U' || k || '_unchanged_date_saves', CASE WHEN pg_temp.j(s)->>'success' = 'true'
        AND (SELECT start_date FROM public.org_deals WHERE organization_id = u1) = bd + k THEN 'PASS' ELSE 'FAIL ' || s END);
    END LOOP;
    -- same deal (still at bd+400), saved with no start date
    s := pg_temp.call_as(u_sales, format(q10, u1, 'test', 7, 2499, 'seats', (SELECT version FROM public.org_deals WHERE organization_id = u1), 'NULL::date'));
    r := r || jsonb_build_object('U400_null_date_saves', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND (SELECT start_date FROM public.org_deals WHERE organization_id = u1) = bd + 400 THEN 'PASS' ELSE 'FAIL ' || s END);
    -- moving it from +400 to +401 is a change, so it is checked
    k := (SELECT version FROM public.org_deals WHERE organization_id = u1);
    s := pg_temp.call_as(u_sales, format(q10, u1, 'test', 7, 2499, 'move', k, quote_literal((bd + 401)::text) || '::date'));
    r := r || jsonb_build_object('U401_changed_from_far_refused', CASE WHEN pg_temp.j(s)->>'error' = 'start_date_too_far'
      AND (SELECT start_date FROM public.org_deals WHERE organization_id = u1) = bd + 400 THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== non-draft deal changed to +400: the lock wins =====
    s := pg_temp.call_as(u_sales, format(q10, l1, 'test', 5, 2499, 'new', 'NULL', 'NULL::date'));
    UPDATE public.org_deals SET status = 'active' WHERE organization_id = l1;
    s := pg_temp.call_as(u_sales, format(q10, l1, 'test', 5, 2499, 'move', (SELECT version FROM public.org_deals WHERE organization_id = l1), quote_literal((bd + 400)::text) || '::date'));
    r := r || jsonb_build_object('L400_locked_wins', CASE WHEN pg_temp.j(s)->>'error' = 'start_date_locked' THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== past still refused (order unchanged) =====
    s := pg_temp.call_as(u_sales, format(q10, p1, 'test', 5, 2499, 'new', 'NULL', quote_literal((bd - 1)::text) || '::date'));
    r := r || jsonb_build_object('P_new_past_refused', CASE WHEN pg_temp.j(s)->>'error' = 'start_date_past' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sales, format(q10, p1, 'test', 5, 2499, 'new', 'NULL', 'NULL::date'));
    s := pg_temp.call_as(u_sales, format(q10, p1, 'test', 5, 2499, 'move', (SELECT version FROM public.org_deals WHERE organization_id = p1), quote_literal((bd - 1)::text) || '::date'));
    r := r || jsonb_build_object('P_changed_past_refused', CASE WHEN pg_temp.j(s)->>'error' = 'start_date_past' THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== the cap follows the business date helper, not the server date =====
    -- existing deal saved with the real date first, then the helper is pinned to 2030-01-01
    s := pg_temp.call_as(u_sales, format(q10, t3, 'test', 5, 2499, 'new', 'NULL', 'NULL::date'));
    EXECUTE $h$CREATE OR REPLACE FUNCTION public._billing_business_date(p_at timestamptz DEFAULT now()) RETURNS date
      LANGUAGE sql STABLE SET search_path TO '' AS $x$ SELECT DATE '2030-01-01' $x$$h$;
    s := pg_temp.call_as(u_sales, format(q10, t1, 'test', 5, 2499, 'new', 'NULL', quote_literal('2030-12-31') || '::date'));
    r := r || jsonb_build_object('T_new_cap_uses_business_date', CASE WHEN pg_temp.j(s)->>'success' = 'true' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sales, format(q10, t2, 'test', 5, 2499, 'new', 'NULL', quote_literal('2031-01-02') || '::date'));
    r := r || jsonb_build_object('T_new_cap_refused_at_business_date_plus_366', CASE WHEN pg_temp.j(s)->>'error' = 'start_date_too_far'
      AND (pg_temp.j(s)->>'latest')::date = DATE '2031-01-01' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sales, format(q10, t3, 'test', 5, 2499, 'move', (SELECT version FROM public.org_deals WHERE organization_id = t3), quote_literal('2031-01-01') || '::date'));
    r := r || jsonb_build_object('T_changed_cap_uses_business_date', CASE WHEN pg_temp.j(s)->>'success' = 'true' THEN 'PASS' ELSE 'FAIL ' || s END);
    -- +365 days, not one calendar year: 2027-03-01 + 365 = 2028-02-29
    EXECUTE $h$CREATE OR REPLACE FUNCTION public._billing_business_date(p_at timestamptz DEFAULT now()) RETURNS date
      LANGUAGE sql STABLE SET search_path TO '' AS $x$ SELECT DATE '2027-03-01' $x$$h$;
    s := pg_temp.call_as(u_sales, format(q10, y1, 'test', 5, 2499, 'new', 'NULL', quote_literal('2028-02-29') || '::date'));
    r := r || jsonb_build_object('Y_leap_plus365_accepted', CASE WHEN pg_temp.j(s)->>'success' = 'true' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sales, format(q10, y2, 'test', 5, 2499, 'new', 'NULL', quote_literal('2028-03-01') || '::date'));
    r := r || jsonb_build_object('Y_leap_plus366_refused', CASE WHEN pg_temp.j(s)->>'error' = 'start_date_too_far' THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== catalog: grants unchanged =====
    r := r || jsonb_build_object('G_save_deal_grants', CASE WHEN
      NOT has_function_privilege('anon', 'public._billing_save_deal(uuid,jsonb,uuid,text,integer)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public._billing_save_deal(uuid,jsonb,uuid,text,integer)', 'EXECUTE')
      AND has_function_privilege('service_role', 'public._billing_save_deal(uuid,jsonb,uuid,text,integer)', 'EXECUTE')
      AND (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public._billing_save_deal(uuid,jsonb,uuid,text,integer)'::regprocedure)
      THEN 'PASS' ELSE 'FAIL' END);

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
  RAISE EXCEPTION 'P4033_RESULT %', v_res;
END
$drv$;
