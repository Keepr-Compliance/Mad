-- BACKLOG-4045 staff turning auto-renew back on queues notify_auto_renew_on: DB controls.
-- Venue: keepr-test, ONE call, ONE transaction ending in RAISE, so nothing persists. Run after
-- 20261107140000 is applied, or compose it in front (compose.py --with-migration).
-- Harness copied from supabase/tests/backlog-4019/controls.sql (helpers verbatim): each mode runs
-- in its own subtransaction, applies its mutation by exact-once replace (raises on 0 or 2+ matches;
-- the md5 must change, else MUTATION NOT APPLIED), builds fixtures, runs every check, rolls back.
-- 'base' = no mutation (every check must PASS).
-- G_guard runs the migration's own guard block (compose.py inserts it at the guard placeholder) against the
-- live body: it passes on the 4045 body and RAISES on any other, so every mutation mode reds it by
-- design (that is the guard refusing a drifted body).
-- Output: RAISE 'P4045_RESULT {mode: {mutation, pass, fail, reds}}'.
-- Fixtures: auth users p4045-*@example.test, organizations "P4045 *" (is_test), Stripe ids
-- sub_p4045_* (fictional; nothing calls Stripe).

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

  -- a statement as an authenticated user that returns no value: 'ok:<rows>' or 'ERR <sqlstate>'
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
      RETURN 'ERR ' || SQLSTATE;
    END;
  END $b$$f$;

  -- exec_as, rolled back: 'ok:<rows>' or 'ERR <sqlstate>'
  EXECUTE $f$CREATE FUNCTION pg_temp.try_rows(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE d text;
  BEGIN
    BEGIN
      d := pg_temp.exec_as(u, q);
      RAISE EXCEPTION 'TRY_DONE' USING DETAIL = d;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'TRY_DONE' THEN RETURN 'ERR ' || SQLSTATE; END IF;
      GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL;
      RETURN d;
    END;
  END $b$$f$;

  -- a scalar query as an authenticated user, as text
  EXECUTE $f$CREATE FUNCTION pg_temp.val_as(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE v text;
  BEGIN
    BEGIN
      PERFORM pg_temp.as_user(u);
      EXECUTE 'SET LOCAL ROLE authenticated';
      EXECUTE q INTO v;
      EXECUTE 'RESET ROLE';
      RETURN coalesce(v, 'null');
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 60);
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

  -- the caller helper for u (pure, no role switch)
  EXECUTE $f$CREATE FUNCTION pg_temp.who(u uuid, o uuid) RETURNS text LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM pg_temp.as_user(u);
    RETURN coalesce(public._org_auto_renew_caller(o), 'NULL');
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

  EXECUTE $f$CREATE FUNCTION pg_temp.mut_pol(p_sch text, p_tbl text, p_pol text, p_part text, p_from text, p_to text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE q text; c text; t text; n int; m1 text; m2 text;
  BEGIN
    SELECT qual, with_check INTO q, c FROM pg_policies WHERE schemaname = p_sch AND tablename = p_tbl AND policyname = p_pol;
    t := CASE p_part WHEN 'qual' THEN q ELSE c END;
    n := (length(t) - length(replace(t, p_from, ''))) / length(p_from);
    IF n <> 1 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: % matches in % %', n, p_pol, p_part; END IF;
    m1 := md5(coalesce(q, '')) || '/' || md5(coalesce(c, ''));
    IF p_part = 'qual' THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)', p_pol, p_sch, p_tbl, replace(t, p_from, p_to));
    ELSE
      EXECUTE format('ALTER POLICY %I ON %I.%I WITH CHECK (%s)', p_pol, p_sch, p_tbl, replace(t, p_from, p_to));
    END IF;
    SELECT md5(coalesce(qual, '')) || '/' || md5(coalesce(with_check, '')) INTO m2
      FROM pg_policies WHERE schemaname = p_sch AND tablename = p_tbl AND policyname = p_pol;
    IF m1 = m2 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: md5 unchanged for %', p_pol; END IF;
    RETURN 'MUTATION APPLIED ' || p_pol || '.' || p_part || ' '
           || left(split_part(m1, '/', CASE p_part WHEN 'qual' THEN 1 ELSE 2 END), 8) || '->'
           || left(split_part(m2, '/', CASE p_part WHEN 'qual' THEN 1 ELSE 2 END), 8);
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.pass(ok boolean, info text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL ' || coalesce(left(info, 160), '') END
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.outbox(o uuid, k text) RETURNS int LANGUAGE sql AS $b$
    SELECT count(*)::int FROM public.billing_outbox b WHERE b.organization_id = o AND b.kind = k
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.am_rows(o uuid) RETURNS int LANGUAGE sql AS $b$
    SELECT count(*)::int FROM public.billing_outbox b
     WHERE b.organization_id = o AND b.kind = 'notify_account_manager' AND b.payload ->> 'reason' = 'auto_renew_off'
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.fo(o uuid, k text) RETURNS text LANGUAGE sql AS $b$
    SELECT coalesce((SELECT op.feature_overrides -> k ->> 'enabled' FROM public.organization_plans op WHERE op.organization_id = o), 'absent')
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.ar(o uuid) RETURNS int LANGUAGE sql AS $b$
    SELECT count(*)::int FROM public.billing_outbox b WHERE b.organization_id = o AND b.kind = 'notify_auto_renew_on'
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.ver(o uuid) RETURNS int LANGUAGE sql AS $b$
    SELECT d.version FROM public.org_deals d WHERE d.organization_id = o
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.st(o uuid) RETURNS text LANGUAGE sql AS $b$
    SELECT d.status || '/' || coalesce(d.status_before_suspension, '-') FROM public.org_deals d WHERE d.organization_id = o
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE
    sw text := 'public._billing_set_auto_renew(uuid,boolean,text,uuid,text,integer)';
    gate text := $q$  IF p_on AND p_caller = 'staff' AND v_new_status = 'active' THEN$q$;
  BEGIN
    CASE m
    WHEN 'base' THEN RETURN 'none';
    -- C1: the enqueue is missing (also what a TS-action build looks like from SQL)
    WHEN 'c1_no_enqueue' THEN RETURN pg_temp.mut_fn(sw, gate, $q$  IF false THEN$q$);
    -- C2: the plausible wrong build that queues for any staff change
    WHEN 'c2_staff_any' THEN RETURN pg_temp.mut_fn(sw, gate, $q$  IF p_caller = 'staff' THEN$q$);
    -- C3: queued for any caller
    WHEN 'c3_any_caller' THEN RETURN pg_temp.mut_fn(sw, gate, $q$  IF p_on AND v_new_status = 'active' THEN$q$);
    -- C4: a self-contained enqueue before the no-op return (fires on a no-op)
    WHEN 'c4_before_early_return' THEN RETURN pg_temp.mut_fn(sw,
      $q$    IF v_eff = 'active' THEN
      RETURN jsonb_build_object('success', true, 'changed', false, 'version', v_deal.version, 'ends_on', NULL);$q$,
      $q$    IF p_on AND p_caller = 'staff' THEN
      INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
      VALUES (v_deal.stripe_mode, 'notify_auto_renew_on', p_org,
              'notify_auto_renew_on:' || v_deal.stripe_mode || ':' || p_org::text || ':v' || (v_deal.version + 1)::text,
              jsonb_build_object('organization_id', p_org, 'version', v_deal.version + 1))
      ON CONFLICT (dedupe_key) DO NOTHING;
    END IF;
    IF v_eff = 'active' THEN
      RETURN jsonb_build_object('success', true, 'changed', false, 'version', v_deal.version, 'ends_on', NULL);$q$);
    -- C5: no new-status test (a suspended deal turned back on queues)
    WHEN 'c5_no_status_test' THEN RETURN pg_temp.mut_fn(sw, gate, $q$  IF p_on AND p_caller = 'staff' THEN$q$);
    -- C6: no ON CONFLICT on the new insert
    WHEN 'c6_no_on_conflict' THEN RETURN pg_temp.mut_fn(sw, $q$'version', v_version))
    ON CONFLICT (dedupe_key) DO NOTHING;$q$, $q$'version', v_version));$q$);
    ELSE RAISE EXCEPTION 'unknown mode %', m;
    END CASE;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    o1 uuid := gen_random_uuid();  -- staff toggles
    o2 uuid := gen_random_uuid();  -- brokerage toggles (Admin, billing contact)
    o3 uuid := gen_random_uuid();  -- suspended while canceling
    u_sales uuid := gen_random_uuid(); u_adm uuid := gen_random_uuid(); u_bc uuid := gen_random_uuid();
    m_bc uuid; v_team uuid;
    g text; v jsonb; v2 jsonb; n int;
    q_sw text := 'SELECT public.set_org_auto_renew(%L::uuid, %s, %L, %s)';
    v_end timestamptz := date_trunc('second', now() + interval '20 days');
  BEGIN
    SELECT id INTO v_team FROM public.plans WHERE name = 'Team';
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT x, 'p4045-' || left(x::text, 8) || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM unnest(ARRAY[u_sales, u_adm, u_bc]) x;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    SELECT x, (SELECT a.email FROM auth.users a WHERE a.id = x), 'email', x::text, 'P4045 ' || left(x::text, 4)
      FROM unnest(ARRAY[u_sales, u_adm, u_bc]) x
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.internal_roles (user_id, role_id)
    SELECT u_sales, ar.id FROM public.admin_roles ar WHERE ar.slug = 'sales';
    INSERT INTO public.organizations (id, name, slug, max_seats, is_test)
    SELECT x, 'P4045 ' || left(x::text, 8), 'p4045-' || left(x::text, 8), 20, true FROM unnest(ARRAY[o1, o2, o3]) x;
    INSERT INTO public.organization_plans (organization_id, plan_id) SELECT x, v_team FROM unnest(ARRAY[o1, o2, o3]) x;
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, created_at)
      VALUES (o2, u_adm, 'admin', 'active', now(), now());
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, created_at)
      VALUES (o2, u_bc, 'agent', 'active', now(), now()) RETURNING id INTO m_bc;
    INSERT INTO public.org_contacts (organization_id, role, member_id) VALUES (o2, 'billing', m_bc);
    INSERT INTO public.org_deals (organization_id, stripe_mode, plan_id, seats, start_date, status, version)
    SELECT x, 'test', v_team, 5, current_date, 'active', 1 FROM unnest(ARRAY[o1, o2, o3]) x;
    INSERT INTO public.org_billing_stripe (organization_id, stripe_mode, stripe_customer_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end)
    SELECT x, 'test', 'cus_p4045_' || left(x::text, 8), 'sub_p4045_' || left(x::text, 8), 'active', v_end, false FROM unnest(ARRAY[o1, o2, o3]) x;
    PERFORM public._billing_apply_org_entitlement(x) FROM unnest(ARRAY[o1, o2, o3]) x;

    -- ===== G: the migration's guard accepts the live body =====
    BEGIN
      EXECUTE __GUARD__;
      g := 'pass';
    EXCEPTION WHEN OTHERS THEN g := 'raised: ' || left(SQLERRM, 120);
    END;
    r := r || jsonb_build_object('G_guard', pg_temp.pass(g = 'pass', g));

    -- ===== C4: staff on while already active -> no-op, no row =====
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o1, 'true', 'p4045 on while active', 1)));
    r := r || jsonb_build_object('C4_noop_no_row', pg_temp.pass(
      v ->> 'success' = 'true' AND v ->> 'changed' = 'false' AND pg_temp.ver(o1) = 1 AND pg_temp.ar(o1) = 0,
      v::text || ' ver=' || pg_temp.ver(o1) || ' rows=' || pg_temp.ar(o1)));

    -- ===== C2: staff off -> canceling, no row =====
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o1, 'false', 'p4045 staff off', 1)));
    r := r || jsonb_build_object('C2_staff_off_no_row', pg_temp.pass(
      v ->> 'success' = 'true' AND pg_temp.st(o1) = 'canceling/-' AND pg_temp.ver(o1) = 2 AND pg_temp.ar(o1) = 0,
      v::text || ' st=' || pg_temp.st(o1) || ' rows=' || pg_temp.ar(o1)));

    -- ===== C1: staff on -> active v3, exactly one row with the v3 key and payload =====
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o1, 'true', 'p4045 staff on', 2)));
    r := r || jsonb_build_object('C1_staff_on_one_row', pg_temp.pass(
      v ->> 'success' = 'true' AND v ->> 'changed' = 'true' AND pg_temp.st(o1) = 'active/-' AND pg_temp.ver(o1) = 3
      AND pg_temp.ar(o1) = 1
      AND EXISTS (SELECT 1 FROM public.billing_outbox b WHERE b.organization_id = o1 AND b.kind = 'notify_auto_renew_on'
                   AND b.stripe_mode = 'test'
                   AND b.dedupe_key = 'notify_auto_renew_on:test:' || o1::text || ':v3'
                   AND b.payload = jsonb_build_object('organization_id', o1, 'version', 3)),
      v::text || ' rows=' || pg_temp.ar(o1) || ' row=' || coalesce((SELECT b.dedupe_key || ' ' || b.payload::text FROM public.billing_outbox b
        WHERE b.organization_id = o1 AND b.kind = 'notify_auto_renew_on' LIMIT 1), 'none')));
    -- the staff user is the recorded actor (unchanged 4019 behaviour, re-asserted)
    r := r || jsonb_build_object('A_actor_recorded', pg_temp.pass(
      EXISTS (SELECT 1 FROM public.billing_change_log l WHERE l.organization_id = o1 AND l.action = 'auto_renew_on'
               AND l.actor_id = u_sales AND (l.detail ->> 'version')::int = 3)
      AND EXISTS (SELECT 1 FROM public.admin_audit_logs a WHERE a.actor_id = u_sales AND a.action = 'billing.auto_renew_on'
               AND a.target_id = o1::text), 'log'));

    -- ===== C6: the key the function will write already exists -> no error, still one row =====
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o1, 'false', 'p4045 staff off 2', 3)));
    INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
    VALUES ('test', 'notify_auto_renew_on', o1, 'notify_auto_renew_on:test:' || o1::text || ':v5', '{"p4045":"pre-existing"}');
    v2 := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o1, 'true', 'p4045 staff on 2', 4)));
    r := r || jsonb_build_object('C6_dedupe_on_conflict', pg_temp.pass(
      v2 ->> 'success' = 'true' AND pg_temp.ver(o1) = 5
      AND (SELECT count(*) FROM public.billing_outbox b WHERE b.dedupe_key = 'notify_auto_renew_on:test:' || o1::text || ':v5') = 1,
      'off=' || v::text || ' on=' || pg_temp.call_as(u_sales, format(q_sw, o1, 'true', 'p4045 staff on 2', 4)) || ' ver=' || pg_temp.ver(o1)));

    -- ===== C3: Admin on and billing contact on -> no row =====
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o2, 'false', 'p4045 staff off', 1)));
    v := pg_temp.j(pg_temp.call_as(u_adm, format(q_sw, o2, 'true', NULL, 2)));
    n := pg_temp.ar(o2);
    v2 := pg_temp.j(pg_temp.call_as(u_adm, format(q_sw, o2, 'false', NULL, 3)));
    v2 := pg_temp.j(pg_temp.call_as(u_bc, format(q_sw, o2, 'true', NULL, 4)));
    r := r || jsonb_build_object('C3_brokerage_on_no_row', pg_temp.pass(
      v ->> 'changed' = 'true' AND v2 ->> 'changed' = 'true' AND pg_temp.st(o2) = 'active/-' AND pg_temp.ver(o2) = 5
      AND n = 0 AND pg_temp.ar(o2) = 0,
      'adm=' || v::text || ' bc=' || v2::text || ' rows ' || n || '/' || pg_temp.ar(o2)));

    -- ===== C5: suspended while canceling, staff on -> suspended/active, no row =====
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o3, 'false', 'p4045 staff off', 1)));
    PERFORM public._billing_suspend_org(o3, 'other', 'p4045', u_sales);
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o3, 'true', 'p4045 staff on while suspended', pg_temp.ver(o3))));
    r := r || jsonb_build_object('C5_suspended_no_row', pg_temp.pass(
      v ->> 'success' = 'true' AND v ->> 'changed' = 'true' AND pg_temp.st(o3) = 'suspended/active' AND pg_temp.ar(o3) = 0,
      v::text || ' st=' || pg_temp.st(o3) || ' rows=' || pg_temp.ar(o3)));

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
  RAISE EXCEPTION 'P4045_RESULT %', v_res;
END
$drv$;
