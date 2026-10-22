-- BACKLOG-4019 auto-renew switch: DB controls. Venue: keepr-test, ONE call, ONE transaction
-- ending in RAISE, so nothing persists. Run after 20261020220000 is applied, or compose it in
-- front (compose.py --with-migration).
-- __MODES__ is replaced with a comma list of quoted mode names. Each mode runs in its own
-- subtransaction: apply the mutation (exact-once replace that raises on 0 or 2+ matches; the md5
-- must change, else MUTATION NOT APPLIED), build fixtures, run every check, roll back.
-- 'base' = no mutation (every check must PASS).
-- Output: RAISE 'P4019_RESULT {mode: {mutation, pass, fail, reds}}'.
-- Fixtures: auth users p4019-*@example.test, organizations "P4019 *" (is_test), Stripe ids
-- sub_p4019_* (fictional; nothing calls Stripe).

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

  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE
    sw text := 'public._billing_set_auto_renew(uuid,boolean,text,uuid,text,integer)';
    hp text := 'public._org_auto_renew_caller(uuid)';
    en text := 'public._billing_end_org_deal(uuid,text,text)';
    ae text := 'public._billing_apply_org_entitlement(uuid)';
    pe text := 'public.broker_get_plan_end(uuid)';
    v_txt text; v_chk text;
  BEGIN
    CASE m
    WHEN 'base' THEN RETURN 'none';
    -- W1: the switch flips the status without a version bump (no sync row)
    WHEN 'w1_no_version_bump' THEN RETURN pg_temp.mut_fn(sw, $q$    version = version + 1,
    updated_at = now(),
    updated_by = p_actor$q$, $q$    updated_at = now(),
    updated_by = p_actor$q$);
    -- W6: resume allowed after Stripe ended the subscription
    WHEN 'w6_resume_after_end' THEN RETURN pg_temp.mut_fn(sw, $q$    -- Stripe cannot resume a canceled subscription (S5): restart is Edit deal.
    IF v_sub_status = 'canceled' THEN$q$, $q$    IF false THEN$q$);
    -- W7: staff with billing.view only pass
    WHEN 'w7_view_is_enough' THEN RETURN pg_temp.mut_fn(hp, $q$'billing.manage'$q$, $q$'billing.view'$q$);
    -- W8: canceled leaves the Team features on (today's shape)
    WHEN 'w8_no_canceled_branch' THEN RETURN pg_temp.mut_fn(ae, $q$      WHEN v_deal.status = 'canceled' AND v_key IN ('unlimited_transactions', 'broker_submission', 'broker_portal_access')
        THEN jsonb_build_object('enabled', false, 'source', v_src)
$q$, '');
    -- W9 / C-G1: review gate keeps reading suspended only
    WHEN 'w9_review_suspended_only' THEN RETURN pg_temp.mut_fn('public.can_review_submission(uuid)',
      'public.org_billing_service_off(p_org_id)', 'public.org_billing_suspended(p_org_id)');
    -- W9 / C-G2: reviewer UPDATE policy keeps reading suspended only (USING)
    WHEN 'w9_update_using_suspended_only' THEN RETURN pg_temp.mut_pol('public', 'transaction_submissions', 'transaction_submissions_update_public', 'qual',
      'org_billing_service_off', 'org_billing_suspended');
    -- W9 / C-G2: both reviewer layers (USING and WITH CHECK) keep reading suspended only
    WHEN 'w9_update_both_layers' THEN
      v_txt := pg_temp.mut_pol('public', 'transaction_submissions', 'transaction_submissions_update_public', 'qual',
        'org_billing_service_off', 'org_billing_suspended');
      SELECT with_check INTO v_chk FROM pg_policies WHERE schemaname = 'public' AND policyname = 'transaction_submissions_update_public';
      IF (length(v_chk) - length(replace(v_chk, 'org_billing_service_off', ''))) / length('org_billing_service_off') <> 2 THEN
        RAISE EXCEPTION 'MUTATION NOT APPLIED: with_check occurrences';
      END IF;
      EXECUTE format('ALTER POLICY transaction_submissions_update_public ON public.transaction_submissions WITH CHECK (%s)',
                     replace(v_chk, 'org_billing_service_off', 'org_billing_suspended'));
      IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'transaction_submissions_update_public' AND with_check LIKE '%org_billing_service_off%') THEN
        RAISE EXCEPTION 'MUTATION NOT APPLIED: with_check unchanged';
      END IF;
      RETURN v_txt || ' + MUTATION APPLIED transaction_submissions_update_public.check (2 occurrences)';
    -- W9 / C-G3: INSERT policy keeps reading suspended only
    WHEN 'w9_insert_suspended_only' THEN RETURN pg_temp.mut_pol('public', 'transaction_submissions', 'agents_can_create_submissions', 'check',
      'org_billing_service_off', 'org_billing_suspended');
    -- W9 / C-G3: finalize has no plan_ended branch
    WHEN 'w9_finalize_no_plan_ended' THEN RETURN pg_temp.mut_fn('public.finalize_submission(uuid,jsonb)',
      $q$  IF public.org_billing_service_off(v_sub.organization_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'plan_ended');
  END IF;
$q$, '');
    -- W9: the comment and storage policies keep reading suspended only
    WHEN 'w9_comment_suspended_only' THEN RETURN pg_temp.mut_pol('public', 'submission_comments', 'users_can_create_comments', 'check',
      'org_billing_service_off', 'org_billing_suspended');
    WHEN 'w9_storage_suspended_only' THEN RETURN pg_temp.mut_pol('storage', 'objects', 'Members can upload submission attachments', 'check',
      'org_billing_service_off', 'org_billing_suspended');
    -- SR 1c: org_billing_suspended widened instead (banners, unlock and checklists would follow)
    WHEN 'c1c_widen_suspended' THEN RETURN pg_temp.mut_fn('public.org_billing_suspended(uuid)',
      $q$d.status = 'suspended'$q$, $q$d.status IN ('suspended', 'canceled')$q$);
    -- Change 2: the billing contact branch dropped (the billing-only login refused)
    WHEN 'c2_no_contact_branch' THEN RETURN pg_temp.mut_fn(hp, $q$                    AND m.license_status IN ('active', 'unassigned')) THEN 'billing_contact'$q$,
      $q$                    AND false) THEN 'billing_contact'$q$);
    -- Change 2: the admin branch widened to brokers
    WHEN 'c2_admin_widened' THEN RETURN pg_temp.mut_fn(hp, $q$AND m.role = 'admin' AND m.license_status = 'active') THEN 'admin'$q$,
      $q$AND m.role IN ('admin', 'broker') AND m.license_status = 'active') THEN 'admin'$q$);
    -- Change 2: a removed contact still counts
    WHEN 'c2_removed_contact_counts' THEN RETURN pg_temp.mut_fn(hp, $q$c.role = 'billing' AND c.removed_at IS NULL$q$, $q$c.role = 'billing'$q$);
    -- W11: broker_get_plan_end copies broker_get_billing_setup's reader rule
    WHEN 'w11_reader_broker_admin_only' THEN RETURN pg_temp.mut_fn(pe, $q$  IF v_caller IS NULL AND NOT EXISTS ($q$, $q$  IF NOT EXISTS ($q$);
    -- Change 3: a brokerage caller may switch a suspended deal
    WHEN 'c3_no_suspended_refusal' THEN RETURN pg_temp.mut_fn(sw, $q$  IF v_deal.status = 'suspended' AND p_caller <> 'staff' THEN$q$, $q$  IF false THEN$q$);
    -- W12: the alert is queued for staff too
    WHEN 'w12_alert_for_staff' THEN RETURN pg_temp.mut_fn(sw, $q$  IF NOT p_on AND p_caller <> 'staff' THEN$q$, $q$  IF NOT p_on THEN$q$);
    -- W4: the end acts on a deal that is not canceling
    WHEN 'w4_end_any_deal' THEN RETURN pg_temp.mut_fn(en, $q$  IF v_eff IS DISTINCT FROM 'canceling' THEN$q$, $q$  IF false THEN$q$);
    -- W4: the end acts on a subscription that is not the stored one
    WHEN 'w4_end_any_subscription' THEN RETURN pg_temp.mut_fn(en, $q$  IF v_stored IS NULL OR v_stored IS DISTINCT FROM p_subscription_id THEN$q$, $q$  IF false THEN$q$);
    -- Grants: a service-role helper left callable by authenticated
    WHEN 'grant_end_to_authenticated' THEN
      EXECUTE 'GRANT EXECUTE ON FUNCTION public._billing_end_org_deal(uuid,text,text) TO authenticated';
      IF NOT has_function_privilege('authenticated', 'public._billing_end_org_deal(uuid,text,text)', 'EXECUTE') THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF;
      RETURN 'MUTATION APPLIED GRANT EXECUTE _billing_end_org_deal TO authenticated';
    WHEN 'grant_switch_to_authenticated' THEN
      EXECUTE 'GRANT EXECUTE ON FUNCTION public._billing_set_auto_renew(uuid,boolean,text,uuid,text,integer) TO authenticated';
      IF NOT has_function_privilege('authenticated', 'public._billing_set_auto_renew(uuid,boolean,text,uuid,text,integer)', 'EXECUTE') THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF;
      RETURN 'MUTATION APPLIED GRANT EXECUTE _billing_set_auto_renew TO authenticated';
    ELSE RAISE EXCEPTION 'unknown mode %', m;
    END CASE;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    o1 uuid := gen_random_uuid();  -- main brokerage, active deal with a subscription
    o2 uuid := gen_random_uuid();  -- another brokerage
    o3 uuid := gen_random_uuid();  -- draft deal
    o4 uuid := gen_random_uuid();  -- active deal, no subscription stored yet
    o5 uuid := gen_random_uuid();  -- for the mirror-canceled resume refusal
    u_sales uuid := gen_random_uuid(); u_exec uuid := gen_random_uuid(); u_sup uuid := gen_random_uuid();
    u_adm uuid := gen_random_uuid(); u_br uuid := gen_random_uuid(); u_it uuid := gen_random_uuid();
    u_ag uuid := gen_random_uuid(); u_bc uuid := gen_random_uuid(); u_bo uuid := gen_random_uuid();
    u_sa uuid := gen_random_uuid(); u_x uuid := gen_random_uuid();
    m_bc uuid; m_bo uuid; v_cid uuid; v_team uuid;
    s text; s2 text; n int; n2 int; v jsonb; v_ver int; s_sub uuid; s_up uuid; s_br uuid;
    q_sw text := 'SELECT public.set_org_auto_renew(%L::uuid, %s, %L, %s)';
    q_pe text := 'SELECT public.broker_get_plan_end(%L::uuid)';
    v_end timestamptz := date_trunc('second', now() + interval '20 days');
  BEGIN
    SELECT id INTO v_team FROM public.plans WHERE name = 'Team';

    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT x, 'p4019-' || left(x::text, 8) || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM unnest(ARRAY[u_sales, u_exec, u_sup, u_adm, u_br, u_it, u_ag, u_bc, u_bo, u_sa, u_x]) x;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    SELECT x, (SELECT a.email FROM auth.users a WHERE a.id = x), 'email', x::text, 'P4019 ' || left(x::text, 4)
      FROM unnest(ARRAY[u_sales, u_exec, u_sup, u_adm, u_br, u_it, u_ag, u_bc, u_bo, u_sa, u_x]) x
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.internal_roles (user_id, role_id)
    SELECT x.u, ar.id FROM (VALUES (u_sales, 'sales'), (u_exec, 'executive'), (u_sup, 'support-agent')) x(u, slug)
      JOIN public.admin_roles ar ON ar.slug = x.slug;
    INSERT INTO public.organizations (id, name, slug, max_seats, is_test)
    SELECT x, 'P4019 ' || left(x::text, 8), 'p4019-' || left(x::text, 8), 20, true FROM unnest(ARRAY[o1, o2, o3, o4, o5]) x;
    INSERT INTO public.organization_plans (organization_id, plan_id) SELECT x, v_team FROM unnest(ARRAY[o1, o2, o3, o4, o5]) x;
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, created_at) VALUES
      (o1, u_adm, 'admin', 'active', now(), now()), (o1, u_br, 'broker', 'active', now(), now()),
      (o1, u_it, 'it_admin', 'active', now(), now()), (o1, u_ag, 'agent', 'active', now(), now()),
      (o1, u_sa, 'admin', 'suspended', now(), now()),
      (o2, u_x, 'admin', 'active', now(), now()),
      (o4, u_adm, 'admin', 'active', now(), now()), (o5, u_adm, 'admin', 'active', now(), now());
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, created_at)
      VALUES (o1, u_bc, 'agent', 'active', now(), now()) RETURNING id INTO m_bc;
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, created_at, provisioning_metadata)
      VALUES (o1, u_bo, 'agent', 'unassigned', now(), now(), '{"billing_only":"true"}') RETURNING id INTO m_bo;
    INSERT INTO public.org_contacts (organization_id, role, member_id) VALUES (o1, 'billing', m_bc) RETURNING id INTO v_cid;

    INSERT INTO public.org_deals (organization_id, stripe_mode, plan_id, seats, start_date, status, version)
    SELECT x, 'test', v_team, 5, current_date, 'active', 1 FROM unnest(ARRAY[o1, o2, o4, o5]) x;
    INSERT INTO public.org_deals (organization_id, stripe_mode, plan_id, seats, start_date, status, version)
      VALUES (o3, 'test', v_team, 5, current_date, 'draft', 1);
    INSERT INTO public.org_billing_stripe (organization_id, stripe_mode, stripe_customer_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end)
    VALUES (o1, 'test', 'cus_p4019_1', 'sub_p4019_1', 'active', v_end, false),
           (o2, 'test', 'cus_p4019_2', 'sub_p4019_2', 'active', v_end, false),
           (o5, 'test', 'cus_p4019_5', 'sub_p4019_5', 'active', v_end, false);
    PERFORM public._billing_apply_org_entitlement(x) FROM unnest(ARRAY[o1, o2, o3, o4, o5]) x;
    INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, status)
      VALUES (o1, u_ag, 'p4019-sub', 'p4019 address 1', 'submitted') RETURNING id INTO s_sub;
    INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, status)
      VALUES (o1, u_ag, 'p4019-up', 'p4019 address 2', 'uploading') RETURNING id INTO s_up;
    -- a broker's own submission: the SELECT policy's own-row branch shows it to them, so only the
    -- UPDATE policy's reviewer branch decides whether they may approve it
    INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, status)
      VALUES (o1, u_br, 'p4019-br', 'p4019 address 5', 'submitted') RETURNING id INTO s_br;
    INSERT INTO public.credit_ledger (user_id, entry_type, amount) VALUES (u_ag, 'adjustment', 1);

    -- ===== who may switch it (change 2) =====
    r := r || jsonb_build_object('C2_caller_matrix', pg_temp.pass(
      pg_temp.who(u_sales, o1) = 'staff' AND pg_temp.who(u_adm, o1) = 'admin' AND pg_temp.who(u_bc, o1) = 'billing_contact'
      AND pg_temp.who(u_br, o1) = 'NULL' AND pg_temp.who(u_it, o1) = 'NULL' AND pg_temp.who(u_ag, o1) = 'NULL'
      AND pg_temp.who(u_sa, o1) = 'NULL' AND pg_temp.who(u_x, o1) = 'NULL' AND pg_temp.who(u_exec, o1) = 'NULL'
      AND pg_temp.who(u_sup, o1) = 'NULL' AND pg_temp.who(NULL, o1) = 'NULL',
      'sales=' || pg_temp.who(u_sales, o1) || ' adm=' || pg_temp.who(u_adm, o1) || ' bc=' || pg_temp.who(u_bc, o1)
      || ' br=' || pg_temp.who(u_br, o1) || ' it=' || pg_temp.who(u_it, o1) || ' ag=' || pg_temp.who(u_ag, o1)
      || ' sa=' || pg_temp.who(u_sa, o1) || ' x=' || pg_temp.who(u_x, o1) || ' exec=' || pg_temp.who(u_exec, o1)
      || ' sup=' || pg_temp.who(u_sup, o1)));
    -- the billing-only login, once it is the live contact
    UPDATE public.org_contacts SET member_id = m_bo WHERE id = v_cid;
    s := pg_temp.who(u_bo, o1); s2 := pg_temp.who(u_bc, o1);
    r := r || jsonb_build_object('C2_billing_only_login', pg_temp.pass(s = 'billing_contact' AND s2 = 'NULL', 'bo=' || s || ' old=' || s2));
    UPDATE public.org_contacts SET removed_at = now() WHERE id = v_cid;
    s := pg_temp.who(u_bo, o1);
    r := r || jsonb_build_object('C2_removed_contact_refused', pg_temp.pass(s = 'NULL', 'bo=' || s));
    UPDATE public.org_contacts SET removed_at = NULL WHERE id = v_cid;

    -- the RPC itself: cells roll back
    r := r || jsonb_build_object('C2_rpc_cells', pg_temp.pass(
      pg_temp.cell(u_sales, format(q_sw, o1, 'false', 'p4019 staff', 1)) = 'allowed'
      AND pg_temp.cell(u_adm, format(q_sw, o1, 'false', NULL, 1)) = 'allowed'
      AND pg_temp.cell(u_bo, format(q_sw, o1, 'false', NULL, 1)) = 'allowed'
      AND pg_temp.cell(u_br, format(q_sw, o1, 'false', NULL, 1)) = 'denied'
      AND pg_temp.cell(u_it, format(q_sw, o1, 'false', NULL, 1)) = 'denied'
      AND pg_temp.cell(u_ag, format(q_sw, o1, 'false', NULL, 1)) = 'denied'
      AND pg_temp.cell(u_x, format(q_sw, o1, 'false', NULL, 1)) = 'denied'
      AND pg_temp.cell(u_sa, format(q_sw, o1, 'false', NULL, 1)) = 'denied'
      AND pg_temp.cell(u_exec, format(q_sw, o1, 'false', 'n', 1)) = 'denied'
      AND pg_temp.cell(u_sup, format(q_sw, o1, 'false', 'n', 1)) = 'denied'
      AND pg_temp.cell(NULL, format(q_sw, o1, 'false', 'n', 1)) = 'denied',
      'sales=' || pg_temp.cell(u_sales, format(q_sw, o1, 'false', 'p4019 staff', 1))
      || ' adm=' || pg_temp.cell(u_adm, format(q_sw, o1, 'false', NULL, 1))
      || ' bo=' || pg_temp.cell(u_bo, format(q_sw, o1, 'false', NULL, 1))
      || ' br=' || pg_temp.cell(u_br, format(q_sw, o1, 'false', NULL, 1))
      || ' exec=' || pg_temp.cell(u_exec, format(q_sw, o1, 'false', 'n', 1))));
    r := r || jsonb_build_object('C2_staff_note_required', pg_temp.pass(
      pg_temp.cell(u_sales, format(q_sw, o1, 'false', ' ', 1)) = 'refused:note_required', pg_temp.cell(u_sales, format(q_sw, o1, 'false', ' ', 1))));
    -- grants (change 7)
    r := r || jsonb_build_object('C7_grants', pg_temp.pass(
      NOT has_function_privilege('anon', 'public.set_org_auto_renew(uuid,boolean,text,integer)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.broker_get_plan_end(uuid)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.org_billing_service_off(uuid)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.org_billing_service_off(uuid)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public._billing_end_org_deal(uuid,text,text)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public._billing_set_auto_renew(uuid,boolean,text,uuid,text,integer)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public._org_auto_renew_caller(uuid)', 'EXECUTE')
      AND has_function_privilege('service_role', 'public._billing_end_org_deal(uuid,text,text)', 'EXECUTE'), 'grants'));

    -- ===== the reader =====
    s := pg_temp.call_as(u_adm, format(q_pe, o1));
    s2 := pg_temp.call_as(u_bo, format(q_pe, o1));
    r := r || jsonb_build_object('R_reader_renewing', pg_temp.pass(
      pg_temp.j(s) ->> 'state' = 'renewing' AND pg_temp.j(s) ->> 'can_change' = 'true'
      AND pg_temp.j(s2) ->> 'can_change' = 'true'
      AND pg_temp.j(pg_temp.call_as(u_br, format(q_pe, o1))) ->> 'can_change' = 'false'
      AND pg_temp.call_as(u_ag, format(q_pe, o1)) LIKE 'ERR 42501%'
      AND pg_temp.call_as(u_x, format(q_pe, o1)) LIKE 'ERR 42501%', 'adm=' || s || ' bo=' || s2
      || ' br=' || pg_temp.call_as(u_br, format(q_pe, o1)) || ' ag=' || pg_temp.call_as(u_ag, format(q_pe, o1))));

    -- ===== refusals by state (C-DB2) =====
    r := r || jsonb_build_object('DB2_refusals', pg_temp.pass(
      pg_temp.cell(u_sales, format(q_sw, o3, 'false', 'n', 1)) = 'refused:deal_not_started'
      AND pg_temp.cell(u_adm, format(q_sw, o4, 'false', NULL, 1)) = 'refused:no_subscription'
      AND pg_temp.cell(u_adm, format(q_sw, o1, 'false', NULL, 7)) = 'refused:version_conflict',
      'draft=' || pg_temp.cell(u_sales, format(q_sw, o3, 'false', 'n', 1)) || ' nosub=' || pg_temp.cell(u_adm, format(q_sw, o4, 'false', NULL, 1))));

    -- ===== W1 + W12 (staff): turn off -> canceling, version 2, exactly one sync row; no alert =====
    n := pg_temp.outbox(o1, 'sync_org_subscription');
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o1, 'false', 'p4019 staff off', 1)));
    n2 := pg_temp.outbox(o1, 'sync_org_subscription');
    SELECT d.version INTO v_ver FROM public.org_deals d WHERE d.organization_id = o1;
    r := r || jsonb_build_object('W1_off_one_sync_row', pg_temp.pass(
      v ->> 'success' = 'true' AND (SELECT status FROM public.org_deals WHERE organization_id = o1) = 'canceling'
      AND v_ver = 2 AND n2 = n + 1
      AND EXISTS (SELECT 1 FROM public.billing_outbox b WHERE b.organization_id = o1 AND b.kind = 'sync_org_subscription'
                   AND b.dedupe_key LIKE '%:v2'),
      'res=' || v::text || ' v=' || v_ver || ' rows ' || n || '->' || n2));
    r := r || jsonb_build_object('W12_no_alert_for_staff', pg_temp.pass(pg_temp.am_rows(o1) = 0, 'rows=' || pg_temp.am_rows(o1)));
    r := r || jsonb_build_object('D5_audit_staff', pg_temp.pass(
      EXISTS (SELECT 1 FROM public.billing_change_log l WHERE l.organization_id = o1 AND l.action = 'auto_renew_off'
               AND l.actor_id = u_sales AND l.detail ->> 'note' = 'p4019 staff off' AND (l.detail ->> 'ends_on') IS NOT NULL)
      AND EXISTS (SELECT 1 FROM public.admin_audit_logs a WHERE a.actor_id = u_sales AND a.action = 'billing.auto_renew_off'
               AND a.target_id = o1::text), 'log'));
    -- the reader while ending
    s := pg_temp.call_as(u_adm, format(q_pe, o1));
    r := r || jsonb_build_object('R_reader_ending', pg_temp.pass(
      pg_temp.j(s) ->> 'state' = 'ending' AND (pg_temp.j(s) ->> 'ends_on')::timestamptz = v_end, s));
    -- turning it off again is a no-op success (no new version)
    v := pg_temp.j(pg_temp.call_as(u_adm, format(q_sw, o1, 'false', NULL, 2)));
    r := r || jsonb_build_object('D4_off_again_noop', pg_temp.pass(
      v ->> 'success' = 'true' AND v ->> 'changed' = 'false'
      AND (SELECT version FROM public.org_deals WHERE organization_id = o1) = 2 AND pg_temp.am_rows(o1) = 0, v::text));
    -- back on (admin) -> active, version 3; then off by the admin -> exactly one alert row
    v := pg_temp.j(pg_temp.call_as(u_adm, format(q_sw, o1, 'true', NULL, 2)));
    r := r || jsonb_build_object('D4_on_by_admin', pg_temp.pass(
      v ->> 'success' = 'true' AND (SELECT status FROM public.org_deals WHERE organization_id = o1) = 'active'
      AND (SELECT version FROM public.org_deals WHERE organization_id = o1) = 3, v::text));
    v := pg_temp.j(pg_temp.call_as(u_adm, format(q_sw, o1, 'false', NULL, 3)));
    r := r || jsonb_build_object('W12_alert_for_admin', pg_temp.pass(
      v ->> 'success' = 'true' AND pg_temp.am_rows(o1) = 1
      AND EXISTS (SELECT 1 FROM public.billing_outbox b WHERE b.organization_id = o1 AND b.kind = 'notify_account_manager'
                   AND b.dedupe_key LIKE '%:auto_renew_off:v4' AND b.payload ->> 'detail' LIKE 'Turned off by p4019-% (Admin). The plan ends on ___ %, 20__.'),
      v::text || ' rows=' || pg_temp.am_rows(o1) || ' detail=' || coalesce((SELECT b.payload ->> 'detail' FROM public.billing_outbox b WHERE b.organization_id = o1 AND b.kind = 'notify_account_manager' LIMIT 1), 'none')));
    -- the same version's alert key is not queued twice
    INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
    VALUES ('test', 'notify_account_manager', o1, 'notify_account_manager:test:' || o1::text || ':auto_renew_off:v4', '{"reason":"auto_renew_off"}')
    ON CONFLICT (dedupe_key) DO NOTHING;
    r := r || jsonb_build_object('W12_dedupe', pg_temp.pass(pg_temp.am_rows(o1) = 1, 'rows=' || pg_temp.am_rows(o1)));

    -- ===== C-DB3 / C-DB6: suspended while canceling =====
    v := public._billing_suspend_org(o1, 'other', 'p4019', u_sales);
    r := r || jsonb_build_object('DB3_suspend_keeps_canceling', pg_temp.pass(
      (SELECT status || '/' || status_before_suspension FROM public.org_deals WHERE organization_id = o1) = 'suspended/canceling', v::text));
    s := pg_temp.cell(u_adm, format(q_sw, o1, 'true', NULL, 4));
    s2 := pg_temp.cell(u_bo, format(q_sw, o1, 'true', NULL, 4));
    r := r || jsonb_build_object('DB6_brokerage_refused_while_suspended', pg_temp.pass(
      s = 'refused:deal_suspended' AND s2 = 'refused:deal_suspended', 'adm=' || s || ' bo=' || s2));
    n := pg_temp.outbox(o1, 'sync_org_subscription');
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o1, 'true', 'p4019 staff on while suspended', 4)));
    r := r || jsonb_build_object('DB6_staff_allowed_while_suspended', pg_temp.pass(
      v ->> 'success' = 'true'
      AND (SELECT status || '/' || status_before_suspension FROM public.org_deals WHERE organization_id = o1) = 'suspended/active'
      AND (SELECT version FROM public.org_deals WHERE organization_id = o1) = 5
      AND pg_temp.outbox(o1, 'sync_org_subscription') = n + 1, v::text));
    v := pg_temp.j(pg_temp.call_as(u_sales, format(q_sw, o1, 'false', 'p4019 staff off while suspended', 5)));
    v := public._billing_reinstate_org(o1, 'p4019', u_sales);
    r := r || jsonb_build_object('DB3_reinstate_to_canceling', pg_temp.pass(
      (SELECT status FROM public.org_deals WHERE organization_id = o1) = 'canceling', v::text));

    -- ===== W4: the end =====
    v := public._billing_end_org_deal(o2, 'test', 'sub_p4019_2');
    r := r || jsonb_build_object('W4_end_active_untouched', pg_temp.pass(
      v ->> 'outcome' = 'not_canceling' AND (SELECT status FROM public.org_deals WHERE organization_id = o2) = 'active', v::text));
    v := public._billing_end_org_deal(o1, 'test', 'sub_p4019_other');
    r := r || jsonb_build_object('W4_end_other_sub_untouched', pg_temp.pass(
      v ->> 'outcome' = 'not_stored' AND (SELECT status FROM public.org_deals WHERE organization_id = o1) = 'canceling', v::text));
    -- before the end: the gates are open (the later refusals are not vacuous)
    r := r || jsonb_build_object('G0_open_while_canceling', pg_temp.pass(
      pg_temp.val_as(u_br, format('SELECT public.can_review_submission(%L::uuid)::text', o1)) = 'true'
      AND pg_temp.try_rows(u_br, format($q$UPDATE public.transaction_submissions SET status = 'approved' WHERE id = %L$q$, s_br)) = 'ok:1',
      'review=' || pg_temp.val_as(u_br, format('SELECT public.can_review_submission(%L::uuid)::text', o1))
      || ' own=' || pg_temp.try_rows(u_br, format($q$UPDATE public.transaction_submissions SET status = 'approved' WHERE id = %L$q$, s_br))));
    SELECT version INTO v_ver FROM public.org_deals WHERE organization_id = o1;
    v := public._billing_end_org_deal(o1, 'test', 'sub_p4019_1');
    r := r || jsonb_build_object('W4_end_canceling', pg_temp.pass(
      v ->> 'outcome' = 'ended'
      AND (SELECT status FROM public.org_deals WHERE organization_id = o1) = 'canceled'
      AND (SELECT version FROM public.org_deals WHERE organization_id = o1) = v_ver + 1
      AND EXISTS (SELECT 1 FROM public.billing_change_log l WHERE l.organization_id = o1 AND l.action = 'deal_ended' AND l.actor_id IS NULL),
      v::text));
    v := public._billing_end_org_deal(o1, 'test', 'sub_p4019_1');
    r := r || jsonb_build_object('W4_end_twice_noop', pg_temp.pass(v ->> 'outcome' = 'already_canceled', v::text));

    -- ===== W8 / C-E1: entitlement of a canceled deal =====
    r := r || jsonb_build_object('W8_canceled_features_off', pg_temp.pass(
      pg_temp.fo(o1, 'unlimited_transactions') = 'false' AND pg_temp.fo(o1, 'broker_submission') = 'false'
      AND pg_temp.fo(o1, 'broker_portal_access') = 'false' AND pg_temp.fo(o1, 'account_suspended') = 'absent'
      AND NOT public.org_billing_suspended(o1),
      'u=' || pg_temp.fo(o1, 'unlimited_transactions') || ' s=' || pg_temp.fo(o1, 'broker_submission')
      || ' p=' || pg_temp.fo(o1, 'broker_portal_access') || ' a=' || pg_temp.fo(o1, 'account_suspended')));

    -- ===== W9: the service ends in the database =====
    r := r || jsonb_build_object('G1_review_refused', pg_temp.pass(
      pg_temp.val_as(u_br, format('SELECT public.can_review_submission(%L::uuid)::text', o1)) = 'false',
      pg_temp.val_as(u_br, format('SELECT public.can_review_submission(%L::uuid)::text', o1))));
    s := pg_temp.exec_as(u_br, format($q$UPDATE public.transaction_submissions SET status = 'approved' WHERE id = %L$q$, s_sub));
    r := r || jsonb_build_object('G2_reviewer_update_refused', pg_temp.pass(s IN ('ok:0', 'ERR 42501'), s));
    -- the broker's own submission: USING hides it from the reviewer branch (0 rows); a broken
    -- USING with the WITH CHECK still in place reads 42501; both broken -> approved (1 row).
    s := pg_temp.exec_as(u_br, format($q$UPDATE public.transaction_submissions SET status = 'approved' WHERE id = %L$q$, s_br));
    r := r || jsonb_build_object('G2_reviewer_update_own_refused', pg_temp.pass(s = 'ok:0', s));
    s := pg_temp.exec_as(u_ag, format($q$INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, status) VALUES (%L, %L, 'p4019-new', 'p4019 address 3', 'submitted')$q$, o1, u_ag));
    r := r || jsonb_build_object('G3_agent_insert_refused', pg_temp.pass(s = 'ERR 42501', s));
    s := pg_temp.call_as(u_ag, format($q$SELECT public.finalize_submission(%L::uuid, '{}'::jsonb)$q$, s_up));
    r := r || jsonb_build_object('G3_finalize_plan_ended', pg_temp.pass(pg_temp.j(s) ->> 'code' = 'plan_ended', s));
    s := pg_temp.exec_as(u_ag, format($q$INSERT INTO public.submission_comments (submission_id, user_id, content) VALUES (%L, %L, 'p4019')$q$, s_sub, u_ag));
    r := r || jsonb_build_object('G3_comment_refused', pg_temp.pass(s = 'ERR 42501', s));
    s := pg_temp.exec_as(u_ag, format($q$INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('submission-attachments', %L, %L)$q$,
                                       o1::text || '/' || s_up::text || '/p4019.txt', u_ag));
    r := r || jsonb_build_object('G3_storage_refused', pg_temp.pass(s = 'ERR 42501', s));
    -- G4: the agent keeps read-only sight of their own; the broker loses sight of the org's
    s := pg_temp.val_as(u_ag, format('SELECT count(*)::text FROM public.transaction_submissions WHERE id = %L', s_sub));
    s2 := pg_temp.val_as(u_br, format('SELECT count(*)::text FROM public.transaction_submissions WHERE id = %L', s_sub));
    r := r || jsonb_build_object('G4_sight', pg_temp.pass(s = '1' AND s2 = '0', 'agent=' || s || ' broker=' || s2));
    -- G5: a credit unlock is still allowed; nothing reads as suspended
    s := pg_temp.call_as(u_ag, $q$SELECT public.unlock_transaction('p4019-unlock')$q$);
    r := r || jsonb_build_object('G5_unlock_allowed', pg_temp.pass(
      pg_temp.j(s) ->> 'unlocked' = 'true' AND NOT public.org_billing_suspended(o1), s));
    -- the reader after the end
    s := pg_temp.call_as(u_adm, format(q_pe, o1));
    r := r || jsonb_build_object('R_reader_ended', pg_temp.pass(
      pg_temp.j(s) ->> 'state' = 'ended' AND pg_temp.j(s) ->> 'can_change' = 'false', s));
    r := r || jsonb_build_object('DB2_canceled_refused', pg_temp.pass(
      pg_temp.cell(u_sales, format(q_sw, o1, 'true', 'n', v_ver + 1)) = 'refused:deal_canceled',
      pg_temp.cell(u_sales, format(q_sw, o1, 'true', 'n', v_ver + 1))));

    -- ===== C-E4: Edit deal restarts; every gate opens again =====
    v := public._billing_save_deal(o1, '{"stripe_mode":"test","seats":5}'::jsonb, u_sales, 'p4019 restart', v_ver + 1);
    r := r || jsonb_build_object('E4_restart_opens', pg_temp.pass(
      v ->> 'success' = 'true' AND (SELECT status FROM public.org_deals WHERE organization_id = o1) = 'active'
      AND pg_temp.fo(o1, 'unlimited_transactions') = 'true' AND pg_temp.fo(o1, 'broker_submission') = 'absent'
      AND pg_temp.fo(o1, 'broker_portal_access') = 'absent'
      AND pg_temp.val_as(u_br, format('SELECT public.can_review_submission(%L::uuid)::text', o1)) = 'true'
      AND pg_temp.exec_as(u_ag, format($q$INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, status) VALUES (%L, %L, 'p4019-new2', 'p4019 address 4', 'uploading')$q$, o1, u_ag)) = 'ok:1'
      AND pg_temp.exec_as(u_br, format($q$UPDATE public.transaction_submissions SET status = 'under_review' WHERE id = %L$q$, s_sub)) = 'ok:1',
      v::text || ' u=' || pg_temp.fo(o1, 'unlimited_transactions')));

    -- ===== W6 / C-DB4: resume refused once Stripe says canceled =====
    v := pg_temp.j(pg_temp.call_as(u_adm, format(q_sw, o5, 'false', NULL, 1)));
    UPDATE public.org_billing_stripe SET status = 'canceled' WHERE organization_id = o5;
    s := pg_temp.cell(u_adm, format(q_sw, o5, 'true', NULL, 2));
    r := r || jsonb_build_object('W6_resume_after_end_refused', pg_temp.pass(
      v ->> 'success' = 'true' AND s = 'refused:already_ended'
      AND (SELECT version FROM public.org_deals WHERE organization_id = o5) = 2, 'off=' || v::text || ' on=' || s));

    -- ===== SR 1c: org_billing_suspended is not widened (checked on a canceled org) =====
    PERFORM public._billing_end_org_deal(o5, 'test', 'sub_p4019_5');
    r := r || jsonb_build_object('C1c_suspended_not_widened', pg_temp.pass(
      (SELECT status FROM public.org_deals WHERE organization_id = o5) = 'canceled' AND NOT public.org_billing_suspended(o5),
      (SELECT status FROM public.org_deals WHERE organization_id = o5)));

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
  RAISE EXCEPTION 'P4019_RESULT %', v_res;
END
$drv$;
