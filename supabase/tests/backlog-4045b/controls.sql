-- BACKLOG-4045b (20261107160000) "Email the billing contact" choice: DB controls. Superset of
-- supabase/tests/backlog-4045/controls.sql (C1-C6 carried over with contact-email fixtures and the
-- gate anchors moved to the v_notify line) plus N1-N9. Venue: keepr-test, ONE call, ONE transaction
-- ending in RAISE, so nothing persists. Run after 20261107160000 is applied, or compose it in front
-- (compose.py --with-migration). Harness helpers verbatim from backlog-4045 (from backlog-4019):
-- exact-once replace, md5 must change, else MUTATION NOT APPLIED. 'base' = no mutation.
-- G_guard runs this migration's own guard text against the live functions: passes on the 4045b
-- bodies, and every mutation of a guarded function reds it by design.
-- Fixtures: o1 (staff toggles), o2 (Admin / billing contact toggles), o3 (suspended) all have a
-- billing contact email; o4 is the only deal without one (N3).
-- Output: RAISE 'P4045B_RESULT {mode: {mutation, pass, fail, reds}}'.

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

  -- detail.notified of the auto_renew_on row at version v: 'true' | 'false' | 'absent' | 'norow'
  EXECUTE $f$CREATE FUNCTION pg_temp.nt(o uuid, v int) RETURNS text LANGUAGE sql AS $b$
    SELECT coalesce((SELECT CASE WHEN l.detail ? 'notified' THEN l.detail ->> 'notified' ELSE 'absent' END
                       FROM public.billing_change_log l
                      WHERE l.organization_id = o AND l.action = 'auto_renew_on' AND (l.detail ->> 'version')::int = v), 'norow')
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.cl(o uuid) RETURNS int LANGUAGE sql AS $b$
    SELECT count(*)::int FROM public.billing_change_log l WHERE l.organization_id = o AND l.action IN ('auto_renew_on', 'auto_renew_off')
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE
    sw text := 'public._billing_set_auto_renew(uuid,boolean,text,uuid,text,integer,boolean)';
    pub text := 'public.set_org_auto_renew(uuid,boolean,text,integer,boolean)';
    rd text := 'public.admin_get_org_activity(uuid,integer)';
    gate text := $q$  v_notify := p_on AND p_caller = 'staff' AND v_new_status = 'active' AND p_notify AND nullif(btrim(coalesce(v_deal.billing_contact_email, '')), '') IS NOT NULL;$q$;
  BEGIN
    CASE m
    WHEN 'base' THEN RETURN 'none';
    WHEN 'c1_no_enqueue' THEN RETURN pg_temp.mut_fn(sw, $q$  IF v_notify THEN$q$, $q$  IF false THEN$q$);
    WHEN 'c2_staff_any' THEN RETURN pg_temp.mut_fn(sw, gate, $q$  v_notify := p_caller = 'staff' AND p_notify AND nullif(btrim(coalesce(v_deal.billing_contact_email, '')), '') IS NOT NULL;$q$);
    WHEN 'c3_any_caller' THEN RETURN pg_temp.mut_fn(sw, gate, replace(gate, $q$p_caller = 'staff' AND $q$, ''));
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
    WHEN 'c5_no_status_test' THEN RETURN pg_temp.mut_fn(sw, gate, replace(gate, $q$ AND v_new_status = 'active'$q$, ''));
    WHEN 'c6_no_on_conflict' THEN RETURN pg_temp.mut_fn(sw, $q$'version', v_version))
    ON CONFLICT (dedupe_key) DO NOTHING;$q$, $q$'version', v_version));$q$);
    WHEN 'n1_default_false' THEN RETURN pg_temp.mut_fn(pub, $q$p_notify boolean DEFAULT true$q$, $q$p_notify boolean DEFAULT false$q$);
    WHEN 'n1b_overload' THEN
      EXECUTE $o$CREATE FUNCTION public.set_org_auto_renew(p_org uuid, p_on boolean, p_note text, p_expected_version integer)
        RETURNS jsonb LANGUAGE sql AS 'SELECT public.set_org_auto_renew(p_org, p_on, p_note, p_expected_version, true)'$o$;
      IF to_regprocedure('public.set_org_auto_renew(uuid,boolean,text,integer)') IS NULL THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: overload'; END IF;
      RETURN 'MUTATION APPLIED 4-arg set_org_auto_renew overload created';
    WHEN 'n2_no_p_notify' THEN RETURN pg_temp.mut_fn(sw, gate, replace(gate, $q$ AND p_notify AND nullif$q$, $q$ AND nullif$q$));
    WHEN 'n3_no_contact' THEN RETURN pg_temp.mut_fn(sw, gate, replace(gate, $q$ AND nullif(btrim(coalesce(v_deal.billing_contact_email, '')), '') IS NOT NULL$q$, ''));
    WHEN 'n4_key_every_caller' THEN RETURN pg_temp.mut_fn(sw,
      $q$          || CASE WHEN p_on AND p_caller = 'staff' THEN jsonb_build_object('notified', v_notify) ELSE '{}'::jsonb END);$q$,
      $q$          || jsonb_build_object('notified', coalesce(v_notify, false)));$q$);
    WHEN 'n6_reader_no_key' THEN RETURN pg_temp.mut_fn(rd, $q$'plan', 'notified')))$q$, $q$'plan')))$q$);
    WHEN 'n7_audit_no_key' THEN RETURN pg_temp.mut_fn(pub, $q$
            || CASE WHEN v_res ? 'notified' THEN jsonb_build_object('notified', v_res -> 'notified') ELSE '{}'::jsonb END);$q$, $q$);$q$);
    WHEN 'n8_grant_internal' THEN
      EXECUTE 'GRANT EXECUTE ON FUNCTION public._billing_set_auto_renew(uuid,boolean,text,uuid,text,integer,boolean) TO authenticated';
      IF NOT has_function_privilege('authenticated', 'public._billing_set_auto_renew(uuid,boolean,text,uuid,text,integer,boolean)', 'EXECUTE') THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF;
      RETURN 'MUTATION APPLIED GRANT EXECUTE _billing_set_auto_renew(7) TO authenticated';
    WHEN 'n9_no_null_check' THEN RETURN pg_temp.mut_fn(sw, $q$  IF p_notify IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_request');
  END IF;
$q$, '');
    ELSE RAISE EXCEPTION 'unknown mode %', m;
    END CASE;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    o1 uuid := gen_random_uuid();  -- staff toggles (contact)
    o2 uuid := gen_random_uuid();  -- Admin / billing contact toggles (contact)
    o3 uuid := gen_random_uuid();  -- suspended while canceling (contact)
    o4 uuid := gen_random_uuid();  -- no billing contact email (N3)
    u_sales uuid := gen_random_uuid(); u_adm uuid := gen_random_uuid(); u_bc uuid := gen_random_uuid();
    m_bc uuid; v_team uuid;
    g text; s text; v jsonb; v2 jsonb; n int; n2 int; c int;
    q_sw text := 'SELECT public.set_org_auto_renew(%L::uuid, %s, %L, %s)';
    q_sw5 text := 'SELECT public.set_org_auto_renew(%L::uuid, %s, %L, %s, %s)';
    q_named text := 'SELECT public.set_org_auto_renew(p_org => %L::uuid, p_on => %s, p_note => %L, p_expected_version => %s)';
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
    SELECT x, 'P4045 ' || left(x::text, 8), 'p4045-' || left(x::text, 8), 20, true FROM unnest(ARRAY[o1, o2, o3, o4]) x;
    INSERT INTO public.organization_plans (organization_id, plan_id) SELECT x, v_team FROM unnest(ARRAY[o1, o2, o3, o4]) x;
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, created_at)
      VALUES (o2, u_adm, 'admin', 'active', now(), now());
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, created_at)
      VALUES (o2, u_bc, 'agent', 'active', now(), now()) RETURNING id INTO m_bc;
    INSERT INTO public.org_contacts (organization_id, role, member_id) VALUES (o2, 'billing', m_bc);
    INSERT INTO public.org_deals (organization_id, stripe_mode, plan_id, seats, start_date, status, version, billing_contact_email)
    SELECT x, 'test', v_team, 5, current_date, 'active', 1, 'p4045-billing-' || left(x::text, 8) || '@example.test' FROM unnest(ARRAY[o1, o2, o3]) x;
    INSERT INTO public.org_deals (organization_id, stripe_mode, plan_id, seats, start_date, status, version, billing_contact_email)
      VALUES (o4, 'test', v_team, 5, current_date, 'active', 1, NULL);
    INSERT INTO public.org_billing_stripe (organization_id, stripe_mode, stripe_customer_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end)
    SELECT x, 'test', 'cus_p4045_' || left(x::text, 8), 'sub_p4045_' || left(x::text, 8), 'active', v_end, false FROM unnest(ARRAY[o1, o2, o3, o4]) x;
    PERFORM public._billing_apply_org_entitlement(x) FROM unnest(ARRAY[o1, o2, o3, o4]) x;

    BEGIN
      EXECUTE __GUARD__;
      g := 'pass';
    EXCEPTION WHEN OTHERS THEN g := 'raised: ' || left(SQLERRM, 120);
    END;
    r := r || jsonb_build_object('G_guard', pg_temp.pass(g = 'pass', g));

    -- N8 grants and single signatures
    r := r || jsonb_build_object('N8_grants_one_signature', pg_temp.pass(
      (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'set_org_auto_renew') = 1
      AND (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_billing_set_auto_renew') = 1
      AND to_regprocedure('public.set_org_auto_renew(uuid,boolean,text,integer,boolean)') IS NOT NULL
      AND to_regprocedure('public._billing_set_auto_renew(uuid,boolean,text,uuid,text,integer,boolean)') IS NOT NULL
      AND NOT has_function_privilege('anon', 'public.set_org_auto_renew(uuid,boolean,text,integer,boolean)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.set_org_auto_renew(uuid,boolean,text,integer,boolean)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public._billing_set_auto_renew(uuid,boolean,text,uuid,text,integer,boolean)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public._billing_set_auto_renew(uuid,boolean,text,uuid,text,integer,boolean)', 'EXECUTE'), 'grants'));

    -- C4 staff on while already active -> no-op, no row
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o1, 'true', 'p4045 on while active', 1)));
    r := r || jsonb_build_object('C4_noop_no_row', pg_temp.pass(
      v ->> 'success' = 'true' AND v ->> 'changed' = 'false' AND pg_temp.ver(o1) = 1 AND pg_temp.ar(o1) = 0,
      v::text || ' rows=' || pg_temp.ar(o1)));
    -- C2 staff off -> no row
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o1, 'false', 'p4045 staff off', 1)));
    r := r || jsonb_build_object('C2_staff_off_no_row', pg_temp.pass(
      v ->> 'success' = 'true' AND pg_temp.st(o1) = 'canceling/-' AND pg_temp.ver(o1) = 2 AND pg_temp.ar(o1) = 0,
      v::text || ' rows=' || pg_temp.ar(o1)));
    -- C1 / N1 staff on via the old 4-arg positional call -> one row, notified true
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o1, 'true', 'p4045 staff on', 2)));
    r := r || jsonb_build_object('C1_staff_on_one_row', pg_temp.pass(
      v ->> 'success' = 'true' AND pg_temp.st(o1) = 'active/-' AND pg_temp.ver(o1) = 3 AND pg_temp.ar(o1) = 1
      AND EXISTS (SELECT 1 FROM public.billing_outbox b WHERE b.organization_id = o1 AND b.kind = 'notify_auto_renew_on'
                   AND b.dedupe_key = 'notify_auto_renew_on:test:' || o1::text || ':v3'
                   AND b.payload = jsonb_build_object('organization_id', o1, 'version', 3)),
      v::text || ' rows=' || pg_temp.ar(o1)));
    r := r || jsonb_build_object('N1_default_notifies', pg_temp.pass(
      pg_temp.nt(o1, 3) = 'true' AND v ->> 'notified' = 'true', 'nt=' || pg_temp.nt(o1, 3) || ' res=' || v::text));
    r := r || jsonb_build_object('N7_audit_notified', pg_temp.pass(
      EXISTS (SELECT 1 FROM public.admin_audit_logs a WHERE a.actor_id = u_sales AND a.action = 'billing.auto_renew_on'
               AND a.target_id = o1::text AND a.metadata ->> 'notified' = 'true' AND (a.metadata ->> 'version')::int = 3),
      coalesce((SELECT a.metadata::text FROM public.admin_audit_logs a WHERE a.actor_id = u_sales AND a.action = 'billing.auto_renew_on' AND a.target_id = o1::text LIMIT 1), 'none')));
    r := r || jsonb_build_object('A_actor_recorded', pg_temp.pass(
      EXISTS (SELECT 1 FROM public.billing_change_log l WHERE l.organization_id = o1 AND l.action = 'auto_renew_on'
               AND l.actor_id = u_sales AND (l.detail ->> 'version')::int = 3), 'log'));
    -- N6 the Activity reader returns notified (sales has organizations.view + billing.view)
    s := pg_temp.call_as(u_sales, format('SELECT public.admin_get_org_activity(%L::uuid, 100)', o1));
    r := r || jsonb_build_object('N6_reader_notified', pg_temp.pass(
      EXISTS (SELECT 1 FROM jsonb_array_elements(pg_temp.j(s)) e WHERE e ->> 'action' = 'auto_renew_on' AND e -> 'detail' ->> 'notified' = 'true'),
      left(s, 160)));

    -- C6 the key the function will write already exists -> no error, still one row
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o1, 'false', 'p4045 staff off 2', 3)));
    INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
    VALUES ('test', 'notify_auto_renew_on', o1, 'notify_auto_renew_on:test:' || o1::text || ':v5', '{"p4045":"pre-existing"}');
    v2 := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o1, 'true', 'p4045 staff on 2', 4)));
    r := r || jsonb_build_object('C6_dedupe_on_conflict', pg_temp.pass(
      v2 ->> 'success' = 'true' AND pg_temp.ver(o1) = 5
      AND (SELECT count(*) FROM public.billing_outbox b WHERE b.dedupe_key = 'notify_auto_renew_on:test:' || o1::text || ':v5') = 1,
      'on=' || v2::text || ' ver=' || pg_temp.ver(o1)));

    -- N1b named args only (the broker-portal / PostgREST shape) resolve to the one function
    s := pg_temp.call_as(u_sales, format(q_named, o1, 'false', 'p4045 named off', 5));
    r := r || jsonb_build_object('N1b_named_args_resolve', pg_temp.pass(
      pg_temp.j(s) ->> 'success' = 'true' AND pg_temp.ver(o1) = 6, s));
    -- N2 staff on with p_notify false -> no new row, notified false
    n := pg_temp.ar(o1);
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw5, o1, 'true', 'p4045 on no email', 6, 'false')));
    r := r || jsonb_build_object('N2_unticked_no_row', pg_temp.pass(
      v ->> 'success' = 'true' AND pg_temp.st(o1) = 'active/-' AND pg_temp.ver(o1) = 7 AND pg_temp.ar(o1) = n
      AND pg_temp.nt(o1, 7) = 'false' AND v ->> 'notified' = 'false',
      v::text || ' rows ' || n || '->' || pg_temp.ar(o1) || ' nt=' || pg_temp.nt(o1, 7)));
    -- N9 p_notify NULL -> invalid_request, nothing written
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o1, 'false', 'p4045 off before null', 7)));
    n := pg_temp.ar(o1); c := pg_temp.cl(o1);
    s := pg_temp.call_as(u_sales, format(q_sw5, o1, 'true', 'p4045 null notify', 8, 'NULL'));
    r := r || jsonb_build_object('N9_null_notify_refused', pg_temp.pass(
      pg_temp.j(s) ->> 'error' = 'invalid_request' AND pg_temp.ver(o1) = 8 AND pg_temp.st(o1) = 'canceling/-'
      AND pg_temp.ar(o1) = n AND pg_temp.cl(o1) = c,
      s || ' ver=' || pg_temp.ver(o1) || ' cl ' || c || '->' || pg_temp.cl(o1)));

    -- N3 no billing contact email -> no row, notified false
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o4, 'false', 'p4045 off', 1)));
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o4, 'true', 'p4045 on no contact', 2)));
    r := r || jsonb_build_object('N3_no_contact_no_row', pg_temp.pass(
      v ->> 'success' = 'true' AND pg_temp.ver(o4) = 3 AND pg_temp.ar(o4) = 0 AND pg_temp.nt(o4, 3) = 'false',
      v::text || ' rows=' || pg_temp.ar(o4) || ' nt=' || pg_temp.nt(o4, 3)));

    -- C3 / N4 Admin on and billing contact on -> no row, no notified key
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o2, 'false', 'p4045 staff off', 1)));
    v := pg_temp.j(pg_temp.call_as(u_adm, format(q_sw, o2, 'true', NULL, 2)));
    n := pg_temp.ar(o2);
    v2 := pg_temp.j(pg_temp.call_as(u_adm, format(q_sw, o2, 'false', NULL, 3)));
    v2 := pg_temp.j(pg_temp.call_as(u_bc, format(q_sw, o2, 'true', NULL, 4)));
    r := r || jsonb_build_object('C3_brokerage_on_no_row', pg_temp.pass(
      v ->> 'changed' = 'true' AND v2 ->> 'changed' = 'true' AND pg_temp.st(o2) = 'active/-' AND pg_temp.ver(o2) = 5
      AND n = 0 AND pg_temp.ar(o2) = 0,
      'adm=' || v::text || ' bc=' || v2::text || ' rows ' || n || '/' || pg_temp.ar(o2)));
    r := r || jsonb_build_object('N4_no_key_for_brokerage', pg_temp.pass(
      pg_temp.nt(o2, 3) = 'absent' AND pg_temp.nt(o2, 5) = 'absent', 'v3=' || pg_temp.nt(o2, 3) || ' v5=' || pg_temp.nt(o2, 5)));

    -- C5 / N5 suspended while canceling, staff on -> no row, notified false
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o3, 'false', 'p4045 staff off', 1)));
    PERFORM public._billing_suspend_org(o3, 'other', 'p4045', u_sales);
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o3, 'true', 'p4045 staff on while suspended', pg_temp.ver(o3))));
    r := r || jsonb_build_object('C5_suspended_no_row', pg_temp.pass(
      v ->> 'success' = 'true' AND v ->> 'changed' = 'true' AND pg_temp.st(o3) = 'suspended/active' AND pg_temp.ar(o3) = 0,
      v::text || ' st=' || pg_temp.st(o3) || ' rows=' || pg_temp.ar(o3)));
    r := r || jsonb_build_object('N5_suspended_notified_false', pg_temp.pass(
      pg_temp.nt(o3, pg_temp.ver(o3)) = 'false', 'nt=' || pg_temp.nt(o3, pg_temp.ver(o3))));

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
  RAISE EXCEPTION 'P4045B_RESULT %', v_res;
END
$drv$;
