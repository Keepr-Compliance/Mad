-- BACKLOG-4007 PR-3: the end-to-end check BACKLOG-4012 could not run.
-- A PAID brokerage waits for billing setup -> Microsoft auto-join (JIT) is refused; the broker
-- accepts the terms and completes the Billing step through the same RPCs the setup guide calls;
-- then the SAME user's JIT join succeeds. Also: a broker-portal (client) invite is refused while
-- waiting and allowed after; completion enqueues exactly one sync row.
-- keepr-test only (~/.claude/bin/kt-sql). One transaction ending in RAISE: nothing persists.
-- Modes: replace __MODES__ (e.g. 'base','complete_keeps_draft','complete_no_bump').
DO $drv$
DECLARE
  v_modes text[] := ARRAY[__MODES__]::text[];
  v_m text;
  v_res jsonb := '{}'::jsonb;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.as_user(u uuid) RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated',
      'session_id', (SELECT s.id FROM auth.sessions s WHERE s.user_id = u ORDER BY s.created_at DESC LIMIT 1))::text, true);
    PERFORM set_config('request.jwt.claim.sub', u::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  END $b$$f$;
  -- q as role authenticated with user u (r NULL = as the session owner); 'OK <v>' / 'ERR <state> <msg>'
  EXECUTE $f$CREATE FUNCTION pg_temp.run_as(r text, u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE v text;
  BEGIN
    BEGIN
      IF u IS NOT NULL THEN PERFORM pg_temp.as_user(u); END IF;
      IF r IS NOT NULL THEN EXECUTE 'SET LOCAL ROLE ' || r; END IF;
      EXECUTE q INTO v;
      EXECUTE 'RESET ROLE';
      RETURN 'OK ' || coalesce(v, 'null');
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
    END;
  END $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.ok(s text) RETURNS jsonb LANGUAGE plpgsql AS $b$
  BEGIN
    IF s IS NULL OR s NOT LIKE 'OK %' THEN RETURN '{}'::jsonb; END IF;
    RETURN substr(s, 4)::jsonb;
  EXCEPTION WHEN OTHERS THEN RETURN '{}'::jsonb;
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
    IF m1 = m2 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: md5 unchanged %', p_sig; END IF;
    RETURN 'MUTATION APPLIED ' || p_sig || ' ' || left(m1, 8) || '->' || left(m2, 8);
  END $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE cs text := 'public.broker_complete_billing_setup(uuid,integer,jsonb,jsonb,boolean)';
  BEGIN
    CASE m
    WHEN 'base' THEN RETURN 'none';
    -- likely wrong build: completion records everything but leaves the deal waiting
    WHEN 'complete_keeps_draft' THEN RETURN pg_temp.mut_fn(cs, $q$    status = 'active',$q$, $q$    status = 'draft',$q$);
    -- likely wrong build: status flips without a version bump (no sync row; plan K6)
    WHEN 'complete_no_bump' THEN RETURN pg_temp.mut_fn(cs, $q$    version = version + 1,$q$, $q$    version = version,$q$);
    ELSE RAISE EXCEPTION 'unknown mode %', m;
    END CASE;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.checks() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    o uuid := gen_random_uuid();
    u_sales uuid := gen_random_uuid(); u_b uuid := gen_random_uuid(); u_j uuid := gen_random_uuid();
    tid text := gen_random_uuid()::text;
    v_team uuid := (SELECT id FROM public.plans WHERE tier = 'team' LIMIT 1);
    s text; v jsonb; ver int; n0 int; n1 int; d record; fx jsonb;
    co text := '{"legal_name":"P4007E Realty LLC","address_line1":"1 Main St","city":"Seattle","region":"WA","postal_code":"98101","country":"US","po_number":"PO-1"}';
  BEGIN
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT x, 'p4007e-' || left(x::text, 8) || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"azure"}', '{}', now(), now() FROM unnest(ARRAY[u_sales, u_b, u_j]) x;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    SELECT x, 'p4007e-' || left(x::text, 8) || '@example.test', 'azure', 'p4007e-' || x, 'P4007E ' || left(x::text, 4)
      FROM unnest(ARRAY[u_sales, u_b, u_j]) x ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.internal_roles (user_id, role_id) SELECT u_sales, ar.id FROM public.admin_roles ar WHERE ar.slug = 'sales';
    -- the joiner: a Microsoft identity in the brokerage's tenant, fresh OAuth sign-in (4012 freshness rule)
    INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
    VALUES ('p4007e-oid', u_j, jsonb_build_object('sub', 'p4007e', 'custom_claims', jsonb_build_object('tid', tid)), 'azure', now(), now());
    INSERT INTO auth.sessions (id, user_id, created_at, updated_at, aal) VALUES (gen_random_uuid(), u_j, now(), now(), 'aal1');
    INSERT INTO auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method)
    SELECT gen_random_uuid(), s2.id, now(), now(), 'oauth' FROM auth.sessions s2 WHERE s2.user_id = u_j;

    INSERT INTO public.organizations (id, name, slug, max_seats, is_test, microsoft_tenant_id, jit_provisioning_enabled, default_member_role)
    VALUES (o, 'P4007E ' || left(o::text, 8), 'p4007e-' || left(o::text, 8), 10, true, tid, true, 'agent');
    INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
    VALUES (o, v_team, '{"jit_provisioning":{"enabled":true}}'::jsonb);
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at)
    VALUES (o, u_b, 'admin', 'active', now());

    -- staff save a PAID deal ($24.99 x 5) through the 10-arg admin_save_deal: it waits ('draft')
    s := pg_temp.run_as('authenticated', u_sales, format(
      'SELECT public.admin_save_deal(%L::uuid, %L, %s, %s, %L, %L, NULL::uuid, %L, %s, %s)::text',
      o, 'test', 5, 2499, NULL, NULL, 'new deal', 'NULL', 'NULL::date'));
    SELECT * INTO d FROM public.org_deals WHERE organization_id = o;
    r := r || jsonb_build_object('E0_paid_deal_waits', CASE WHEN pg_temp.ok(s)->>'success' = 'true' AND d.status = 'draft'
      THEN 'PASS' ELSE 'FAIL ' || left(s, 80) END);

    -- E1: JIT join while waiting -> billing_setup_pending, no member row
    s := pg_temp.run_as('authenticated', u_j, format('SELECT public.jit_join_organization(%L, %L)::text', 'azure_ad', tid));
    r := r || jsonb_build_object('E1_jit_refused_while_waiting', CASE WHEN pg_temp.ok(s)->>'error' = 'billing_setup_pending'
      AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = o AND m.user_id = u_j)
      THEN 'PASS' ELSE 'FAIL ' || left(s, 80) END);
    -- E1b: the trigger is the backstop for a JIT-origin insert by the definer owner
    s := pg_temp.run_as(NULL, NULL, format($q$INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by) VALUES (%L, %L, 'agent', 'active', now(), 'jit') RETURNING license_status$q$, o, u_j));
    r := r || jsonb_build_object('E1b_trigger_refuses_jit_insert', CASE WHEN s LIKE 'ERR P0001 billing_setup_incomplete%' THEN 'PASS' ELSE 'FAIL ' || s END);
    -- E2: broker-portal (client) invite while waiting -> P0001 billing_setup_incomplete
    s := pg_temp.run_as('authenticated', u_b, format($q$INSERT INTO public.organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, invited_by, provisioned_by) VALUES (%L, 'p4007e-inv1@example.test', 'agent', 'pending', 'p4007e-tok1-' || %L, now() + interval '7 days', %L, 'invite') RETURNING license_status$q$, o, o, u_b));
    r := r || jsonb_build_object('E2_client_invite_refused_while_waiting', CASE WHEN s LIKE 'ERR P0001 billing_setup_incomplete%' THEN 'PASS' ELSE 'FAIL ' || s END);

    -- E3: the setup guide's read
    s := pg_temp.run_as('authenticated', u_b, format('SELECT public.broker_get_billing_setup(%L::uuid)::text', o));
    v := pg_temp.ok(s);
    ver := (v->>'version')::int;
    fx := v;
    r := r || jsonb_build_object('E3_guide_reads_waiting', CASE WHEN v->>'state' = 'waiting_for_setup' AND (v->>'unit_price_cents')::int = 2499
      THEN 'PASS' ELSE 'FAIL ' || left(s, 80) END);

    -- E4: accept terms + complete (the server action's two calls, same user, same version)
    s := pg_temp.run_as('authenticated', u_b, format('SELECT public.broker_accept_terms(%L::uuid, %s, %L, %L)::text', o, ver, 'keepr-terms-2026-10', 'https://keeprcompliance.com/terms'));
    n0 := (SELECT count(*) FROM public.billing_outbox b WHERE b.organization_id = o AND b.kind = 'sync_org_subscription');
    s := s || ' | ' || pg_temp.run_as('authenticated', u_b, format('SELECT public.broker_complete_billing_setup(%L::uuid, %s, %L::jsonb, %L::jsonb, false)::text',
      o, ver, '{"who":"me","phone":"(206) 555-0100"}', co));
    n1 := (SELECT count(*) FROM public.billing_outbox b WHERE b.organization_id = o AND b.kind = 'sync_org_subscription');
    SELECT * INTO d FROM public.org_deals WHERE organization_id = o;
    r := r || jsonb_build_object('E4_complete_activates_and_one_sync_row', CASE WHEN s LIKE '%"success": true%"success": true%'
      AND d.status = 'active' AND d.version = ver + 1 AND n1 - n0 = 1 THEN 'PASS' ELSE 'FAIL ' || left(s, 120) || ' st=' || d.status || ' rows+' || (n1 - n0) END);
    r := r || jsonb_build_object('E4b_company_and_contact_for_the_sync', CASE WHEN EXISTS (SELECT 1 FROM public.org_billing_profile p WHERE p.organization_id = o AND p.po_number = 'PO-1')
      AND EXISTS (SELECT 1 FROM public.org_contacts c WHERE c.id = d.billing_contact_id AND c.phone = '+12065550100')
      AND d.billing_starts_on IS NOT NULL THEN 'PASS' ELSE 'FAIL' END);

    -- E5: the SAME user's JIT join now succeeds
    s := pg_temp.run_as('authenticated', u_j, format('SELECT public.jit_join_organization(%L, %L)::text', 'azure_ad', tid));
    r := r || jsonb_build_object('E5_same_user_joins_after_setup', CASE WHEN pg_temp.ok(s)->>'success' = 'true'
      AND EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = o AND m.user_id = u_j AND m.provisioned_by = 'jit' AND m.role = 'agent')
      THEN 'PASS' ELSE 'FAIL ' || left(s, 80) END);
    -- E6: the client invite now goes through
    s := pg_temp.run_as('authenticated', u_b, format($q$INSERT INTO public.organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, invited_by, provisioned_by) VALUES (%L, 'p4007e-inv2@example.test', 'agent', 'pending', 'p4007e-tok2-' || %L, now() + interval '7 days', %L, 'invite') RETURNING license_status$q$, o, o, u_b));
    r := r || jsonb_build_object('E6_client_invite_allowed_after_setup', CASE WHEN s = 'OK pending' THEN 'PASS' ELSE 'FAIL ' || s END);

    -- the setup guide's read, keys only (fixture source for the jest tests; ids are not kept)
    r := r || jsonb_build_object('fx_keys', CASE WHEN fx ?& ARRAY['success','state','version','plan_name','seats','unit_price_cents',
      'monthly_total_cents','start_date','billing_starts_on','account_manager','contact','company','me'] THEN 'PASS' ELSE 'FAIL ' || fx::text END);
    -- the read's shape (personal fields dropped) travels in the result, outside the pass/fail count
    RETURN r || jsonb_build_object('~fx_view', fx - 'me' - 'account_manager' - 'contact');
  END $b$$f$;

  FOREACH v_m IN ARRAY v_modes LOOP
    BEGIN
      DECLARE v_mut text; v_r jsonb; v_pass int; v_fail int; v_reds jsonb;
      BEGIN
        v_mut := pg_temp.apply_mode(v_m);
        v_r := pg_temp.checks();
        SELECT count(*) FILTER (WHERE value #>> '{}' = 'PASS'), count(*) FILTER (WHERE value #>> '{}' <> 'PASS'),
               coalesce(jsonb_agg(key || ': ' || (value #>> '{}')) FILTER (WHERE value #>> '{}' <> 'PASS'), '[]'::jsonb)
          INTO v_pass, v_fail, v_reds FROM jsonb_each(v_r - '~fx_view');
        RAISE EXCEPTION 'MODE_DONE %', jsonb_build_object('mutation', v_mut, 'pass', v_pass, 'fail', v_fail, 'reds', v_reds,
          'fx_view', CASE WHEN v_m = 'base' THEN v_r -> '~fx_view' END)::text;
      END;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'MODE_DONE %' THEN
        v_res := v_res || jsonb_build_object(v_m, substr(SQLERRM, 11)::jsonb);
      ELSE
        v_res := v_res || jsonb_build_object(v_m, 'HARNESS ERROR ' || SQLSTATE || ' ' || SQLERRM);
      END IF;
    END;
  END LOOP;
  RAISE EXCEPTION 'P4007E_RESULT %', v_res::text;
END
$drv$;
