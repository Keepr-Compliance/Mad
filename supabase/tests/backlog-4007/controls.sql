-- BACKLOG-4007 PR-1 DB controls.
-- Venue: keepr-test, ONE call, ONE transaction that ends in RAISE, so nothing persists.
-- Run after 20261020100000 is applied, or compose it in front (compose.py --with-migration).
-- __MODES__ is replaced with a comma list of quoted mode names. Each mode runs in its own
-- subtransaction: apply the mutation (exact-once replace that raises on 0 or 2+ matches; the md5
-- of pg_get_functiondef must change, else MUTATION NOT APPLIED), build fixtures, run every
-- check, roll back. 'base' = no mutation (every check must PASS).
-- Output: RAISE 'P4007_RESULT {mode: {mutation, pass, fail, reds}}'.
-- Fixtures: new auth users p4007-*@example.test, new organizations P4007 *.

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

  EXECUTE $f$CREATE FUNCTION pg_temp.sync_rows(o uuid) RETURNS int LANGUAGE sql AS $b$
    SELECT count(*)::int FROM public.billing_outbox b WHERE b.organization_id = o AND b.kind = 'sync_org_subscription'
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.rem_rows(o uuid) RETURNS int LANGUAGE sql AS $b$
    SELECT count(*)::int FROM public.billing_outbox b WHERE b.organization_id = o AND b.kind = 'notify_setup_reminder' AND b.processed_at IS NULL
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE
    sd text := 'public._billing_save_deal(uuid,jsonb,uuid,text,integer)';
    cs text := 'public.broker_complete_billing_setup(uuid,integer,jsonb,jsonb,boolean)';
    gb text := 'public.admin_get_org_billing(uuid)';
    rm text := 'public._billing_enqueue_setup_reminders()';
    gi text := 'public._billing_guard_invite_while_setup_pending()';
    bd text := 'public._billing_business_date(timestamp with time zone)';
  BEGIN
    CASE m
    WHEN 'base' THEN RETURN 'none';
    -- SR wrong build (2)/K3: staff edit of a waiting deal activates it (today's :456)
    WHEN 'edit_activates_draft' THEN RETURN pg_temp.mut_fn(sd,
      $q$status = CASE WHEN status = 'canceled' THEN 'active' ELSE status END,$q$,
      $q$status = CASE WHEN status IN ('draft', 'canceled') THEN 'active' ELSE status END,$q$);
    -- new deal inserted active (today's insert)
    WHEN 'insert_active' THEN RETURN pg_temp.mut_fn(sd,
      $q$coalesce(v_start, v_today), 'draft',$q$, $q$coalesce(v_start, v_today), 'active',$q$);
    -- SR wrong build (1)/K6: completion flips status without a version bump
    WHEN 'complete_no_bump' THEN RETURN pg_temp.mut_fn(cs,
      $q$status = 'active',
    version = version + 1,$q$, $q$status = 'active',$q$);
    -- C-S3: no status guard on completion
    WHEN 'complete_no_status_guard' THEN RETURN pg_temp.mut_fn(cs,
      $q$IF v_deal.status <> 'draft' THEN$q$, 'IF false THEN');
    -- SR wrong build (10)/C-S6: no expected-version check
    WHEN 'complete_no_version_check' THEN RETURN pg_temp.mut_fn(cs,
      $q$  -- The broker confirms the price they saw: refuse if staff changed the deal since.
  IF p_expected_version IS DISTINCT FROM v_deal.version THEN$q$, '  IF false THEN');
    -- C-S1: role filter removed (IT admin / agent may complete)
    WHEN 'complete_any_role' THEN RETURN pg_temp.mut_fn(cs,
      $q$AND m.license_status = 'active' AND m.role IN ('broker', 'admin')) THEN$q$,
      $q$AND m.license_status = 'active') THEN$q$);
    -- C-S2: pass-through of seats from the broker's input
    WHEN 'complete_seat_passthrough' THEN RETURN pg_temp.mut_fn(cs,
      $q$  v_contact := public._org_billing_contact_set(p_org, v_name, v_email, v_phone, v_uid);$q$,
      $q$  UPDATE public.org_deals SET seats = coalesce((p_contact ->> 'seats')::int, seats) WHERE organization_id = p_org;
  v_contact := public._org_billing_contact_set(p_org, v_name, v_email, v_phone, v_uid);$q$);
    -- C-S5: billing start from start_date only
    WHEN 'starts_from_start_date' THEN RETURN pg_temp.mut_fn(cs,
      $q$v_starts := greatest(public._billing_business_date(), v_deal.start_date);$q$,
      $q$v_starts := v_deal.start_date;$q$);
    -- terms: no acceptance check / acceptance for any version
    WHEN 'no_terms_check' THEN RETURN pg_temp.mut_fn(cs,
      $q$  IF NOT EXISTS (SELECT 1 FROM public.org_terms_acceptances a$q$, $q$  IF false AND NOT EXISTS (SELECT 1 FROM public.org_terms_acceptances a$q$);
    WHEN 'terms_any_version' THEN RETURN pg_temp.mut_fn(cs,
      $q$
                    AND a.deal_version = v_deal.version) THEN$q$, ') THEN');
    -- company details
    WHEN 'no_company_name_check' THEN RETURN pg_temp.mut_fn(cs,
      $q$  IF v_legal IS NULL THEN$q$, '  IF false THEN');
    WHEN 'no_address_check' THEN RETURN pg_temp.mut_fn(cs,
      $q$  IF v_line1 IS NULL OR v_city IS NULL$q$, $q$  IF false AND v_line1 IS NULL OR false AND v_city IS NULL$q$);
    WHEN 'po_required' THEN RETURN pg_temp.mut_fn(cs,
      $q$  IF v_legal IS NULL THEN$q$, $q$  IF v_legal IS NULL OR v_po IS NULL THEN$q$);
    -- phone
    WHEN 'no_phone_check' THEN RETURN pg_temp.mut_fn(cs,
      $q$  IF v_phone IS NULL THEN$q$, '  IF false THEN');
    -- SR wrong build (11)/change 6: staff contact edit writes the deal columns directly
    WHEN 'contact_direct_write' THEN RETURN pg_temp.mut_fn(sd,
      $q$    PERFORM public._org_billing_contact_set(p_org, v_contact_name, v_contact_email, NULL, p_actor);$q$,
      $q$    UPDATE public.org_deals SET billing_contact_name = v_contact_name, billing_contact_email = v_contact_email WHERE organization_id = p_org;$q$);
    -- SR wrong build (9)/change 3: UTC "today"
    WHEN 'save_utc_today' THEN RETURN pg_temp.mut_fn(sd,
      $q$v_today date := public._billing_business_date();$q$, $q$v_today date := current_date;$q$);
    WHEN 'helper_utc' THEN RETURN pg_temp.mut_fn(bd,
      $q$(p_at AT TIME ZONE 'America/Los_Angeles')::date$q$, $q$(p_at AT TIME ZONE 'UTC')::date$q$);
    WHEN 'complete_utc_today' THEN RETURN pg_temp.mut_fn(cs,
      $q$v_starts := greatest(public._billing_business_date(), v_deal.start_date);$q$,
      $q$v_starts := greatest(current_date, v_deal.start_date);$q$);
    -- change 8: state derived from setup_completed_at
    WHEN 'state_from_completed_at' THEN RETURN pg_temp.mut_fn(gb,
      $q$'state', (SELECT CASE d.status WHEN 'draft' THEN 'waiting_for_setup' ELSE d.status END$q$,
      $q$'state', (SELECT CASE WHEN d.setup_completed_at IS NULL THEN 'waiting_for_setup' ELSE d.status END$q$);
    -- founder Q3: broker invite while waiting
    WHEN 'invite_guard_off' THEN RETURN pg_temp.mut_fn(gi,
      $q$IF current_user IN ('authenticated', 'anon')$q$, $q$IF false$q$);
    -- the likely wrong guard: SECURITY DEFINER-style check on the role GUC refuses staff too
    WHEN 'invite_guard_role_guc' THEN RETURN pg_temp.mut_fn(gi,
      $q$IF current_user IN ('authenticated', 'anon')$q$, $q$IF coalesce(current_setting('role', true), '') IN ('authenticated', 'anon')$q$);
    -- reminders
    WHEN 'reminders_any_status' THEN RETURN pg_temp.mut_fn(rm,
      $q$WHERE d.organization_id = NEW.organization_id AND d.status = 'draft';$q$,
      $q$WHERE d.organization_id = NEW.organization_id;$q$);
    WHEN 'reminders_no_supersede' THEN RETURN pg_temp.mut_fn(rm,
      $q$  UPDATE public.billing_outbox SET processed_at = now(), last_error = 'superseded_by_resend'$q$,
      $q$  UPDATE public.billing_outbox SET processed_at = processed_at$q$);
    WHEN 'reminders_any_role' THEN RETURN pg_temp.mut_fn(rm,
      $q$     OR NEW.role NOT IN ('broker', 'admin')$q$, '');
    -- one billing contact / billing-only login per brokerage
    WHEN 'drop_one_billing_index' THEN
      EXECUTE 'DROP INDEX public.org_contacts_one_billing_idx';
      IF to_regclass('public.org_contacts_one_billing_idx') IS NOT NULL THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: index still there'; END IF;
      RETURN 'MUTATION APPLIED DROP INDEX org_contacts_one_billing_idx';
    WHEN 'sr_accept_no_version_check' THEN RETURN pg_temp.mut_fn('public.broker_accept_terms(uuid,integer,text,text)',
      $q$  IF p_expected_version IS DISTINCT FROM v_deal.version THEN$q$, '  IF false THEN');
    WHEN 'sr_terms_any_user' THEN RETURN pg_temp.mut_fn(cs,
      $q$WHERE a.organization_id = p_org AND a.user_id = v_uid$q$, $q$WHERE a.organization_id = p_org$q$);
    WHEN 'sr_lock_only_active' THEN RETURN pg_temp.mut_fn(sd,
      $q$      IF v_deal.status <> 'draft' THEN$q$, $q$      IF v_deal.status = 'active' THEN$q$);
    WHEN 'sr_service_role_mutable' THEN
      EXECUTE 'GRANT UPDATE, DELETE, TRUNCATE ON public.org_terms_acceptances TO service_role';
      IF NOT has_table_privilege('service_role', 'public.org_terms_acceptances', 'UPDATE') THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: grant missing'; END IF;
      RETURN 'MUTATION APPLIED GRANT UPDATE, DELETE, TRUNCATE ON org_terms_acceptances TO service_role';
    ELSE RAISE EXCEPTION 'unknown mode %', m;
    END CASE;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb; v_upd text; v_del text;
    o1 uuid := gen_random_uuid();  -- main flow: draft -> edit -> terms -> complete
    o2 uuid := gen_random_uuid();  -- other brokerage (its admin must be refused on o1)
    o3 uuid := gen_random_uuid();  -- start-date rules, past start + completion
    o4 uuid := gen_random_uuid();  -- version / terms-version races
    o5 uuid := gen_random_uuid();  -- reminders + invite guard
    o6 uuid := gen_random_uuid();  -- active deal: contact single writer, reminders off
    u_sales uuid := gen_random_uuid(); u_super uuid := gen_random_uuid();
    u_b uuid := gen_random_uuid(); u_it uuid := gen_random_uuid(); u_ag uuid := gen_random_uuid();
    u_x uuid := gen_random_uuid(); u_b3 uuid := gen_random_uuid(); u_b4 uuid := gen_random_uuid();
    u_b5 uuid := gen_random_uuid(); u_b6 uuid := gen_random_uuid();
    v_team uuid; s text; s2 text; n int; v int; bd date; d record; m_inv uuid;
    q10 text := 'SELECT public.admin_save_deal(%L::uuid, %L, %s, %s, %L, %L, NULL::uuid, %L, %s, %s)';
    q9  text := 'SELECT public.admin_save_deal(%L::uuid, %L, %s, %s, %L, %L, NULL::uuid, %L, %s)';
    qt  text := 'SELECT public.broker_accept_terms(%L::uuid, %s, %L, %L)';
    qc  text := 'SELECT public.broker_complete_billing_setup(%L::uuid, %s, %L::jsonb, %L::jsonb, %s)';
    me  text := '{"who":"me","phone":"(206) 555-0100"}';
    co  text := '{"legal_name":"P4007 Realty LLC","address_line1":"1 Main St","city":"Seattle","region":"WA","postal_code":"98101","country":"US"}';
    tv  text := '2026-10-19'; tu text := 'https://keeprcompliance.com/terms';
  BEGIN
    SELECT id INTO v_team FROM public.plans WHERE name = 'Team';
    bd := public._billing_business_date();

    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT x, 'p4007-' || left(x::text, 8) || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM unnest(ARRAY[u_sales, u_super, u_b, u_it, u_ag, u_x, u_b3, u_b4, u_b5, u_b6]) x;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    SELECT x, 'p4007-' || left(x::text, 8) || '@example.test', 'email', x::text, 'P4007 ' || left(x::text, 4)
      FROM unnest(ARRAY[u_sales, u_super, u_b, u_it, u_ag, u_x, u_b3, u_b4, u_b5, u_b6]) x
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.internal_roles (user_id, role_id)
    SELECT x.u, ar.id FROM (VALUES (u_sales, 'sales'), (u_super, 'super-admin')) x(u, slug)
      JOIN public.admin_roles ar ON ar.slug = x.slug;
    INSERT INTO public.organizations (id, name, slug, max_seats, is_test)
    SELECT x, 'P4007 ' || left(x::text, 8), 'p4007-' || left(x::text, 8), 10, true FROM unnest(ARRAY[o1, o2, o3, o4, o5, o6]) x;
    INSERT INTO public.organization_plans (organization_id, plan_id) SELECT x, v_team FROM unnest(ARRAY[o1, o2, o3, o4, o5, o6]) x;
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at) VALUES
      (o1, u_b, 'admin', 'active', now()), (o1, u_it, 'it_admin', 'active', now()), (o1, u_ag, 'agent', 'active', now()),
      -- a staffer who is also a member of the brokerage: the membership clause alone cannot exempt staff
      (o1, u_super, 'agent', 'active', now()),
      (o2, u_x, 'admin', 'active', now()), (o3, u_b3, 'broker', 'active', now()), (o4, u_b4, 'admin', 'active', now()),
      (o5, u_b5, 'admin', 'active', now()), (o6, u_b6, 'admin', 'active', now());

    -- ===== C-D0 new deal waits; nothing enqueued =====
    s := pg_temp.call_as(u_sales, format(q10, o1, 'test', 5, 2000, NULL, NULL, 'new deal', 'NULL', 'NULL::date'));
    SELECT * INTO d FROM public.org_deals WHERE organization_id = o1;
    r := r || jsonb_build_object('C_D0_new_deal_draft_no_contact_no_sync', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND d.status = 'draft' AND d.start_date = bd AND pg_temp.sync_rows(o1) = 0 THEN 'PASS' ELSE 'FAIL ' || s || ' ' || coalesce(d.status, '-') END);
    r := r || jsonb_build_object('K1_draft_grants_no_unlimited', CASE WHEN (SELECT op.feature_overrides -> 'unlimited_transactions'
      FROM public.organization_plans op WHERE op.organization_id = o1) IS NULL THEN 'PASS' ELSE 'FAIL' END);
    s := pg_temp.call_as(u_sales, format('SELECT public.admin_get_org_billing(%L::uuid)', o1));
    r := r || jsonb_build_object('C_G1_state_waiting', CASE WHEN pg_temp.j(s)->>'state' = 'waiting_for_setup' THEN 'PASS' ELSE 'FAIL ' || left(s, 60) END);

    -- ===== C-D1 staff edit of a waiting deal (9-arg wrapper): stays draft, no sync =====
    s := pg_temp.call_as(u_sales, format(q9, o1, 'test', 6, 2000, NULL, NULL, 'more seats', d.version));
    SELECT * INTO d FROM public.org_deals WHERE organization_id = o1;
    r := r || jsonb_build_object('C_D1_edit_keeps_draft_no_sync', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND d.status = 'draft' AND d.version = 2 AND d.seats = 6 AND pg_temp.sync_rows(o1) = 0 THEN 'PASS' ELSE 'FAIL ' || s || ' ' || d.status END);

    -- ===== broker_get_billing_setup =====
    s := pg_temp.call_as(u_b, format('SELECT public.broker_get_billing_setup(%L::uuid)', o1));
    r := r || jsonb_build_object('C_B1_broker_reads_setup', CASE WHEN pg_temp.j(s)->>'state' = 'waiting_for_setup'
      AND (pg_temp.j(s)->>'monthly_total_cents')::int = 12000 AND (pg_temp.j(s)->>'version')::int = 2 THEN 'PASS' ELSE 'FAIL ' || left(s, 80) END);
    s := pg_temp.call_as(u_it, format('SELECT public.broker_get_billing_setup(%L::uuid)', o1));
    r := r || jsonb_build_object('C_B2_it_admin_cannot_read', CASE WHEN s LIKE 'ERR 42501%' THEN 'PASS' ELSE 'FAIL ' || left(s, 60) END);

    -- ===== C-TA1 completion without terms acceptance refused =====
    s := pg_temp.call_as(u_b, format(qc, o1, 2, me, co, 'false'));
    r := r || jsonb_build_object('C_TA1_no_acceptance_refused', CASE WHEN pg_temp.j(s)->>'error' = 'terms_not_accepted' THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== C-S1 wrong callers refused (terms not even reached) =====
    s := pg_temp.call_as(u_it, format(qc, o1, 2, me, co, 'false'));
    s2 := pg_temp.call_as(u_ag, format(qc, o1, 2, me, co, 'false'));
    r := r || jsonb_build_object('C_S1_it_admin_agent_refused', CASE WHEN s LIKE 'ERR 42501%' AND s2 LIKE 'ERR 42501%' THEN 'PASS' ELSE 'FAIL ' || left(s, 40) || ' | ' || left(s2, 40) END);
    s := pg_temp.call_as(u_x, format(qc, o1, 2, me, co, 'false'));
    r := r || jsonb_build_object('C_S1_other_org_admin_refused', CASE WHEN s LIKE 'ERR 42501%' THEN 'PASS' ELSE 'FAIL ' || left(s, 60) END);

    -- ===== terms acceptance =====
    s := pg_temp.call_as(u_b, format(qt, o1, 2, tv, tu));
    r := r || jsonb_build_object('C_TA2_acceptance_records_deal_price', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND EXISTS (SELECT 1 FROM public.org_terms_acceptances a WHERE a.organization_id = o1 AND a.user_id = u_b
                   AND a.deal_version = 2 AND a.seats = 6 AND a.unit_price_cents = 2000 AND a.monthly_total_cents = 12000
                   AND a.terms_version = tv AND a.terms_url = tu) THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== company / phone / login refusals (terms accepted, so these are the reason) =====
    s := pg_temp.call_as(u_b, format(qc, o1, 2, me, '{"address_line1":"1 Main St","city":"Seattle","region":"WA","postal_code":"98101","country":"US"}', 'false'));
    r := r || jsonb_build_object('C_CO1_missing_company_name_refused', CASE WHEN pg_temp.j(s)->>'error' = 'company_name_required' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_b, format(qc, o1, 2, me, '{"legal_name":"X LLC","city":"Seattle","region":"WA","postal_code":"98101","country":"US"}', 'false'));
    r := r || jsonb_build_object('C_CO2_missing_address_refused', CASE WHEN pg_temp.j(s)->>'error' = 'billing_address_required' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_b, format(qc, o1, 2, me, '{"legal_name":"X LLC","address_line1":"1 Main St","city":"Seattle","postal_code":"98101","country":"US"}', 'false'));
    r := r || jsonb_build_object('C_CO3_us_without_region_refused', CASE WHEN pg_temp.j(s)->>'error' = 'billing_address_required' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_b, format(qc, o1, 2, '{"who":"me","phone":"12"}', co, 'false'));
    r := r || jsonb_build_object('C_PH1_bad_phone_refused', CASE WHEN pg_temp.j(s)->>'error' = 'invalid_phone' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_b, format(qc, o1, 2, me, co, 'true'));
    r := r || jsonb_build_object('C_BL1_billing_login_not_yet', CASE WHEN pg_temp.j(s)->>'error' = 'billing_login_not_available' THEN 'PASS' ELSE 'FAIL ' || s END);
    r := r || jsonb_build_object('C_X_refusals_left_deal_waiting', CASE WHEN (SELECT status FROM public.org_deals WHERE organization_id = o1) = 'draft'
      AND pg_temp.sync_rows(o1) = 0 THEN 'PASS' ELSE 'FAIL' END);

    -- ===== C-IV1 broker cannot invite while waiting; staff can =====
    s := pg_temp.call_as(u_b, format($q$INSERT INTO public.organization_members (organization_id, invited_email, role, license_status,
      invitation_token, invitation_expires_at, invited_by, provisioned_by, group_sync_enabled)
      VALUES (%L::uuid, 'p4007-inv1@example.test', 'agent', 'pending', md5(random()::text), now() + interval '7 days', %L::uuid, 'invite', false)
      RETURNING to_jsonb(true)$q$, o1, u_b));
    r := r || jsonb_build_object('C_IV1_broker_invite_refused_while_waiting', CASE WHEN s LIKE 'ERR P0001 billing_setup_incomplete%' THEN 'PASS' ELSE 'FAIL ' || left(s, 70) END);
    s := pg_temp.call_as(u_super, format($q$SELECT public.admin_invite_user(%L::uuid, 'p4007-inv2@example.test', 'admin', %L::uuid, 'trial', NULL)$q$, o1, u_super));
    r := r || jsonb_build_object('C_IV2_staff_invite_allowed_while_waiting', CASE WHEN pg_temp.j(s)->>'success' = 'true' THEN 'PASS' ELSE 'FAIL ' || left(s, 70) END);

    -- ===== C-S2 / C-S5 / K5 completion =====
    s := pg_temp.call_as(u_b, format(qc, o1, 2, '{"who":"me","phone":"(206) 555-0100","seats":99,"unit_price_cents":1}',
      '{"legal_name":"P4007 Realty LLC","address_line1":"1 Main St","city":"Seattle","region":"WA","postal_code":"98101","country":"US","seats":99}', 'false'));
    SELECT * INTO d FROM public.org_deals WHERE organization_id = o1;
    r := r || jsonb_build_object('C_S5_complete_active_bump_one_sync', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND d.status = 'active' AND d.version = 3 AND pg_temp.sync_rows(o1) = 1 AND d.billing_starts_on = bd
      AND d.setup_completed_by = u_b THEN 'PASS' ELSE 'FAIL ' || s || ' rows ' || pg_temp.sync_rows(o1) END);
    r := r || jsonb_build_object('C_S2_broker_input_cannot_change_price_or_seats', CASE WHEN d.seats = 6
      AND (SELECT unit_price_cents FROM public.org_deal_lines WHERE organization_id = o1) = 2000 THEN 'PASS' ELSE 'FAIL seats ' || d.seats END);
    r := r || jsonb_build_object('K5_complete_turns_unlimited_on', CASE WHEN (SELECT op.feature_overrides -> 'unlimited_transactions' ->> 'enabled'
      FROM public.organization_plans op WHERE op.organization_id = o1) = 'true' THEN 'PASS' ELSE 'FAIL' END);
    r := r || jsonb_build_object('C_PH2_contact_me_phone_normalised', CASE WHEN EXISTS (SELECT 1 FROM public.org_contacts c
      WHERE c.id = d.billing_contact_id AND c.phone = '+12065550100' AND c.email = 'p4007-' || left(u_b::text, 8) || '@example.test'
        AND d.billing_contact_email = c.email AND d.billing_contact_name = c.full_name) THEN 'PASS' ELSE 'FAIL' END);
    r := r || jsonb_build_object('C_CO4_po_optional_profile_written', CASE WHEN EXISTS (SELECT 1 FROM public.org_billing_profile p
      WHERE p.organization_id = o1 AND p.legal_name = 'P4007 Realty LLC' AND p.po_number IS NULL AND p.country = 'US') THEN 'PASS' ELSE 'FAIL' END);

    -- ===== C-S3 completion twice =====
    s := pg_temp.call_as(u_b, format(qc, o1, 3, me, co, 'false'));
    r := r || jsonb_build_object('C_S3_second_completion_refused', CASE WHEN pg_temp.j(s)->>'error' = 'not_waiting'
      AND pg_temp.sync_rows(o1) = 1 THEN 'PASS' ELSE 'FAIL ' || s || ' rows ' || pg_temp.sync_rows(o1) END);

    -- ===== C-D2 start date locked after completion; broker invites open =====
    s := pg_temp.call_as(u_sales, format(q10, o1, 'test', 6, 2000, NULL, NULL, 'move start', 3, quote_literal((bd + 30)::text) || '::date'));
    r := r || jsonb_build_object('C_D2_start_date_locked_after_setup', CASE WHEN pg_temp.j(s)->>'error' = 'start_date_locked' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_b, format($q$INSERT INTO public.organization_members (organization_id, invited_email, role, license_status,
      invitation_token, invitation_expires_at, invited_by, provisioned_by, group_sync_enabled)
      VALUES (%L::uuid, 'p4007-inv3@example.test', 'agent', 'pending', md5(random()::text), now() + interval '7 days', %L::uuid, 'invite', false)
      RETURNING to_jsonb(true)$q$, o1, u_b));
    r := r || jsonb_build_object('C_IV3_broker_invite_allowed_after_setup', CASE WHEN s = 'true' THEN 'PASS' ELSE 'FAIL ' || left(s, 70) END);

    -- ===== C-W1 staff contact edit on an active deal: one writer, no drift =====
    s := pg_temp.call_as(u_sales, format(q9, o1, 'test', 6, 2000, 'P4007 Payer', 'p4007-payer@example.test', 'new payer', 3));
    SELECT * INTO d FROM public.org_deals WHERE organization_id = o1;
    r := r || jsonb_build_object('C_W1_staff_contact_edit_no_drift', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND EXISTS (SELECT 1 FROM public.org_contacts c WHERE c.id = d.billing_contact_id AND c.removed_at IS NULL
                   AND c.email = d.billing_contact_email AND c.full_name = d.billing_contact_name AND c.email = 'p4007-payer@example.test')
      AND (SELECT count(*) FROM public.org_contacts c WHERE c.organization_id = o1 AND c.role = 'billing' AND c.removed_at IS NULL) = 1
      THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== C-BL2 one live billing contact (= one billing-only login) per brokerage =====
    BEGIN
      INSERT INTO public.org_contacts (organization_id, role, full_name, email) VALUES (o1, 'billing', 'Second', 'p4007-second@example.test');
      r := r || jsonb_build_object('C_BL2_second_billing_contact_refused', 'FAIL inserted');
    EXCEPTION WHEN unique_violation THEN
      r := r || jsonb_build_object('C_BL2_second_billing_contact_refused', 'PASS');
    END;

    -- ===== C-D2b past start refused on a new deal; future accepted; K3/C-S5 past start =====
    s := pg_temp.call_as(u_sales, format(q10, o3, 'test', 5, 2499, NULL, NULL, 'new', 'NULL', quote_literal((bd - 1)::text) || '::date'));
    r := r || jsonb_build_object('C_D2b_past_start_refused', CASE WHEN pg_temp.j(s)->>'error' = 'start_date_past'
      AND NOT EXISTS (SELECT 1 FROM public.org_deals WHERE organization_id = o3) THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sales, format(q10, o3, 'test', 5, 2499, NULL, NULL, 'new', 'NULL', quote_literal((bd + 20)::text) || '::date'));
    s2 := pg_temp.call_as(u_sales, format(q10, o3, 'test', 5, 2499, NULL, NULL, 'later', 1, quote_literal((bd + 40)::text) || '::date'));
    r := r || jsonb_build_object('C_D2c_future_start_editable_while_waiting', CASE WHEN pg_temp.j(s)->>'success' = 'true' AND pg_temp.j(s2)->>'success' = 'true'
      AND (SELECT start_date FROM public.org_deals WHERE organization_id = o3) = bd + 40 THEN 'PASS' ELSE 'FAIL ' || s || ' | ' || s2 END);
    s := pg_temp.call_as(u_b3, format(qt, o3, 2, tv, tu));
    s := pg_temp.call_as(u_b3, format(qc, o3, 2, me, co, 'false'));
    r := r || jsonb_build_object('C_S5b_future_start_bills_from_start', CASE WHEN (pg_temp.j(s)->>'billing_starts_on')::date = bd + 40 THEN 'PASS' ELSE 'FAIL ' || s END);

    -- past start: a waiting deal whose start date has passed bills from the completion day
    s := pg_temp.call_as(u_sales, format(q10, o4, 'test', 5, 2499, NULL, NULL, 'new', 'NULL', 'NULL::date'));
    UPDATE public.org_deals SET start_date = bd - 5 WHERE organization_id = o4;  -- time passing (not version/status)
    -- ===== C-S6 staff edit between view and confirm =====
    s := pg_temp.call_as(u_b4, format(qt, o4, 1, tv, tu));
    s := pg_temp.call_as(u_sales, format(q9, o4, 'test', 5, 2600, NULL, NULL, 'price up', 1));
    s := pg_temp.call_as(u_b4, format(qc, o4, 1, me, co, 'false'));
    r := r || jsonb_build_object('C_S6_stale_version_refused', CASE WHEN pg_temp.j(s)->>'error' = 'version_conflict'
      AND (SELECT status FROM public.org_deals WHERE organization_id = o4) = 'draft' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_b4, format(qt, o4, 1, tv, tu));
    r := r || jsonb_build_object('SR_A_stale_accept_refused', CASE WHEN pg_temp.j(s)->>'error' = 'version_conflict'
      AND NOT EXISTS (SELECT 1 FROM public.org_terms_acceptances a WHERE a.organization_id = o4 AND a.deal_version = 2) THEN 'PASS' ELSE 'FAIL ' || s END);
    -- ===== C-TA3 acceptance for an older version does not count =====
    s := pg_temp.call_as(u_b4, format(qc, o4, 2, me, co, 'false'));
    r := r || jsonb_build_object('C_TA3_old_version_acceptance_refused', CASE WHEN pg_temp.j(s)->>'error' = 'terms_not_accepted' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_b4, format(qt, o4, 2, tv, tu));
    s := pg_temp.call_as(u_b4, format(qc, o4, 2, me, co, 'false'));
    r := r || jsonb_build_object('C_S5c_past_start_bills_from_today', CASE WHEN (pg_temp.j(s)->>'billing_starts_on')::date = bd
      AND (SELECT start_date FROM public.org_deals WHERE organization_id = o4) = bd - 5 THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== C-R reminders =====
    s := pg_temp.call_as(u_sales, format(q10, o5, 'test', 5, 2499, NULL, NULL, 'new', 'NULL', 'NULL::date'));
    r := r || jsonb_build_object('C_R0_waiting_no_invite_no_reminders', CASE WHEN pg_temp.rem_rows(o5) = 0 THEN 'PASS' ELSE 'FAIL ' || pg_temp.rem_rows(o5) END);
    s := pg_temp.call_as(u_super, format($q$SELECT public.admin_invite_user(%L::uuid, 'p4007-rem@example.test', 'admin', %L::uuid, 'trial', NULL)$q$, o5, u_super));
    SELECT id INTO m_inv FROM public.organization_members WHERE organization_id = o5 AND invited_email = 'p4007-rem@example.test';
    r := r || jsonb_build_object('C_R1_invite_enqueues_day3_day7', CASE WHEN pg_temp.rem_rows(o5) = 2
      AND EXISTS (SELECT 1 FROM public.billing_outbox b WHERE b.organization_id = o5 AND b.kind = 'notify_setup_reminder'
                   AND (b.payload->>'day')::int = 3 AND b.run_after = now() + interval '3 days')
      AND EXISTS (SELECT 1 FROM public.billing_outbox b WHERE b.organization_id = o5 AND b.kind = 'notify_setup_reminder'
                   AND (b.payload->>'day')::int = 7 AND b.run_after = now() + interval '7 days') THEN 'PASS' ELSE 'FAIL ' || pg_temp.rem_rows(o5) END);
    s := pg_temp.call_as(u_super, format($q$SELECT public.admin_invite_user(%L::uuid, 'p4007-rem-agent@example.test', 'agent', %L::uuid, 'trial', NULL)$q$, o5, u_super));
    r := r || jsonb_build_object('C_R2_agent_invite_no_reminders', CASE WHEN pg_temp.rem_rows(o5) = 2 THEN 'PASS' ELSE 'FAIL ' || pg_temp.rem_rows(o5) END);
    UPDATE public.organization_members SET invitation_token = md5(random()::text) WHERE id = m_inv;  -- resend
    r := r || jsonb_build_object('C_R3_resend_supersedes_pair', CASE WHEN pg_temp.rem_rows(o5) = 2
      AND (SELECT count(*) FROM public.billing_outbox b WHERE b.organization_id = o5 AND b.kind = 'notify_setup_reminder'
             AND b.last_error = 'superseded_by_resend' AND b.processed_at IS NOT NULL) = 2 THEN 'PASS' ELSE 'FAIL ' || pg_temp.rem_rows(o5) END);

    -- active deal (o6): invite enqueues no reminder
    s := pg_temp.call_as(u_sales, format(q10, o6, 'test', 5, 2499, NULL, NULL, 'new', 'NULL', 'NULL::date'));
    s := pg_temp.call_as(u_b6, format(qt, o6, 1, tv, tu));
    s := pg_temp.call_as(u_b6, format(qc, o6, 1, me, co, 'false'));
    s := pg_temp.call_as(u_super, format($q$SELECT public.admin_invite_user(%L::uuid, 'p4007-rem6@example.test', 'admin', %L::uuid, 'trial', NULL)$q$, o6, u_super));
    r := r || jsonb_build_object('C_R4_active_deal_invite_no_reminders', CASE WHEN pg_temp.j(s)->>'success' = 'true' AND pg_temp.rem_rows(o6) = 0 THEN 'PASS' ELSE 'FAIL ' || left(s, 60) || ' ' || pg_temp.rem_rows(o6) END);

    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at) VALUES (o5, u_b6, 'admin', 'active', now());
    s := pg_temp.call_as(u_b5, format(qt, o5, 1, tv, tu));
    s := pg_temp.call_as(u_b6, format(qc, o5, 1, me, co, 'false'));
    r := r || jsonb_build_object('SR_B_other_users_acceptance_does_not_count', CASE WHEN pg_temp.j(s)->>'error' = 'terms_not_accepted' THEN 'PASS' ELSE 'FAIL ' || left(s, 80) END);
    -- proposed control 3: start date locked on a canceled deal too (o6 completed above)
    UPDATE public.org_deals SET status = 'canceled' WHERE organization_id = o6;
    s := pg_temp.call_as(u_sales, format(q10, o6, 'test', 5, 2499, NULL, NULL, 'move', (SELECT version FROM public.org_deals WHERE organization_id = o6), quote_literal((bd + 30)::text) || '::date'));
    r := r || jsonb_build_object('SR_C_start_locked_when_canceled', CASE WHEN pg_temp.j(s)->>'error' = 'start_date_locked' THEN 'PASS' ELSE 'FAIL ' || left(s, 80) END);
    -- ===== C-M1b migrated deals (Alpha/Beta on keepr-test) read as active, contact backfilled =====
    FOR d IN SELECT dd.organization_id FROM public.org_deals dd JOIN public.organizations oo ON oo.id = dd.organization_id
              WHERE oo.name IN ('Test Brokerage Alpha', 'Test Brokerage Beta') LOOP
      s := pg_temp.call_as(u_sales, format('SELECT public.admin_get_org_billing(%L::uuid)', d.organization_id));
      r := r || jsonb_build_object('C_M1b_' || left(d.organization_id::text, 4) || '_state_active_contact', CASE WHEN pg_temp.j(s)->>'state' = 'active'
        AND pg_temp.j(s)->'contact'->>'email' IS NOT NULL THEN 'PASS' ELSE 'FAIL ' || left(s, 60) END);
    END LOOP;

    -- ===== C-T business date (19:00 PT = 02:00 UTC next day) =====
    r := r || jsonb_build_object('C_T1_business_date_1900_pt', CASE WHEN public._billing_business_date('2026-10-20 02:00:00+00') = DATE '2026-10-19' THEN 'PASS' ELSE 'FAIL' END);
    -- the save and the completion follow the one helper. The deal is saved with the real date,
    -- then the helper is pinned to a far date, so a mutant reading current_date reds at any
    -- hour (not only in the evening gap between the UTC and Pacific dates).
    s := pg_temp.call_as(u_sales, format(q10, o2, 'test', 5, 2499, NULL, NULL, 'new', 'NULL', 'NULL::date'));
    s := pg_temp.call_as(u_x, format(qt, o2, 1, tv, tu));
    EXECUTE $h$CREATE OR REPLACE FUNCTION public._billing_business_date(p_at timestamptz DEFAULT now()) RETURNS date
      LANGUAGE sql STABLE SET search_path TO '' AS $x$ SELECT DATE '2030-01-01' $x$$h$;
    s := pg_temp.call_as(u_sales, format(q10, o2, 'test', 5, 2499, NULL, NULL, 'later', 1, quote_literal('2029-12-31') || '::date'));
    r := r || jsonb_build_object('C_T2_save_uses_business_date', CASE WHEN pg_temp.j(s)->>'error' = 'start_date_past' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_x, format(qc, o2, 1, me, co, 'false'));
    r := r || jsonb_build_object('C_T3_completion_uses_business_date', CASE WHEN (pg_temp.j(s)->>'billing_starts_on')::date = DATE '2030-01-01' THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== C-8 catalog =====
    r := r || jsonb_build_object('C_8_no_client_table_access', CASE WHEN NOT has_table_privilege('authenticated', 'public.org_contacts', 'SELECT')
      AND NOT has_table_privilege('anon', 'public.org_contacts', 'SELECT')
      AND NOT has_table_privilege('authenticated', 'public.org_billing_profile', 'SELECT')
      AND NOT has_table_privilege('authenticated', 'public.org_terms_acceptances', 'SELECT') THEN 'PASS' ELSE 'FAIL' END);
    r := r || jsonb_build_object('C_8_anon_no_execute', CASE WHEN NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('broker_get_billing_setup', 'broker_accept_terms', 'broker_complete_billing_setup', 'admin_save_deal',
                        '_org_billing_contact_set', '_billing_business_date', '_billing_normalize_phone', '_billing_org_setup_pending')
      AND has_function_privilege('anon', p.oid, 'EXECUTE')) THEN 'PASS' ELSE 'FAIL' END);
    r := r || jsonb_build_object('C_8_internals_not_authenticated', CASE WHEN NOT has_function_privilege('authenticated', 'public._org_billing_contact_set(uuid,text,text,text,uuid)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public._billing_save_deal(uuid,jsonb,uuid,text,integer)', 'EXECUTE') THEN 'PASS' ELSE 'FAIL' END);
    -- SR required change 2: terms acceptances are append-only for service_role too
    r := r || jsonb_build_object('C_8_terms_append_only_service_role_privs', CASE WHEN has_table_privilege('service_role', 'public.org_terms_acceptances', 'SELECT')
      AND has_table_privilege('service_role', 'public.org_terms_acceptances', 'INSERT')
      AND NOT has_table_privilege('service_role', 'public.org_terms_acceptances', 'UPDATE')
      AND NOT has_table_privilege('service_role', 'public.org_terms_acceptances', 'DELETE')
      AND NOT has_table_privilege('service_role', 'public.org_terms_acceptances', 'TRUNCATE') THEN 'PASS' ELSE 'FAIL' END);
    v_upd := 'not refused'; v_del := 'not refused';
    BEGIN
      SET LOCAL ROLE service_role;
      UPDATE public.org_terms_acceptances SET seats = seats WHERE false;
    EXCEPTION WHEN insufficient_privilege THEN v_upd := 'refused';
    END;
    RESET ROLE;
    BEGIN
      SET LOCAL ROLE service_role;
      DELETE FROM public.org_terms_acceptances WHERE false;
    EXCEPTION WHEN insufficient_privilege THEN v_del := 'refused';
    END;
    RESET ROLE;
    r := r || jsonb_build_object('C_8_terms_service_role_update_delete_refused', CASE WHEN v_upd = 'refused' AND v_del = 'refused' THEN 'PASS' ELSE 'FAIL ' || v_upd || '/' || v_del END);
    -- SR change 1: the 10th argument has no default, so a 9-named-argument call has one candidate
    r := r || jsonb_build_object('C_1_overloads_unambiguous', CASE WHEN
      (SELECT pronargdefaults FROM pg_proc WHERE oid = 'public.admin_save_deal(uuid,text,integer,integer,text,text,uuid,text,integer,date)'::regprocedure) = 0
      AND (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'admin_save_deal') = 2 THEN 'PASS' ELSE 'FAIL' END);

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
  RAISE EXCEPTION 'P4007_RESULT %', v_res;
END
$drv$;
