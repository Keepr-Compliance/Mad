-- BACKLOG-3850 DB controls (SR R10). Venue: keepr-test via kt-sql, ONE call, one implicit
-- transaction that always ends in RAISE, so nothing persists (compose.py appends a final RAISE
-- as a backstop). Each scenario runs in its own subtransaction that is rolled back by
-- RAISE 'S_DONE'; its counts survive in PL/pgSQL variables.
-- Output: RAISE 'P3850_RESULT {"mode": ..., "pass": n, "fail": n, "results": {...}}'.

CREATE FUNCTION pg_temp.mk_user(p_customers text[], p_is_test boolean DEFAULT true) RETURNS uuid
LANGUAGE plpgsql AS $b$
DECLARE u uuid := gen_random_uuid(); po uuid; m text;
BEGIN
  INSERT INTO auth.users (id, email, instance_id, aud, role)
  VALUES (u, 'p3850-' || u || '@example.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
  -- A licence row: the deactivation revert (_ensure_personal_organization_for) needs one (S4).
  INSERT INTO public.licenses (user_id, license_key, license_type, status) VALUES (u, 'lk-3850-' || u, 'individual', 'active');
  INSERT INTO public.organizations (name, slug, personal_owner_user_id, is_test, max_seats)
  VALUES ('Personal', 'p3850-' || u, u, p_is_test, 1) RETURNING id INTO po;
  INSERT INTO public.organization_members (organization_id, user_id, role, license_status) VALUES (po, u, 'agent', 'active');
  FOREACH m IN ARRAY p_customers LOOP
    INSERT INTO public.stripe_customers (user_id, stripe_customer_id, stripe_mode) VALUES (u, 'cus_p3850_' || m, m);
  END LOOP;
  RETURN u;
END $b$;

CREATE FUNCTION pg_temp.mk_brokerage() RETURNS uuid LANGUAGE plpgsql AS $b$
DECLARE o uuid;
BEGIN
  INSERT INTO public.organizations (name, slug, is_test, max_seats)
  VALUES ('Brokerage 3850', 'b3850-' || gen_random_uuid(), true, 10) RETURNING id INTO o;
  RETURN o;
END $b$;

CREATE FUNCTION pg_temp.ob(u uuid) RETURNS int LANGUAGE sql AS $b$
  SELECT count(*)::int FROM public.billing_outbox WHERE user_id = u AND kind = 'cancel_agent_on_brokerage_join'
$b$;

CREATE FUNCTION pg_temp.personal(u uuid) RETURNS int LANGUAGE sql AS $b$
  SELECT count(*)::int FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id
   WHERE m.user_id = u AND o.personal_owner_user_id IS NOT NULL
$b$;

DO $drv$
DECLARE
  v_res jsonb := '{}'::jsonb;
  v_got jsonb;
  u uuid; b uuid; mid uuid; r record;
  v_pass int := 0; v_fail int := 0; k text; v_exp jsonb;
  v_expect jsonb := '{
    "S1_jit_insert":        {"outbox":1,"personal":0,"org_id_null":true,"payload_ok":true},
    "S2_insert_two_updates":{"outbox":1},
    "S3_invite_accept":     {"outbox":1,"personal":0},
    "S3u_unlicensed_accept":{"outbox":1,"personal":0},
    "S4_suspend_reactivate":{"outbox":2,"distinct_keys":2},
    "S5_no_customer":       {"outbox":0,"personal":0,"member":1},
    "S6_guard_raises":      {"outbox":0,"personal":0,"member":1},
    "S7_join_suspended":    {"outbox":0,"personal":1},
    "S7b_personal_update":  {"outbox":0,"personal":1},
    "S8_both_modes":        {"outbox":2,"modes":"live,test"},
    "C_catalog":            {"client_exec":0,"definer":true,"search_path":true}
  }'::jsonb;
