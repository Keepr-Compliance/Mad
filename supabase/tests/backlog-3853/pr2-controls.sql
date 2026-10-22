-- BACKLOG-3853 PR-2 DB controls (enqueue trigger, sync lease, mirror writer, paid evidence,
-- auto-reinstate, plan-feature refusal, grants).
-- Venue: keepr-test, ONE call, ONE transaction that ends in RAISE, so nothing persists.
-- Run after 20261019090000 is applied, or compose it in front (compose_pr2.py --with-migration).
-- compose_pr2.py fills the mode list and the three prior-body placeholders (PR1_APPLY, PR1_AUTO,
-- PF_BEFORE) with the prior function bodies taken from rollback-3853-pr2.sql (the "today's
-- code" mutants). Each mode runs in its own subtransaction: apply the mutation (exact-once
-- replace that raises on 0 or 2+ matches, or a prior body; the md5 must change), build the
-- fixtures, run every check, roll back.
-- Output: RAISE 'P3853P2_RESULT {mode: {mutation, pass, fail, reds}}'.
-- Fixtures: new auth user p3853p2c-*@example.test, new organizations P3853P2C *.

DO $drv$
DECLARE
  v_modes text[] := ARRAY[__MODES__]::text[];
  v_m text;
  v_mut text;
  v_res jsonb := '{}'::jsonb;
  v_r jsonb;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.call_as(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE v jsonb;
  BEGIN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', u::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      EXECUTE q INTO v;
      EXECUTE 'RESET ROLE';
      RETURN coalesce(v::text, 'null');
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
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
    IF m1 = m2 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: md5 unchanged for %', p_sig; END IF;
    RETURN 'MUTATION APPLIED ' || p_sig || ' ' || left(m1, 8) || '->' || left(m2, 8);
  END $b$$f$;

  -- replace a whole body with a prior one (today's code as the mutant)
  EXECUTE $f$CREATE FUNCTION pg_temp.mut_body(p_sig text, p_create text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE m1 text; m2 text;
  BEGIN
    m1 := md5(pg_get_functiondef(to_regprocedure(p_sig)));
    EXECUTE p_create;
    m2 := md5(pg_get_functiondef(to_regprocedure(p_sig)));
    IF m1 = m2 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: md5 unchanged for %', p_sig; END IF;
    RETURN 'MUTATION APPLIED ' || p_sig || ' ' || left(m1, 8) || '->' || left(m2, 8) || ' (prior body)';
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE
    s_trg text := 'public._billing_enqueue_org_work()';
    s_app text := 'public._billing_apply_org_subscription(uuid,text,jsonb,bigint)';
    s_aut text := 'public._billing_auto_reinstate(uuid,text)';
    s_lea text := 'public._billing_org_sync_lease(uuid,text,uuid,integer)';
    s_pai text := 'public._billing_record_invoice_paid(uuid,text,bigint)';
    s_pf  text := 'public.admin_update_plan_feature(uuid,uuid,boolean,text)';
  BEGIN
    CASE m
    WHEN 'base' THEN RETURN 'none';
    -- enqueue trigger
    WHEN 'enqueue_insert_only' THEN RETURN pg_temp.mut_fn(s_trg,
      $q$(TG_OP = 'INSERT' OR OLD.version IS DISTINCT FROM NEW.version)$q$, $q$(TG_OP = 'INSERT')$q$);
    WHEN 'enqueue_any_update' THEN RETURN pg_temp.mut_fn(s_trg,
      $q$(TG_OP = 'INSERT' OR OLD.version IS DISTINCT FROM NEW.version)$q$, '(true)');
    WHEN 'enqueue_any_status' THEN RETURN pg_temp.mut_fn(s_trg,
      $q$AND NEW.status IN ('active', 'canceling', 'suspended') THEN$q$, 'THEN');
    WHEN 'no_notify' THEN RETURN pg_temp.mut_fn(s_trg,
      $q$IF NEW.status = 'suspended'$q$, 'IF false');
    -- mirror writer
    WHEN 'pr1_apply' THEN RETURN pg_temp.mut_body(s_app, $pr1a$__PR1_APPLY__$pr1a$);
    WHEN 'cancel_unconditional' THEN RETURN pg_temp.mut_fn(s_app,
      $q$CASE WHEN p_fields ? 'cancel_at_period_end'
                                THEN EXCLUDED.cancel_at_period_end ELSE s.cancel_at_period_end END$q$,
      'EXCLUDED.cancel_at_period_end');
    WHEN 'sr_apply_strict_gt' THEN RETURN pg_temp.mut_fn(s_app,
      'EXCLUDED.last_event_created >= s.last_event_created', 'EXCLUDED.last_event_created > s.last_event_created');
    WHEN 'null_branch_no_coalesce' THEN RETURN pg_temp.mut_fn(s_app,
      $q$      stripe_customer_id = coalesce(EXCLUDED.stripe_customer_id, s.stripe_customer_id),
      stripe_subscription_id = coalesce(EXCLUDED.stripe_subscription_id, s.stripe_subscription_id),
      updated_at = now();$q$,
      $q$      stripe_customer_id = EXCLUDED.stripe_customer_id,
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      updated_at = now();$q$);
    -- payment evidence + auto-reinstate
    WHEN 'pr1_auto' THEN RETURN pg_temp.mut_body(s_aut, $pr1b$__PR1_AUTO__$pr1b$);
    WHEN 'paid_boundary_lt' THEN RETURN pg_temp.mut_fn(s_aut,
      'v_paid <= floor(extract(epoch FROM v_suspended_at))', 'v_paid < floor(extract(epoch FROM v_suspended_at))');
    WHEN 'auto_no_reason_check' THEN RETURN pg_temp.mut_fn(s_aut,
      $q$IF v_reason IS DISTINCT FROM 'non_payment' THEN$q$, 'IF false THEN');
    WHEN 'auto_no_status_check' THEN RETURN pg_temp.mut_fn(s_aut,
      $q$IF v_status IS DISTINCT FROM 'active' THEN$q$, 'IF false THEN');
    WHEN 'paid_no_greatest' THEN RETURN pg_temp.mut_fn(s_pai,
      'GREATEST(s.last_invoice_paid_event_created, EXCLUDED.last_invoice_paid_event_created)',
      'EXCLUDED.last_invoice_paid_event_created');
    -- lease
    WHEN 'lease_no_guard' THEN RETURN pg_temp.mut_fn(s_lea,
      E'\n  WHERE s.sync_lease_until IS NULL OR s.sync_lease_until < now() OR s.sync_lease_holder = EXCLUDED.sync_lease_holder', '');
    WHEN 'lease_short_ok' THEN RETURN pg_temp.mut_fn(s_lea, 'p_seconds < 90', 'p_seconds < 1');
    -- plan feature
    WHEN 'pf_before' THEN RETURN pg_temp.mut_body(s_pf, $pfb$__PF_BEFORE__$pfb$);
    WHEN 'pf_enable_only' THEN RETURN pg_temp.mut_fn(s_pf,
      $q$IF v_feature.key = 'account_suspended' THEN$q$, $q$IF v_feature.key = 'account_suspended' AND p_enabled THEN$q$);
    ELSE RAISE EXCEPTION 'unknown mode %', m;
    END CASE;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    u_super uuid := gen_random_uuid();
    o_e uuid := gen_random_uuid();   -- enqueue: save, seats, suspend, reinstate, cancel
    o_m uuid := gen_random_uuid();   -- mirror writer
    o_s uuid := gen_random_uuid();   -- auto-reinstate non_payment
    o_o uuid := gen_random_uuid();   -- auto-reinstate 'other'
    o_l uuid := gen_random_uuid();   -- lease
    v_team uuid; v_feat uuid; v_other uuid;
    n int; n2 int; s text; b boolean; v_res jsonb; v_cur bigint; v_ep bigint;
    h_a uuid := gen_random_uuid();
    h_b uuid := gen_random_uuid();
    h_c uuid := gen_random_uuid();
  BEGIN
    SELECT id INTO v_team FROM public.plans WHERE name = 'Team';
    SELECT id INTO v_feat FROM public.feature_definitions WHERE key = 'account_suspended';
    SELECT fd.id INTO v_other FROM public.feature_definitions fd
     WHERE fd.key <> 'account_suspended'
       AND NOT EXISTS (SELECT 1 FROM public.feature_dependencies d WHERE d.depends_on_key = fd.key)
     ORDER BY fd.key LIMIT 1;
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (u_super, 'p3853p2c-super@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now());
    INSERT INTO public.users (id, email, oauth_provider, oauth_id) VALUES (u_super, 'p3853p2c-super@example.test', 'email', u_super::text) ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.internal_roles (user_id, role_id) SELECT u_super, id FROM public.admin_roles WHERE slug = 'super-admin';
    INSERT INTO public.organizations (id, name, slug, max_seats, is_test)
    SELECT x, 'P3853P2C ' || left(x::text, 8), 'p3853p2c-' || left(x::text, 8), 10, true FROM unnest(ARRAY[o_e, o_m, o_s, o_o, o_l]) x;
    INSERT INTO public.organization_plans (organization_id, plan_id) SELECT x, v_team FROM unnest(ARRAY[o_e, o_m, o_s, o_o, o_l]) x;

    -- ===== C-E1: saving a deal enqueues one sync row (organization subject, no user) =====
    PERFORM public._billing_save_deal(o_e, jsonb_build_object('stripe_mode','test','seats',5,'billing_contact_email','e@example.test'), u_super, 'ctl', NULL);
    SELECT count(*) INTO n FROM public.billing_outbox WHERE organization_id = o_e AND kind = 'sync_org_subscription'
       AND user_id IS NULL AND stripe_mode = 'test' AND (payload ->> 'deal_version')::int = 1
       AND dedupe_key = 'sync_org_subscription:test:' || o_e::text || ':v1';
    r := r || jsonb_build_object('C-E1 save deal -> 1 sync row v1', n = 1);

    -- ===== C-E2: a seat change (another writer) enqueues the next version =====
    PERFORM public._billing_change_seats(o_e, 7, u_super);
    SELECT count(*) INTO n FROM public.billing_outbox WHERE organization_id = o_e AND kind = 'sync_org_subscription';
    r := r || jsonb_build_object('C-E2 seat change -> 2 sync rows', n = 2);

    -- ===== C-E3: suspend -> 1 notify row with its epoch; no sync row (version unchanged) =====
    PERFORM public._billing_suspend_org(o_e, 'non_payment', 'ctl', u_super);
    SELECT count(*), max((payload ->> 'suspended_at_epoch')::bigint) INTO n, v_ep FROM public.billing_outbox
     WHERE organization_id = o_e AND kind = 'notify_org_suspended';
    r := r || jsonb_build_object('C-E3 suspend -> 1 notify row', n = 1);
    r := r || jsonb_build_object('C-E3b notify payload carries suspended_at epoch',
      v_ep = (SELECT floor(extract(epoch FROM suspended_at))::bigint FROM public.org_deals WHERE organization_id = o_e));
    SELECT count(*) INTO n FROM public.billing_outbox WHERE organization_id = o_e AND kind = 'sync_org_subscription';
    r := r || jsonb_build_object('C-E4 status-only update adds no sync row', n = 2);

    -- reinstate adds nothing (B4: no reinstated email)
    PERFORM public._billing_reinstate_org(o_e, 'ctl', u_super);
    SELECT count(*) INTO n FROM public.billing_outbox WHERE organization_id = o_e;
    r := r || jsonb_build_object('C-E5 reinstate adds no row', n = 3);

    -- a version change on a canceled deal enqueues nothing
    UPDATE public.org_deals SET status = 'canceled', version = version + 1 WHERE organization_id = o_e;
    SELECT count(*) INTO n FROM public.billing_outbox WHERE organization_id = o_e AND kind = 'sync_org_subscription';
    r := r || jsonb_build_object('C-E6 canceled deal version change -> no sync row', n = 2);

    -- ===== C-9: mirror writer =====
    PERFORM public._billing_save_deal(o_m, jsonb_build_object('stripe_mode','test','seats',5), u_super, 'ctl', NULL);
    -- C-9n: a NULL-cursor write keeps the cursor; an older event is then refused
    PERFORM public._billing_apply_org_subscription(o_m, 'test', '{"status":"past_due","stripe_customer_id":"cus_p3853p2c_m"}'::jsonb, 100);
    PERFORM public._billing_apply_org_subscription(o_m, 'test', '{"status":"active"}'::jsonb, NULL);
    SELECT last_event_created, status INTO v_cur, s FROM public.org_billing_stripe WHERE organization_id = o_m AND stripe_mode = 'test';
    r := r || jsonb_build_object('C-9n cursor kept after NULL write', v_cur IS NOT DISTINCT FROM 100::bigint);
    -- C-9s: the NULL write did not change status
    r := r || jsonb_build_object('C-9s NULL write leaves status past_due', s IS NOT DISTINCT FROM 'past_due');
    v_res := public._billing_apply_org_subscription(o_m, 'test', '{"status":"canceled"}'::jsonb, 50);
    SELECT status INTO s FROM public.org_billing_stripe WHERE organization_id = o_m AND stripe_mode = 'test';
    r := r || jsonb_build_object('C-9n older event refused', (v_res ->> 'applied') = 'false' AND s = 'past_due');
    v_res := public._billing_apply_org_subscription(o_m, 'test', '{"status":"active","cancel_at_period_end":true}'::jsonb, 150);
    SELECT status, cancel_at_period_end, last_event_created INTO s, b, v_cur FROM public.org_billing_stripe WHERE organization_id = o_m AND stripe_mode = 'test';
    r := r || jsonb_build_object('C-9n newer event applied', s = 'active' AND b AND v_cur = 150);
    -- C-9c: an ids-only NULL write keeps cancel_at_period_end
    PERFORM public._billing_apply_org_subscription(o_m, 'test', '{"stripe_subscription_id":"sub_p3853p2c_m"}'::jsonb, NULL);
    SELECT cancel_at_period_end INTO b FROM public.org_billing_stripe WHERE organization_id = o_m AND stripe_mode = 'test';
    r := r || jsonb_build_object('C-9c ids-only NULL write keeps cancel flag', b IS TRUE);
    r := r || jsonb_build_object('C-9i NULL writes keep both ids',
      (SELECT stripe_customer_id = 'cus_p3853p2c_m' AND stripe_subscription_id = 'sub_p3853p2c_m'
         FROM public.org_billing_stripe WHERE organization_id = o_m AND stripe_mode = 'test'));
    -- C-9c2: an event that does not carry the flag keeps it; one that carries false clears it
    PERFORM public._billing_apply_org_subscription(o_m, 'test', '{"status":"active"}'::jsonb, 160);
    SELECT cancel_at_period_end INTO b FROM public.org_billing_stripe WHERE organization_id = o_m AND stripe_mode = 'test';
    r := r || jsonb_build_object('C-9c2 event without the flag keeps it', b IS TRUE);
    PERFORM public._billing_apply_org_subscription(o_m, 'test', '{"cancel_at_period_end":false}'::jsonb, 170);
    SELECT cancel_at_period_end INTO b FROM public.org_billing_stripe WHERE organization_id = o_m AND stripe_mode = 'test';
    r := r || jsonb_build_object('C-9c3 event with false clears it', b IS FALSE);
    -- C-9s2 (SR S3): past_due at 200 then a NULL {status:active} -> still past_due
    PERFORM public._billing_apply_org_subscription(o_m, 'test', '{"status":"past_due"}'::jsonb, 200);
    PERFORM public._billing_apply_org_subscription(o_m, 'test', '{"status":"active"}'::jsonb, NULL);
    SELECT status INTO s FROM public.org_billing_stripe WHERE organization_id = o_m AND stripe_mode = 'test';
    r := r || jsonb_build_object('C-9s2 past_due survives NULL status write', s = 'past_due');
    -- SR-EQ: a second event stamped with the same second (cursor 200) is applied, not dropped
    PERFORM public._billing_apply_org_subscription(o_m, 'test', '{"status":"active"}'::jsonb, 200);
    SELECT status INTO s FROM public.org_billing_stripe WHERE organization_id = o_m AND stripe_mode = 'test';
    r := r || jsonb_build_object('SR-EQ same-second event applied', s = 'active');

    -- ===== C-12e: non_payment suspension lifts only with a payment after it =====
    PERFORM public._billing_save_deal(o_s, jsonb_build_object('stripe_mode','test','seats',5), u_super, 'ctl', NULL);
    PERFORM public._billing_apply_org_subscription(o_s, 'test', '{"stripe_customer_id":"cus_p3853p2c_s","status":"active"}'::jsonb, 100);
    PERFORM public._billing_suspend_org(o_s, 'non_payment', 'ctl', u_super);
    SELECT floor(extract(epoch FROM suspended_at))::bigint INTO v_ep FROM public.org_deals WHERE organization_id = o_s;
    v_res := public._billing_auto_reinstate(o_s, 'test');
    r := r || jsonb_build_object('C-12e no payment -> refused', (v_res ->> 'success') = 'false');
    PERFORM public._billing_record_invoice_paid(o_s, 'test', v_ep - 100);
    v_res := public._billing_auto_reinstate(o_s, 'test');
    r := r || jsonb_build_object('C-12e payment before suspension -> refused', (v_res ->> 'success') = 'false');
    PERFORM public._billing_record_invoice_paid(o_s, 'test', v_ep);
    v_res := public._billing_auto_reinstate(o_s, 'test');
    r := r || jsonb_build_object('C-12e payment in the suspension second -> refused (boundary)', (v_res ->> 'success') = 'false');
    -- C-R4: mirror past_due, payment recorded after -> still refused
    PERFORM public._billing_apply_org_subscription(o_s, 'test', '{"status":"past_due"}'::jsonb, 200);
    PERFORM public._billing_record_invoice_paid(o_s, 'test', v_ep + 5);
    v_res := public._billing_auto_reinstate(o_s, 'test');
    r := r || jsonb_build_object('C-R4 paid but mirror past_due -> refused', (v_res ->> 'error') = 'subscription_not_active');
    -- C-RP: an older paid event never lowers the recorded value
    PERFORM public._billing_record_invoice_paid(o_s, 'test', v_ep - 500);
    SELECT last_invoice_paid_event_created INTO v_cur FROM public.org_billing_stripe WHERE organization_id = o_s AND stripe_mode = 'test';
    r := r || jsonb_build_object('C-RP paid evidence never moves back', v_cur = v_ep + 5);
    PERFORM public._billing_apply_org_subscription(o_s, 'test', '{"status":"active"}'::jsonb, 201);
    v_res := public._billing_auto_reinstate(o_s, 'test');
    SELECT status INTO s FROM public.org_deals WHERE organization_id = o_s;
    r := r || jsonb_build_object('C-12e paid after suspension + active -> reinstated', (v_res ->> 'success') = 'true' AND s = 'active');

    -- ===== C-12c: an 'other' suspension never lifts on payment =====
    PERFORM public._billing_save_deal(o_o, jsonb_build_object('stripe_mode','test','seats',5), u_super, 'ctl', NULL);
    PERFORM public._billing_apply_org_subscription(o_o, 'test', '{"stripe_customer_id":"cus_p3853p2c_o","status":"active"}'::jsonb, 100);
    PERFORM public._billing_suspend_org(o_o, 'other', 'ctl', u_super);
    PERFORM public._billing_record_invoice_paid(o_o, 'test', floor(extract(epoch FROM now()))::bigint + 10);
    v_res := public._billing_auto_reinstate(o_o, 'test');
    SELECT status INTO s FROM public.org_deals WHERE organization_id = o_o;
    r := r || jsonb_build_object('C-12c other suspension stays', (v_res ->> 'success') = 'false' AND s = 'suspended');

    -- ===== C-L1: per-organization lease =====
    PERFORM public._billing_save_deal(o_l, jsonb_build_object('stripe_mode','test','seats',5), u_super, 'ctl', NULL);
    r := r || jsonb_build_object('C-L1 A takes a free lease', public._billing_org_sync_lease(o_l, 'test', h_a, 120));
    r := r || jsonb_build_object('C-L1 B refused while A holds', NOT public._billing_org_sync_lease(o_l, 'test', h_b, 120));
    r := r || jsonb_build_object('C-L1 A renews', public._billing_org_sync_lease(o_l, 'test', h_a, 120));
    r := r || jsonb_build_object('C-L1 B cannot release A', NOT public._billing_org_sync_release(o_l, 'test', h_b));
    r := r || jsonb_build_object('C-L1 A releases', public._billing_org_sync_release(o_l, 'test', h_a));
    r := r || jsonb_build_object('C-L1 B takes it after release', public._billing_org_sync_lease(o_l, 'test', h_b, 120));
    UPDATE public.org_billing_stripe SET sync_lease_until = now() - interval '1 second' WHERE organization_id = o_l AND stripe_mode = 'test';
    r := r || jsonb_build_object('C-L1 C takes an expired lease', public._billing_org_sync_lease(o_l, 'test', h_c, 120));
    BEGIN
      PERFORM public._billing_org_sync_lease(o_l, 'test', h_c, 89);
      r := r || jsonb_build_object('C-L2 lease under 90 s refused', false);
    EXCEPTION WHEN raise_exception THEN
      r := r || jsonb_build_object('C-L2 lease under 90 s refused', true);
    END;
    -- the lease row does not disturb the mirror fields
    SELECT status, last_event_created INTO s, v_cur FROM public.org_billing_stripe WHERE organization_id = o_l AND stripe_mode = 'test';
    r := r || jsonb_build_object('C-L3 lease row leaves status and cursor NULL', s IS NULL AND v_cur IS NULL);

    -- ===== C-P: account_suspended cannot be edited on a plan =====
    s := pg_temp.call_as(u_super, format('SELECT public.admin_update_plan_feature(%L::uuid, %L::uuid, true, NULL)', v_team, v_feat));
    r := r || jsonb_build_object('C-P1 enable refused', s LIKE '%feature_not_editable%');
    s := pg_temp.call_as(u_super, format('SELECT public.admin_update_plan_feature(%L::uuid, %L::uuid, false, %L)', v_team, v_feat, 'true'));
    r := r || jsonb_build_object('C-P2 disable with value true refused', s LIKE '%feature_not_editable%');
    SELECT count(*) INTO n FROM public.plan_features WHERE plan_id = v_team AND feature_id = v_feat;
    r := r || jsonb_build_object('C-P3 no plan_features row written', n = 0);
    s := pg_temp.call_as(u_super, format('SELECT public.admin_update_plan_feature(%L::uuid, %L::uuid, false, NULL)', v_team, v_other));
    r := r || jsonb_build_object('C-P4 another feature still saves', s LIKE '%"success": true%');

    -- ===== C-8: grants =====
    r := r || jsonb_build_object('C-8 client roles hold nothing on the new functions', NOT (
         has_function_privilege('anon', 'public._billing_org_sync_lease(uuid,text,uuid,integer)', 'EXECUTE')
      OR has_function_privilege('authenticated', 'public._billing_org_sync_lease(uuid,text,uuid,integer)', 'EXECUTE')
      OR has_function_privilege('anon', 'public._billing_org_sync_release(uuid,text,uuid)', 'EXECUTE')
      OR has_function_privilege('authenticated', 'public._billing_org_sync_release(uuid,text,uuid)', 'EXECUTE')
      OR has_function_privilege('anon', 'public._billing_record_invoice_paid(uuid,text,bigint)', 'EXECUTE')
      OR has_function_privilege('authenticated', 'public._billing_record_invoice_paid(uuid,text,bigint)', 'EXECUTE')
      OR has_function_privilege('anon', 'public._billing_enqueue_org_work()', 'EXECUTE')
      OR has_function_privilege('authenticated', 'public._billing_enqueue_org_work()', 'EXECUTE')
      OR has_function_privilege('anon', 'public._billing_apply_org_subscription(uuid,text,jsonb,bigint)', 'EXECUTE')
      OR has_function_privilege('authenticated', 'public._billing_auto_reinstate(uuid,text)', 'EXECUTE')));
    r := r || jsonb_build_object('C-8 service_role holds the new functions',
          has_function_privilege('service_role', 'public._billing_org_sync_lease(uuid,text,uuid,integer)', 'EXECUTE')
      AND has_function_privilege('service_role', 'public._billing_org_sync_release(uuid,text,uuid)', 'EXECUTE')
      AND has_function_privilege('service_role', 'public._billing_record_invoice_paid(uuid,text,bigint)', 'EXECUTE'));
    r := r || jsonb_build_object('C-8 client roles cannot write the lease columns', NOT (
         has_column_privilege('authenticated', 'public.org_billing_stripe', 'sync_lease_holder', 'UPDATE')
      OR has_column_privilege('anon', 'public.org_billing_stripe', 'last_invoice_paid_event_created', 'UPDATE')));
    RETURN r;
  END $b$$f$;

  v_res := jsonb_build_object('md5', jsonb_build_object(
    'apply', md5(pg_get_functiondef(to_regprocedure('public._billing_apply_org_subscription(uuid,text,jsonb,bigint)'))),
    'auto', md5(pg_get_functiondef(to_regprocedure('public._billing_auto_reinstate(uuid,text)'))),
    'planfeat', md5(pg_get_functiondef(to_regprocedure('public.admin_update_plan_feature(uuid,uuid,boolean,text)'))),
    'trigger', md5(pg_get_functiondef(to_regprocedure('public._billing_enqueue_org_work()'))),
    'lease', md5(pg_get_functiondef(to_regprocedure('public._billing_org_sync_lease(uuid,text,uuid,integer)'))),
    'paid', md5(pg_get_functiondef(to_regprocedure('public._billing_record_invoice_paid(uuid,text,bigint)')))));
  FOREACH v_m IN ARRAY v_modes LOOP
    BEGIN
      v_mut := pg_temp.apply_mode(v_m);
      v_r := pg_temp.run();
      v_res := v_res || jsonb_build_object(v_m, jsonb_build_object(
        'mutation', v_mut,
        'pass', (SELECT count(*) FROM jsonb_each(v_r) e WHERE e.value = 'true'::jsonb),
        'fail', (SELECT count(*) FROM jsonb_each(v_r) e WHERE e.value <> 'true'::jsonb),
        'reds', (SELECT coalesce(jsonb_agg(e.key ORDER BY e.key), '[]'::jsonb) FROM jsonb_each(v_r) e WHERE e.value <> 'true'::jsonb)));
      RAISE EXCEPTION 'rollback_mode';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> 'rollback_mode' THEN
        v_res := v_res || jsonb_build_object(v_m, jsonb_build_object('error', SQLERRM));
      END IF;
    WHEN OTHERS THEN
      v_res := v_res || jsonb_build_object(v_m, jsonb_build_object('error', SQLSTATE || ' ' || SQLERRM));
    END;
  END LOOP;
  RAISE EXCEPTION 'P3853P2_RESULT %', v_res::text;
END
$drv$;
