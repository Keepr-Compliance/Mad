-- BACKLOG-4200 (20261108170000) + BACKLOG-4209 (20261108180000): DB controls. Venue: keepr-test,
-- ONE call, ONE transaction ending in RAISE, so nothing persists. Run after both migrations are
-- applied, or compose them in front (compose.py --with-migration). Harness helpers verbatim from
-- backlog-4045b (from backlog-4019): exact-once replace, md5 must change, else MUTATION NOT APPLIED.
-- 'base' = no mutation. Carries the BACKLOG-4045/4045b controls C1-C6 and N1-N9 against the new
-- _billing_set_auto_renew body (the n4 anchor moves to the new change-log wrapper).
-- G_guard_4200 / G_guard_4209 run each migration's own guard text against the live functions.
-- Fixtures: every deal has a billing contact email except o4 (N3, F7), o10 (R4) and o11 (A5); every
-- org has an active Stripe subscription mirror with a future current_period_end.
-- Output: RAISE 'P4200_4209_RESULT {mode: {mutation, pass, fail, reds}}'.

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

  -- BACKLOG-4200 / 4209 helpers
  EXECUTE $f$CREATE FUNCTION pg_temp.offr(o uuid) RETURNS int LANGUAGE sql AS $b$
    SELECT count(*)::int FROM public.billing_outbox b WHERE b.organization_id = o AND b.kind = 'notify_auto_renew_off'
  $b$$f$;
  -- detail.notified of the auto_renew_off row at version v
  EXECUTE $f$CREATE FUNCTION pg_temp.ntoff(o uuid, v int) RETURNS text LANGUAGE sql AS $b$
    SELECT coalesce((SELECT CASE WHEN l.detail ? 'notified' THEN l.detail ->> 'notified' ELSE 'absent' END
                       FROM public.billing_change_log l
                      WHERE l.organization_id = o AND l.action = 'auto_renew_off' AND (l.detail ->> 'version')::int = v), 'norow')
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.rr(o uuid) RETURNS int LANGUAGE sql AS $b$
    SELECT count(*)::int FROM public.billing_outbox b WHERE b.organization_id = o AND b.kind = 'notify_org_reinstated'
  $b$$f$;
  -- the detail of the only (or newest) 'reinstated' row; '{}' when none
  EXECUTE $f$CREATE FUNCTION pg_temp.rdet(o uuid) RETURNS jsonb LANGUAGE sql AS $b$
    SELECT coalesce((SELECT l.detail FROM public.billing_change_log l WHERE l.organization_id = o AND l.action = 'reinstated'
                      ORDER BY l.created_at DESC LIMIT 1), '{}'::jsonb)
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.rcl(o uuid) RETURNS int LANGUAGE sql AS $b$
    SELECT count(*)::int FROM public.billing_change_log l WHERE l.organization_id = o AND l.action = 'reinstated'
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.ep(o uuid) RETURNS bigint LANGUAGE sql AS $b$
    SELECT floor(extract(epoch FROM d.suspended_at))::bigint FROM public.org_deals d WHERE d.organization_id = o
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE
    sw text := 'public._billing_set_auto_renew(uuid,boolean,text,uuid,text,integer,boolean)';
    pub text := 'public.set_org_auto_renew(uuid,boolean,text,integer,boolean)';
    rd text := 'public.admin_get_org_activity(uuid,integer)';
    ri text := 'public._billing_reinstate_org(uuid,text,uuid,boolean)';
    ad text := 'public.admin_reinstate_org(uuid,text,boolean)';
    au text := 'public._billing_auto_reinstate(uuid,text)';
    gate text := $q$  v_notify := p_on AND p_caller = 'staff' AND v_new_status = 'active' AND p_notify AND nullif(btrim(coalesce(v_deal.billing_contact_email, '')), '') IS NOT NULL;$q$;
    goff text := $q$  v_notify_off := NOT p_on AND p_caller = 'staff' AND v_new_status = 'canceling' AND p_notify AND nullif(btrim(coalesce(v_deal.billing_contact_email, '')), '') IS NOT NULL;$q$;
    wlog text := $q$          || CASE WHEN p_caller = 'staff' THEN jsonb_build_object('notified', CASE WHEN p_on THEN v_notify ELSE v_notify_off END) ELSE '{}'::jsonb END);$q$;
    wres text := $q$         || CASE WHEN p_caller = 'staff' THEN jsonb_build_object('notified', CASE WHEN p_on THEN v_notify ELSE v_notify_off END) ELSE '{}'::jsonb END;$q$;
    grein text := $q$  v_notify := p_notify AND nullif(btrim(coalesce(v_deal.billing_contact_email, '')), '') IS NOT NULL AND v_deal.suspended_at IS NOT NULL;$q$;
  BEGIN
    CASE m
    WHEN 'base' THEN RETURN 'none';
    -- BACKLOG-4200
    WHEN 'f1_no_enqueue' THEN RETURN pg_temp.mut_fn(sw, $q$  IF v_notify_off THEN$q$, $q$  IF false THEN$q$);
    WHEN 'f2_staff_any' THEN RETURN pg_temp.mut_fn(sw, goff, $q$  v_notify_off := p_caller = 'staff' AND p_notify AND nullif(btrim(coalesce(v_deal.billing_contact_email, '')), '') IS NOT NULL;$q$);
    WHEN 'f3_any_caller' THEN RETURN pg_temp.mut_fn(sw, goff, replace(goff, $q$p_caller = 'staff' AND $q$, ''));
    WHEN 'f4_before_early_return' THEN RETURN pg_temp.mut_fn(sw,
      $q$    IF v_eff = 'canceling' THEN
      RETURN jsonb_build_object('success', true, 'changed', false, 'version', v_deal.version, 'ends_on', v_ends);$q$,
      $q$    IF NOT p_on AND p_caller = 'staff' THEN
      INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
      VALUES (v_deal.stripe_mode, 'notify_auto_renew_off', p_org,
              'notify_auto_renew_off:' || v_deal.stripe_mode || ':' || p_org::text || ':v' || (v_deal.version + 1)::text,
              jsonb_build_object('organization_id', p_org, 'version', v_deal.version + 1))
      ON CONFLICT (dedupe_key) DO NOTHING;
    END IF;
    IF v_eff = 'canceling' THEN
      RETURN jsonb_build_object('success', true, 'changed', false, 'version', v_deal.version, 'ends_on', v_ends);$q$);
    WHEN 'f5_no_status_test' THEN RETURN pg_temp.mut_fn(sw, goff, replace(goff, $q$ AND v_new_status = 'canceling'$q$, ''));
    WHEN 'f6_no_p_notify' THEN RETURN pg_temp.mut_fn(sw, goff, replace(goff, $q$ AND p_notify AND nullif$q$, $q$ AND nullif$q$));
    WHEN 'f7_no_contact' THEN RETURN pg_temp.mut_fn(sw, goff, replace(goff, $q$ AND nullif(btrim(coalesce(v_deal.billing_contact_email, '')), '') IS NOT NULL$q$, ''));
    WHEN 'f8_no_on_conflict' THEN RETURN pg_temp.mut_fn(sw, $q$'version', v_version, 'organization_id', p_org))
    ON CONFLICT (dedupe_key) DO NOTHING;$q$, $q$'version', v_version, 'organization_id', p_org));$q$);
    WHEN 'f9_log_wrapper_on_only' THEN RETURN pg_temp.mut_fn(sw, wlog, replace(wlog, $q$CASE WHEN p_caller = 'staff' THEN$q$, $q$CASE WHEN p_on AND p_caller = 'staff' THEN$q$));
    WHEN 'f10_result_wrapper_on_only' THEN RETURN pg_temp.mut_fn(sw, wres, replace(wres, $q$CASE WHEN p_caller = 'staff' THEN$q$, $q$CASE WHEN p_on AND p_caller = 'staff' THEN$q$));
    -- BACKLOG-4045 / 4045b, ported against the new body
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
    WHEN 'n4_key_every_caller' THEN RETURN pg_temp.mut_fn(sw, wlog,
      $q$          || jsonb_build_object('notified', coalesce(CASE WHEN p_on THEN v_notify ELSE v_notify_off END, false)));$q$);
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
    -- BACKLOG-4209
    WHEN 'r1_no_enqueue' THEN RETURN pg_temp.mut_fn(ri, $q$  IF v_notify THEN$q$, $q$  IF false THEN$q$);
    WHEN 'a1_internal_default_false' THEN RETURN pg_temp.mut_fn(ri, $q$p_notify boolean DEFAULT true$q$, $q$p_notify boolean DEFAULT false$q$);
    WHEN 'a1b_gate_actor' THEN RETURN pg_temp.mut_fn(ri, grein, replace(grein, $q$ IS NOT NULL;$q$, $q$ IS NOT NULL AND p_actor IS NOT NULL;$q$));
    WHEN 'a2_auto_double' THEN RETURN pg_temp.mut_fn(au, $q$  RETURN public._billing_reinstate_org(p_org, 'auto: paid', NULL);$q$,
      $q$  PERFORM public._billing_reinstate_org(p_org, 'auto: paid', NULL);
  INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
  VALUES (p_mode, 'notify_org_reinstated', p_org, 'notify_org_reinstated:' || p_mode || ':' || p_org::text || ':auto',
          jsonb_build_object('organization_id', p_org));
  RETURN jsonb_build_object('success', true);$q$);
    WHEN 'a3_via_constant' THEN RETURN pg_temp.mut_fn(ri, $q$v_via text := CASE WHEN p_actor IS NULL THEN 'auto' ELSE 'staff' END;$q$, $q$v_via text := 'staff';$q$);
    WHEN 'r3_no_p_notify' THEN RETURN pg_temp.mut_fn(ri, grein, replace(grein, $q$v_notify := p_notify AND $q$, $q$v_notify := $q$));
    WHEN 'r4_no_contact' THEN RETURN pg_temp.mut_fn(ri, grein, replace(grein, $q$ AND nullif(btrim(coalesce(v_deal.billing_contact_email, '')), '') IS NOT NULL$q$, ''));
    WHEN 'r5_key_version' THEN RETURN pg_temp.mut_fn(ri, $q$p_org::text || ':' || v_epoch::text,$q$, $q$p_org::text || ':v' || v_deal.version::text,$q$);
    WHEN 'r6_before_refusal' THEN RETURN pg_temp.mut_fn(ri,
      $q$  IF v_deal.status <> 'suspended' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_suspended', 'status', v_deal.status);$q$,
      $q$  IF p_notify AND nullif(btrim(coalesce(v_deal.billing_contact_email, '')), '') IS NOT NULL THEN
    INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
    VALUES (v_deal.stripe_mode, 'notify_org_reinstated', p_org,
            'notify_org_reinstated:' || v_deal.stripe_mode || ':' || p_org::text || ':'
              || coalesce(floor(extract(epoch FROM v_deal.suspended_at))::bigint, floor(extract(epoch FROM now()))::bigint)::text,
            jsonb_build_object('organization_id', p_org))
    ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;
  IF v_deal.status <> 'suspended' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_suspended', 'status', v_deal.status);$q$);
    WHEN 'r8_no_null_check' THEN RETURN pg_temp.mut_fn(ri, $q$  IF p_notify IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_request');
  END IF;
$q$, '');
    WHEN 'r9_overload' THEN
      EXECUTE $o$CREATE FUNCTION public.admin_reinstate_org(p_org uuid, p_note text)
        RETURNS jsonb LANGUAGE sql AS 'SELECT public.admin_reinstate_org(p_org, p_note, true)'$o$;
      IF to_regprocedure('public.admin_reinstate_org(uuid,text)') IS NULL THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: overload'; END IF;
      RETURN 'MUTATION APPLIED 2-arg admin_reinstate_org overload created';
    WHEN 'r10_no_on_conflict' THEN RETURN pg_temp.mut_fn(ri, $q$'suspended_at_epoch', v_epoch, 'via', v_via))
    ON CONFLICT (dedupe_key) DO NOTHING;$q$, $q$'suspended_at_epoch', v_epoch, 'via', v_via));$q$);
    WHEN 'r11_no_suspended_at' THEN RETURN pg_temp.mut_fn(ri, grein, replace(grein, $q$ AND v_deal.suspended_at IS NOT NULL$q$, ''));
    ELSE RAISE EXCEPTION 'unknown mode %', m;
    END CASE;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    o1 uuid := gen_random_uuid();  -- 4045: staff toggles (contact)
    o2 uuid := gen_random_uuid();  -- Admin / billing contact toggles (contact)
    o3 uuid := gen_random_uuid();  -- 4045: suspended while canceling (contact)
    o4 uuid := gen_random_uuid();  -- no billing contact email (N3, F7)
    o5 uuid := gen_random_uuid();  -- 4200: staff off (contact)
    o6 uuid := gen_random_uuid();  -- 4200: suspended while active, staff off (contact)
    o7 uuid := gen_random_uuid();  -- 4209 R1 staff reinstate
    o8 uuid := gen_random_uuid();  -- 4209 A1-A4 automatic reinstate
    o9 uuid := gen_random_uuid();  -- R3 p_notify false
    o10 uuid := gen_random_uuid(); -- R4 no contact (staff)
    o11 uuid := gen_random_uuid(); -- A5 no contact (automatic)
    o12 uuid := gen_random_uuid(); -- R5 suspend twice
    o13 uuid := gen_random_uuid(); -- R6 not suspended
    o14 uuid := gen_random_uuid(); -- R7 suspended while canceling
    o15 uuid := gen_random_uuid(); -- R8 p_notify NULL
    o16 uuid := gen_random_uuid(); -- R10 pre-inserted key
    o17 uuid := gen_random_uuid(); -- R11 suspended_at NULL
    all_orgs uuid[];
    no_contact uuid[];
    u_sales uuid := gen_random_uuid(); u_adm uuid := gen_random_uuid(); u_bc uuid := gen_random_uuid();
    m_bc uuid; v_team uuid;
    g text; g2 text; s text; v jsonb; v2 jsonb; n int; n2 int; c int; e1 bigint; e2 bigint; ver0 int;
    q_sw text := 'SELECT public.set_org_auto_renew(%L::uuid, %s, %L, %s)';
    q_sw5 text := 'SELECT public.set_org_auto_renew(%L::uuid, %s, %L, %s, %s)';
    q_named text := 'SELECT public.set_org_auto_renew(p_org => %L::uuid, p_on => %s, p_note => %L, p_expected_version => %s)';
    q_re2 text := 'SELECT public.admin_reinstate_org(p_org => %L::uuid, p_note => %L)';
    q_re2p text := 'SELECT public.admin_reinstate_org(%L::uuid, %L)';
    q_re3 text := 'SELECT public.admin_reinstate_org(p_org => %L::uuid, p_note => %L, p_notify => %s)';
    v_end timestamptz := date_trunc('second', now() + interval '20 days');
  BEGIN
    all_orgs := ARRAY[o1, o2, o3, o4, o5, o6, o7, o8, o9, o10, o11, o12, o13, o14, o15, o16, o17];
    no_contact := ARRAY[o4, o10, o11];
    SELECT id INTO v_team FROM public.plans WHERE name = 'Team';
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT x, 'p4200-' || left(x::text, 8) || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM unnest(ARRAY[u_sales, u_adm, u_bc]) x;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    SELECT x, (SELECT a.email FROM auth.users a WHERE a.id = x), 'email', x::text, 'P4200 ' || left(x::text, 4)
      FROM unnest(ARRAY[u_sales, u_adm, u_bc]) x
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.internal_roles (user_id, role_id)
    SELECT u_sales, ar.id FROM public.admin_roles ar WHERE ar.slug = 'sales';
    INSERT INTO public.organizations (id, name, slug, max_seats, is_test)
    SELECT x, 'P4200 ' || left(x::text, 8), 'p4200-' || left(x::text, 8), 20, true FROM unnest(all_orgs) x;
    INSERT INTO public.organization_plans (organization_id, plan_id) SELECT x, v_team FROM unnest(all_orgs) x;
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, created_at)
      VALUES (o2, u_adm, 'admin', 'active', now(), now());
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, created_at)
      VALUES (o2, u_bc, 'agent', 'active', now(), now()) RETURNING id INTO m_bc;
    INSERT INTO public.org_contacts (organization_id, role, member_id) VALUES (o2, 'billing', m_bc);
    INSERT INTO public.org_deals (organization_id, stripe_mode, plan_id, seats, start_date, status, version, billing_contact_email)
    SELECT x, 'test', v_team, 5, current_date, 'active', 1,
           CASE WHEN x = ANY (no_contact) THEN NULL ELSE 'p4200-billing-' || left(x::text, 8) || '@example.test' END
      FROM unnest(all_orgs) x;
    INSERT INTO public.org_billing_stripe (organization_id, stripe_mode, stripe_customer_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end)
    SELECT x, 'test', 'cus_p4200_' || left(x::text, 8), 'sub_p4200_' || left(x::text, 8), 'active', v_end, false FROM unnest(all_orgs) x;
    PERFORM public._billing_apply_org_entitlement(x) FROM unnest(all_orgs) x;

    BEGIN
      EXECUTE __GUARD4200__;
      g := 'pass';
    EXCEPTION WHEN OTHERS THEN g := 'raised: ' || left(SQLERRM, 120);
    END;
    r := r || jsonb_build_object('G_guard_4200', pg_temp.pass(g = 'pass', g));
    BEGIN
      EXECUTE __GUARD4209__;
      g2 := 'pass';
    EXCEPTION WHEN OTHERS THEN g2 := 'raised: ' || left(SQLERRM, 120);
    END;
    r := r || jsonb_build_object('G_guard_4209', pg_temp.pass(g2 = 'pass', g2));

    -- ===================== BACKLOG-4045 / 4045b (ported) =====================
    r := r || jsonb_build_object('N8_grants_one_signature', pg_temp.pass(
      (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'set_org_auto_renew') = 1
      AND (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_billing_set_auto_renew') = 1
      AND to_regprocedure('public.set_org_auto_renew(uuid,boolean,text,integer,boolean)') IS NOT NULL
      AND to_regprocedure('public._billing_set_auto_renew(uuid,boolean,text,uuid,text,integer,boolean)') IS NOT NULL
      AND NOT has_function_privilege('anon', 'public.set_org_auto_renew(uuid,boolean,text,integer,boolean)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.set_org_auto_renew(uuid,boolean,text,integer,boolean)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public._billing_set_auto_renew(uuid,boolean,text,uuid,text,integer,boolean)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public._billing_set_auto_renew(uuid,boolean,text,uuid,text,integer,boolean)', 'EXECUTE'), 'grants'));

    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o1, 'true', 'p4200 on while active', 1)));
    r := r || jsonb_build_object('C4_noop_no_row', pg_temp.pass(
      v ->> 'success' = 'true' AND v ->> 'changed' = 'false' AND pg_temp.ver(o1) = 1 AND pg_temp.ar(o1) = 0,
      v::text || ' rows=' || pg_temp.ar(o1)));
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o1, 'false', 'p4200 staff off', 1)));
    r := r || jsonb_build_object('C2_staff_off_no_row', pg_temp.pass(
      v ->> 'success' = 'true' AND pg_temp.st(o1) = 'canceling/-' AND pg_temp.ver(o1) = 2 AND pg_temp.ar(o1) = 0,
      v::text || ' rows=' || pg_temp.ar(o1)));
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o1, 'true', 'p4200 staff on', 2)));
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
    s := pg_temp.call_as(u_sales, format('SELECT public.admin_get_org_activity(%L::uuid, 100)', o1));
    r := r || jsonb_build_object('N6_reader_notified', pg_temp.pass(
      EXISTS (SELECT 1 FROM jsonb_array_elements(pg_temp.j(s)) e WHERE e ->> 'action' = 'auto_renew_on' AND e -> 'detail' ->> 'notified' = 'true')
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(pg_temp.j(s)) e WHERE e ->> 'action' = 'auto_renew_off' AND e -> 'detail' ->> 'notified' = 'true'),
      left(s, 160)));

    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o1, 'false', 'p4200 staff off 2', 3)));
    INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
    VALUES ('test', 'notify_auto_renew_on', o1, 'notify_auto_renew_on:test:' || o1::text || ':v5', '{"p4200":"pre-existing"}');
    v2 := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o1, 'true', 'p4200 staff on 2', 4)));
    r := r || jsonb_build_object('C6_dedupe_on_conflict', pg_temp.pass(
      v2 ->> 'success' = 'true' AND pg_temp.ver(o1) = 5
      AND (SELECT count(*) FROM public.billing_outbox b WHERE b.dedupe_key = 'notify_auto_renew_on:test:' || o1::text || ':v5') = 1,
      'on=' || v2::text || ' ver=' || pg_temp.ver(o1)));

    s := pg_temp.call_as(u_sales, format(q_named, o1, 'false', 'p4200 named off', 5));
    r := r || jsonb_build_object('N1b_named_args_resolve', pg_temp.pass(
      pg_temp.j(s) ->> 'success' = 'true' AND pg_temp.ver(o1) = 6, s));
    n := pg_temp.ar(o1);
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw5, o1, 'true', 'p4200 on no email', 6, 'false')));
    r := r || jsonb_build_object('N2_unticked_no_row', pg_temp.pass(
      v ->> 'success' = 'true' AND pg_temp.st(o1) = 'active/-' AND pg_temp.ver(o1) = 7 AND pg_temp.ar(o1) = n
      AND pg_temp.nt(o1, 7) = 'false' AND v ->> 'notified' = 'false',
      v::text || ' rows ' || n || '->' || pg_temp.ar(o1) || ' nt=' || pg_temp.nt(o1, 7)));
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o1, 'false', 'p4200 off before null', 7)));
    n := pg_temp.ar(o1); n2 := pg_temp.offr(o1); c := pg_temp.cl(o1);
    s := pg_temp.call_as(u_sales, format(q_sw5, o1, 'true', 'p4200 null notify', 8, 'NULL'));
    r := r || jsonb_build_object('N9_null_notify_refused', pg_temp.pass(
      pg_temp.j(s) ->> 'error' = 'invalid_request' AND pg_temp.ver(o1) = 8 AND pg_temp.st(o1) = 'canceling/-'
      AND pg_temp.ar(o1) = n AND pg_temp.offr(o1) = n2 AND pg_temp.cl(o1) = c,
      s || ' ver=' || pg_temp.ver(o1) || ' cl ' || c || '->' || pg_temp.cl(o1)));

    -- N3 / F7: no billing contact email
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o4, 'false', 'p4200 off', 1)));
    r := r || jsonb_build_object('F7_off_no_contact_no_row', pg_temp.pass(
      v ->> 'success' = 'true' AND v ->> 'changed' = 'true' AND pg_temp.offr(o4) = 0 AND pg_temp.ntoff(o4, 2) = 'false' AND v ->> 'notified' = 'false',
      v::text || ' rows=' || pg_temp.offr(o4) || ' nt=' || pg_temp.ntoff(o4, 2)));
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o4, 'true', 'p4200 on no contact', 2)));
    r := r || jsonb_build_object('N3_no_contact_no_row', pg_temp.pass(
      v ->> 'success' = 'true' AND pg_temp.ver(o4) = 3 AND pg_temp.ar(o4) = 0 AND pg_temp.nt(o4, 3) = 'false',
      v::text || ' rows=' || pg_temp.ar(o4) || ' nt=' || pg_temp.nt(o4, 3)));

    -- C3 / N4 / F3: Admin and billing contact toggles
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o2, 'false', 'p4200 staff off', 1)));
    n2 := pg_temp.offr(o2);
    v := pg_temp.j(pg_temp.call_as(u_adm, format(q_sw, o2, 'true', NULL, 2)));
    n := pg_temp.ar(o2);
    v2 := pg_temp.j(pg_temp.call_as(u_adm, format(q_sw, o2, 'false', NULL, 3)));
    s := (v2 ->> 'changed');
    v2 := pg_temp.j(pg_temp.call_as(u_bc, format(q_sw, o2, 'true', NULL, 4)));
    r := r || jsonb_build_object('C3_brokerage_on_no_row', pg_temp.pass(
      v ->> 'changed' = 'true' AND v2 ->> 'changed' = 'true' AND pg_temp.ver(o2) = 5
      AND n = 0 AND pg_temp.ar(o2) = 0,
      'adm=' || v::text || ' bc=' || v2::text || ' rows ' || n || '/' || pg_temp.ar(o2)));
    r := r || jsonb_build_object('N4_no_key_for_brokerage', pg_temp.pass(
      pg_temp.nt(o2, 3) = 'absent' AND pg_temp.nt(o2, 5) = 'absent', 'v3=' || pg_temp.nt(o2, 3) || ' v5=' || pg_temp.nt(o2, 5)));
    v2 := pg_temp.j(pg_temp.call_as(u_bc, format(q_sw, o2, 'false', NULL, 5)));
    r := r || jsonb_build_object('F3_brokerage_off_no_row', pg_temp.pass(
      s = 'true' AND v2 ->> 'changed' = 'true' AND pg_temp.st(o2) = 'canceling/-' AND pg_temp.ver(o2) = 6
      AND n2 = 1 AND pg_temp.offr(o2) = 1
      AND pg_temp.ntoff(o2, 4) = 'absent' AND pg_temp.ntoff(o2, 6) = 'absent' AND NOT (v2 ? 'notified')
      AND pg_temp.am_rows(o2) = 2,
      'staffoff=' || n2 || ' off=' || pg_temp.offr(o2) || ' v4=' || pg_temp.ntoff(o2, 4) || ' v6=' || pg_temp.ntoff(o2, 6) || ' am=' || pg_temp.am_rows(o2)));

    -- C5 / N5: suspended while canceling, staff on
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o3, 'false', 'p4200 staff off', 1)));
    PERFORM public._billing_suspend_org(o3, 'other', 'p4200', u_sales);
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o3, 'true', 'p4200 staff on while suspended', pg_temp.ver(o3))));
    r := r || jsonb_build_object('C5_suspended_no_row', pg_temp.pass(
      v ->> 'success' = 'true' AND v ->> 'changed' = 'true' AND pg_temp.st(o3) = 'suspended/active' AND pg_temp.ar(o3) = 0,
      v::text || ' st=' || pg_temp.st(o3) || ' rows=' || pg_temp.ar(o3)));
    r := r || jsonb_build_object('N5_suspended_notified_false', pg_temp.pass(
      pg_temp.nt(o3, pg_temp.ver(o3)) = 'false', 'nt=' || pg_temp.nt(o3, pg_temp.ver(o3))));

    -- ===================== BACKLOG-4200 =====================
    -- F1 staff off, active -> canceling, 4-arg call (p_notify default)
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o5, 'false', 'p4200 F1 off', 1)));
    r := r || jsonb_build_object('F1_staff_off_one_row', pg_temp.pass(
      v ->> 'success' = 'true' AND v ->> 'changed' = 'true' AND pg_temp.st(o5) = 'canceling/-' AND pg_temp.ver(o5) = 2 AND pg_temp.offr(o5) = 1
      AND EXISTS (SELECT 1 FROM public.billing_outbox b WHERE b.organization_id = o5 AND b.kind = 'notify_auto_renew_off'
                   AND b.dedupe_key = 'notify_auto_renew_off:test:' || o5::text || ':v2'
                   AND b.payload = jsonb_build_object('organization_id', o5, 'version', 2)),
      v::text || ' rows=' || pg_temp.offr(o5)));
    r := r || jsonb_build_object('F9_log_notified_true', pg_temp.pass(
      pg_temp.ntoff(o5, 2) = 'true', 'nt=' || pg_temp.ntoff(o5, 2)));
    r := r || jsonb_build_object('F10_result_and_audit_notified', pg_temp.pass(
      v ->> 'notified' = 'true'
      AND EXISTS (SELECT 1 FROM public.admin_audit_logs a WHERE a.actor_id = u_sales AND a.action = 'billing.auto_renew_off'
                   AND a.target_id = o5::text AND a.metadata ->> 'notified' = 'true' AND (a.metadata ->> 'version')::int = 2),
      'res=' || v::text || ' audit=' || coalesce((SELECT a.metadata::text FROM public.admin_audit_logs a WHERE a.action = 'billing.auto_renew_off' AND a.target_id = o5::text LIMIT 1), 'none')));
    -- F4 staff off again on a canceling deal: no-op, no row
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o5, 'false', 'p4200 F4 off again', 2)));
    r := r || jsonb_build_object('F4_noop_no_row', pg_temp.pass(
      v ->> 'success' = 'true' AND v ->> 'changed' = 'false' AND pg_temp.ver(o5) = 2 AND pg_temp.offr(o5) = 1,
      v::text || ' rows=' || pg_temp.offr(o5)));
    -- F2 staff on: no off row
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o5, 'true', 'p4200 F2 on', 2)));
    r := r || jsonb_build_object('F2_staff_on_no_off_row', pg_temp.pass(
      v ->> 'success' = 'true' AND pg_temp.st(o5) = 'active/-' AND pg_temp.ver(o5) = 3 AND pg_temp.offr(o5) = 1,
      v::text || ' rows=' || pg_temp.offr(o5)));
    -- F6 staff off with p_notify false
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw5, o5, 'false', 'p4200 F6 off unticked', 3, 'false')));
    r := r || jsonb_build_object('F6_unticked_no_row', pg_temp.pass(
      v ->> 'success' = 'true' AND pg_temp.st(o5) = 'canceling/-' AND pg_temp.ver(o5) = 4 AND pg_temp.offr(o5) = 1
      AND pg_temp.ntoff(o5, 4) = 'false' AND v ->> 'notified' = 'false',
      v::text || ' rows=' || pg_temp.offr(o5) || ' nt=' || pg_temp.ntoff(o5, 4)));
    -- F8 pre-inserted key: no error, still one row
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw5, o5, 'true', 'p4200 F8 on', 4, 'false')));
    INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
    VALUES ('test', 'notify_auto_renew_off', o5, 'notify_auto_renew_off:test:' || o5::text || ':v6', '{"p4200":"pre-existing"}');
    v2 := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o5, 'false', 'p4200 F8 off', 5)));
    r := r || jsonb_build_object('F8_dedupe_on_conflict', pg_temp.pass(
      v2 ->> 'success' = 'true' AND pg_temp.ver(o5) = 6
      AND (SELECT count(*) FROM public.billing_outbox b WHERE b.dedupe_key = 'notify_auto_renew_off:test:' || o5::text || ':v6') = 1,
      'off=' || v2::text || ' ver=' || pg_temp.ver(o5)));
    -- F5 suspended while active, staff off: stays suspended, no row, notified false
    PERFORM public._billing_suspend_org(o6, 'other', 'p4200', u_sales);
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o6, 'false', 'p4200 F5 off while suspended', pg_temp.ver(o6))));
    r := r || jsonb_build_object('F5_suspended_no_row', pg_temp.pass(
      v ->> 'success' = 'true' AND v ->> 'changed' = 'true' AND pg_temp.st(o6) = 'suspended/canceling' AND pg_temp.offr(o6) = 0
      AND pg_temp.ntoff(o6, pg_temp.ver(o6)) = 'false',
      v::text || ' st=' || pg_temp.st(o6) || ' rows=' || pg_temp.offr(o6) || ' nt=' || pg_temp.ntoff(o6, pg_temp.ver(o6))));

    -- ===================== BACKLOG-4209 =====================
    r := r || jsonb_build_object('R9_grants_one_signature', pg_temp.pass(
      (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'admin_reinstate_org') = 1
      AND (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '_billing_reinstate_org') = 1
      AND to_regprocedure('public.admin_reinstate_org(uuid,text,boolean)') IS NOT NULL
      AND to_regprocedure('public._billing_reinstate_org(uuid,text,uuid,boolean)') IS NOT NULL
      AND NOT has_function_privilege('anon', 'public.admin_reinstate_org(uuid,text,boolean)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.admin_reinstate_org(uuid,text,boolean)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public._billing_reinstate_org(uuid,text,uuid,boolean)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public._billing_reinstate_org(uuid,text,uuid,boolean)', 'EXECUTE'), 'grants'));

    -- R1 staff reinstate, old 2-arg named call (the current admin-portal shape)
    PERFORM public._billing_suspend_org(o7, 'other', 'p4209', u_sales);
    e1 := pg_temp.ep(o7);
    s := pg_temp.call_as(u_sales, format(q_re2, o7, 'p4209 R1 reinstate'));
    r := r || jsonb_build_object('R1_staff_reinstate_one_row', pg_temp.pass(
      pg_temp.j(s) ->> 'success' = 'true' AND pg_temp.st(o7) = 'active/-' AND pg_temp.rr(o7) = 1
      AND EXISTS (SELECT 1 FROM public.billing_outbox b WHERE b.organization_id = o7 AND b.kind = 'notify_org_reinstated'
                   AND b.dedupe_key = 'notify_org_reinstated:test:' || o7::text || ':' || e1::text
                   AND b.payload = jsonb_build_object('organization_id', o7, 'suspended_at_epoch', e1, 'via', 'staff'))
      AND pg_temp.rdet(o7) ->> 'notified' = 'true' AND pg_temp.rdet(o7) ->> 'via' = 'staff'
      AND (pg_temp.rdet(o7) ->> 'suspended_at_epoch')::bigint = e1
      AND EXISTS (SELECT 1 FROM public.billing_change_log l WHERE l.organization_id = o7 AND l.action = 'reinstated' AND l.actor_id = u_sales),
      s || ' rows=' || pg_temp.rr(o7) || ' det=' || pg_temp.rdet(o7)::text));
    s := pg_temp.call_as(u_sales, format('SELECT public.admin_get_org_activity(%L::uuid, 100)', o7));
    r := r || jsonb_build_object('R1b_reader_notified', pg_temp.pass(
      EXISTS (SELECT 1 FROM jsonb_array_elements(pg_temp.j(s)) e WHERE e ->> 'action' = 'reinstated' AND e -> 'detail' ->> 'notified' = 'true'),
      left(s, 160)));

    -- A1 automatic reinstate after a payment (non_payment, back-dated suspension, paid after)
    PERFORM public._billing_suspend_org(o8, 'non_payment', 'p4209', NULL);
    UPDATE public.org_deals SET suspended_at = now() - interval '2 days' WHERE organization_id = o8;
    UPDATE public.org_billing_stripe SET last_invoice_paid_event_created = floor(extract(epoch FROM now()))::bigint WHERE organization_id = o8;
    e1 := pg_temp.ep(o8);
    v := public._billing_auto_reinstate(o8, 'test');
    r := r || jsonb_build_object('A1_auto_reinstate_one_row', pg_temp.pass(
      v ->> 'success' = 'true' AND pg_temp.st(o8) = 'active/-' AND pg_temp.rr(o8) = 1
      AND EXISTS (SELECT 1 FROM public.billing_outbox b WHERE b.organization_id = o8 AND b.kind = 'notify_org_reinstated'
                   AND b.dedupe_key = 'notify_org_reinstated:test:' || o8::text || ':' || e1::text
                   AND b.payload ->> 'via' = 'auto')
      AND pg_temp.rdet(o8) ->> 'notified' = 'true' AND pg_temp.rdet(o8) ->> 'via' = 'auto',
      v::text || ' rows=' || pg_temp.rr(o8) || ' det=' || pg_temp.rdet(o8)::text));
    r := r || jsonb_build_object('A2_one_email_only', pg_temp.pass(
      (SELECT count(*) FROM public.billing_outbox b WHERE b.organization_id = o8
         AND b.kind NOT IN ('sync_org_subscription', 'notify_org_suspended')) = 1,
      (SELECT string_agg(b.kind || '=' || b.dedupe_key, ', ') FROM public.billing_outbox b WHERE b.organization_id = o8)));
    r := r || jsonb_build_object('A3_via_staff_and_auto', pg_temp.pass(
      EXISTS (SELECT 1 FROM public.billing_outbox b WHERE b.organization_id = o7 AND b.kind = 'notify_org_reinstated' AND b.payload ->> 'via' = 'staff')
      AND EXISTS (SELECT 1 FROM public.billing_outbox b WHERE b.organization_id = o8 AND b.kind = 'notify_org_reinstated' AND b.payload ->> 'via' = 'auto'),
      'via'));
    v := public._billing_auto_reinstate(o8, 'test');
    r := r || jsonb_build_object('A4_second_call_no_row', pg_temp.pass(
      v ->> 'error' = 'not_suspended' AND pg_temp.rr(o8) = 1, v::text || ' rows=' || pg_temp.rr(o8)));

    -- A5 automatic, no billing contact email
    PERFORM public._billing_suspend_org(o11, 'non_payment', 'p4209', NULL);
    UPDATE public.org_deals SET suspended_at = now() - interval '2 days' WHERE organization_id = o11;
    UPDATE public.org_billing_stripe SET last_invoice_paid_event_created = floor(extract(epoch FROM now()))::bigint WHERE organization_id = o11;
    v := public._billing_auto_reinstate(o11, 'test');
    r := r || jsonb_build_object('A5_auto_no_contact_no_row', pg_temp.pass(
      v ->> 'success' = 'true' AND pg_temp.st(o11) = 'active/-' AND pg_temp.rr(o11) = 0 AND pg_temp.rdet(o11) ->> 'notified' = 'false',
      v::text || ' rows=' || pg_temp.rr(o11) || ' det=' || pg_temp.rdet(o11)::text));

    -- R3 staff, p_notify false
    PERFORM public._billing_suspend_org(o9, 'other', 'p4209', u_sales);
    s := pg_temp.call_as(u_sales, format(q_re3, o9, 'p4209 R3', 'false'));
    r := r || jsonb_build_object('R3_unticked_no_row', pg_temp.pass(
      pg_temp.j(s) ->> 'success' = 'true' AND pg_temp.st(o9) = 'active/-' AND pg_temp.rr(o9) = 0 AND pg_temp.rdet(o9) ->> 'notified' = 'false',
      s || ' rows=' || pg_temp.rr(o9) || ' det=' || pg_temp.rdet(o9)::text));
    -- R4 staff, no billing contact email
    PERFORM public._billing_suspend_org(o10, 'other', 'p4209', u_sales);
    s := pg_temp.call_as(u_sales, format(q_re3, o10, 'p4209 R4', 'true'));
    r := r || jsonb_build_object('R4_no_contact_no_row', pg_temp.pass(
      pg_temp.j(s) ->> 'success' = 'true' AND pg_temp.rr(o10) = 0 AND pg_temp.rdet(o10) ->> 'notified' = 'false',
      s || ' rows=' || pg_temp.rr(o10) || ' det=' || pg_temp.rdet(o10)::text));
    -- R5 suspend (back-dated) -> reinstate -> suspend -> reinstate: version unchanged, two keys
    ver0 := pg_temp.ver(o12);
    PERFORM public._billing_suspend_org(o12, 'other', 'p4209', u_sales);
    UPDATE public.org_deals SET suspended_at = now() - interval '1 day' WHERE organization_id = o12;
    e1 := pg_temp.ep(o12);
    s := pg_temp.call_as(u_sales, format(q_re2, o12, 'p4209 R5 first'));
    PERFORM public._billing_suspend_org(o12, 'other', 'p4209 again', u_sales);
    e2 := pg_temp.ep(o12);
    s := s || ' | ' || pg_temp.call_as(u_sales, format(q_re2, o12, 'p4209 R5 second'));
    r := r || jsonb_build_object('R5_two_suspensions_two_rows', pg_temp.pass(
      pg_temp.ver(o12) = ver0 AND e1 <> e2 AND pg_temp.rr(o12) = 2 AND pg_temp.st(o12) = 'active/-'
      AND (SELECT count(DISTINCT b.dedupe_key) FROM public.billing_outbox b WHERE b.organization_id = o12 AND b.kind = 'notify_org_reinstated') = 2,
      s || ' ver ' || ver0 || '->' || pg_temp.ver(o12) || ' rows=' || pg_temp.rr(o12)));
    -- R6 reinstate on a deal that is not suspended: refused, no row
    s := pg_temp.call_as(u_sales, format(q_re2, o13, 'p4209 R6'));
    r := r || jsonb_build_object('R6_not_suspended_no_row', pg_temp.pass(
      pg_temp.j(s) ->> 'error' = 'not_suspended' AND pg_temp.rr(o13) = 0 AND pg_temp.rcl(o13) = 0,
      s || ' rows=' || pg_temp.rr(o13)));
    -- R7 suspended while canceling -> canceling, one row
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw5, o14, 'false', 'p4209 R7 off', 1, 'false')));
    PERFORM public._billing_suspend_org(o14, 'other', 'p4209', u_sales);
    s := pg_temp.call_as(u_sales, format(q_re2, o14, 'p4209 R7'));
    r := r || jsonb_build_object('R7_canceling_one_row', pg_temp.pass(
      pg_temp.j(s) ->> 'success' = 'true' AND pg_temp.st(o14) = 'canceling/-' AND pg_temp.rr(o14) = 1,
      s || ' st=' || pg_temp.st(o14) || ' rows=' || pg_temp.rr(o14)));
    -- R8 p_notify NULL: refused, nothing written
    PERFORM public._billing_suspend_org(o15, 'other', 'p4209', u_sales);
    s := pg_temp.call_as(u_sales, format(q_re3, o15, 'p4209 R8', 'NULL'));
    r := r || jsonb_build_object('R8_null_notify_refused', pg_temp.pass(
      pg_temp.j(s) ->> 'error' = 'invalid_request' AND pg_temp.st(o15) = 'suspended/active' AND pg_temp.rcl(o15) = 0 AND pg_temp.rr(o15) = 0,
      s || ' st=' || pg_temp.st(o15) || ' cl=' || pg_temp.rcl(o15)));
    -- R10 the key already exists: no error, still one row (2-arg positional call)
    PERFORM public._billing_suspend_org(o16, 'other', 'p4209', u_sales);
    e1 := pg_temp.ep(o16);
    INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
    VALUES ('test', 'notify_org_reinstated', o16, 'notify_org_reinstated:test:' || o16::text || ':' || e1::text, '{"p4209":"pre-existing"}');
    s := pg_temp.call_as(u_sales, format(q_re2p, o16, 'p4209 R10'));
    r := r || jsonb_build_object('R10_dedupe_on_conflict', pg_temp.pass(
      pg_temp.j(s) ->> 'success' = 'true' AND pg_temp.st(o16) = 'active/-'
      AND (SELECT count(*) FROM public.billing_outbox b WHERE b.dedupe_key = 'notify_org_reinstated:test:' || o16::text || ':' || e1::text) = 1,
      s));
    -- R11 suspended with suspended_at NULL: reinstated, no row, notified false (reds by EXCEPTION under its mutation)
    PERFORM public._billing_suspend_org(o17, 'other', 'p4209', u_sales);
    UPDATE public.org_deals SET suspended_at = NULL WHERE organization_id = o17;
    s := pg_temp.call_as(u_sales, format(q_re3, o17, 'p4209 R11', 'true'));
    r := r || jsonb_build_object('R11_null_suspended_at_no_row', pg_temp.pass(
      pg_temp.j(s) ->> 'success' = 'true' AND pg_temp.st(o17) = 'active/-' AND pg_temp.rr(o17) = 0 AND pg_temp.rdet(o17) ->> 'notified' = 'false',
      s || ' rows=' || pg_temp.rr(o17)));

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
  RAISE EXCEPTION 'P4200_4209_RESULT %', v_res;
END
$drv$;