BEGIN
  -- S1: JIT-style INSERT of an active brokerage row.
  BEGIN
    u := pg_temp.mk_user(ARRAY['test']); b := pg_temp.mk_brokerage();
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by)
    VALUES (b, u, 'agent', 'active', now(), 'jit') RETURNING id INTO mid;
    SELECT * INTO r FROM public.billing_outbox WHERE user_id = u AND kind = 'cancel_agent_on_brokerage_join' LIMIT 1;
    v_got := jsonb_build_object('outbox', pg_temp.ob(u), 'personal', pg_temp.personal(u),
      'org_id_null', r.organization_id IS NULL,
      'payload_ok', r.payload = jsonb_build_object('brokerage_organization_id', b, 'member_id', mid, 'stripe_customer_id', 'cus_p3850_test')
                    AND r.stripe_mode = 'test' AND r.dedupe_key LIKE 'join-cancel:test:' || u || ':%');
    RAISE EXCEPTION 'S_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'S_DONE' THEN v_got := jsonb_build_object('error', SQLSTATE || ' ' || left(SQLERRM, 120)); END IF;
  END;
  v_res := v_res || jsonb_build_object('S1_jit_insert', v_got);

  -- S2 / C4: INSERT active, UPDATE active (unchanged value), UPDATE unassigned, one transaction.
  BEGIN
    u := pg_temp.mk_user(ARRAY['test']); b := pg_temp.mk_brokerage();
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at)
    VALUES (b, u, 'agent', 'active', now()) RETURNING id INTO mid;
    UPDATE public.organization_members SET license_status = 'active' WHERE id = mid;
    UPDATE public.organization_members SET license_status = 'unassigned' WHERE id = mid;
    v_got := jsonb_build_object('outbox', pg_temp.ob(u));
    RAISE EXCEPTION 'S_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'S_DONE' THEN v_got := jsonb_build_object('error', SQLSTATE || ' ' || left(SQLERRM, 120)); END IF;
  END;
  v_res := v_res || jsonb_build_object('S2_insert_two_updates', v_got);

  -- S3 / C9: invite row (user_id NULL), then the accept_invitation claim UPDATE (licensed).
  -- S3u: the same with an unlicensed invite ('unassigned', 20261018170000:322).
  FOR k IN SELECT unnest(ARRAY['active', 'unassigned']) LOOP
    BEGIN
      u := pg_temp.mk_user(ARRAY['test']); b := pg_temp.mk_brokerage();
      INSERT INTO public.organization_members (organization_id, user_id, role, license_status, invited_email, invitation_token, invitation_expires_at)
      VALUES (b, NULL, 'agent', k, 'p3850-' || u || '@example.test', 'tok-3850-' || u, now() + interval '7 days') RETURNING id INTO mid;
      UPDATE public.organization_members SET user_id = u, license_status = k, joined_at = now(), invitation_token = NULL
       WHERE id = mid AND user_id IS NULL;
      v_got := jsonb_build_object('outbox', pg_temp.ob(u), 'personal', pg_temp.personal(u));
      RAISE EXCEPTION 'S_DONE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'S_DONE' THEN v_got := jsonb_build_object('error', SQLSTATE || ' ' || left(SQLERRM, 120)); END IF;
    END;
    v_res := v_res || jsonb_build_object(CASE k WHEN 'active' THEN 'S3_invite_accept' ELSE 'S3u_unlicensed_accept' END, v_got);
  END LOOP;

  -- S4 / C9: join, suspend (the revert trigger recreates the personal row), reactivate.
  BEGIN
    u := pg_temp.mk_user(ARRAY['test']); b := pg_temp.mk_brokerage();
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at)
    VALUES (b, u, 'agent', 'active', now()) RETURNING id INTO mid;
    UPDATE public.organization_members SET license_status = 'suspended' WHERE id = mid;
    UPDATE public.organization_members SET license_status = 'active' WHERE id = mid;
    v_got := jsonb_build_object('outbox', pg_temp.ob(u),
      'distinct_keys', (SELECT count(DISTINCT dedupe_key) FROM public.billing_outbox WHERE user_id = u AND kind = 'cancel_agent_on_brokerage_join'));
    RAISE EXCEPTION 'S_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'S_DONE' THEN v_got := jsonb_build_object('error', SQLSTATE || ' ' || left(SQLERRM, 120)); END IF;
  END;
  v_res := v_res || jsonb_build_object('S4_suspend_reactivate', v_got);

  -- S5 / C2: no stripe_customers row -> no row, the join commits.
  BEGIN
    u := pg_temp.mk_user(ARRAY[]::text[]); b := pg_temp.mk_brokerage();
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at)
    VALUES (b, u, 'agent', 'active', now());
    v_got := jsonb_build_object('outbox', pg_temp.ob(u), 'personal', pg_temp.personal(u),
      'member', (SELECT count(*) FROM public.organization_members WHERE organization_id = b AND user_id = u));
    RAISE EXCEPTION 'S_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'S_DONE' THEN v_got := jsonb_build_object('error', SQLSTATE || ' ' || left(SQLERRM, 120)); END IF;
  END;
  v_res := v_res || jsonb_build_object('S5_no_customer', v_got);

  -- S6 / C8: the test-mode guard raises 42501 (personal org not is_test) -> no row, join commits.
  BEGIN
    u := pg_temp.mk_user(ARRAY['test']); b := pg_temp.mk_brokerage();
    UPDATE public.organizations SET is_test = false WHERE personal_owner_user_id = u;
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at)
    VALUES (b, u, 'agent', 'active', now());
    v_got := jsonb_build_object('outbox', pg_temp.ob(u), 'personal', pg_temp.personal(u),
      'member', (SELECT count(*) FROM public.organization_members WHERE organization_id = b AND user_id = u));
    RAISE EXCEPTION 'S_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'S_DONE' THEN v_got := jsonb_build_object('error', SQLSTATE || ' ' || left(SQLERRM, 120)); END IF;
  END;
  v_res := v_res || jsonb_build_object('S6_guard_raises', v_got);

  -- S7 / C11: joining as suspended keeps the personal row and enqueues nothing.
  BEGIN
    u := pg_temp.mk_user(ARRAY['test']); b := pg_temp.mk_brokerage();
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at)
    VALUES (b, u, 'agent', 'suspended', now());
    v_got := jsonb_build_object('outbox', pg_temp.ob(u), 'personal', pg_temp.personal(u));
    RAISE EXCEPTION 'S_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'S_DONE' THEN v_got := jsonb_build_object('error', SQLSTATE || ' ' || left(SQLERRM, 120)); END IF;
  END;
  v_res := v_res || jsonb_build_object('S7_join_suspended', v_got);

  -- S7b / C11: an update of the personal row itself.
  BEGIN
    u := pg_temp.mk_user(ARRAY['test']);
    UPDATE public.organization_members m SET license_status = 'active'
      FROM public.organizations o WHERE o.id = m.organization_id AND o.personal_owner_user_id = u AND m.user_id = u;
    v_got := jsonb_build_object('outbox', pg_temp.ob(u), 'personal', pg_temp.personal(u));
    RAISE EXCEPTION 'S_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'S_DONE' THEN v_got := jsonb_build_object('error', SQLSTATE || ' ' || left(SQLERRM, 120)); END IF;
  END;
  v_res := v_res || jsonb_build_object('S7b_personal_update', v_got);

  -- S8: a customer in each mode -> one row per mode.
  BEGIN
    u := pg_temp.mk_user(ARRAY['test', 'live']); b := pg_temp.mk_brokerage();
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at)
    VALUES (b, u, 'agent', 'active', now());
    v_got := jsonb_build_object('outbox', pg_temp.ob(u),
      'modes', (SELECT string_agg(stripe_mode, ',' ORDER BY stripe_mode) FROM public.billing_outbox WHERE user_id = u AND kind = 'cancel_agent_on_brokerage_join'));
    RAISE EXCEPTION 'S_DONE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'S_DONE' THEN v_got := jsonb_build_object('error', SQLSTATE || ' ' || left(SQLERRM, 120)); END IF;
  END;
  v_res := v_res || jsonb_build_object('S8_both_modes', v_got);

  -- Catalog: no client EXECUTE on either function; DEFINER; pinned search_path.
  SELECT jsonb_build_object(
    'client_exec', (SELECT count(*) FROM (VALUES ('anon'), ('authenticated')) cr(rname), (VALUES
        ('public._billing_enqueue_agent_cancel_on_join(uuid, uuid, uuid)'), ('public._retire_personal_membership()')) f(sig)
      WHERE to_regprocedure(f.sig) IS NULL OR has_function_privilege(cr.rname, f.sig, 'EXECUTE')),
    'definer', coalesce((SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public._billing_enqueue_agent_cancel_on_join(uuid, uuid, uuid)')), false),
    'search_path', coalesce((SELECT proconfig = ARRAY['search_path=""'] FROM pg_proc WHERE oid = to_regprocedure('public._billing_enqueue_agent_cancel_on_join(uuid, uuid, uuid)')), false))
  INTO v_got;
  v_res := v_res || jsonb_build_object('C_catalog', v_got);

  FOR k, v_exp IN SELECT key, value FROM jsonb_each(v_expect) LOOP
    IF v_res -> k @> v_exp THEN v_pass := v_pass + 1; ELSE v_fail := v_fail + 1; END IF;
    v_res := jsonb_set(v_res, ARRAY[k], (v_res -> k) || jsonb_build_object('PASS', v_res -> k @> v_exp));
  END LOOP;
  RAISE EXCEPTION 'P3850_RESULT %', jsonb_build_object('mode', current_setting('p3850.mode', true), 'pass', v_pass, 'fail', v_fail, 'results', v_res);
END
$drv$;
