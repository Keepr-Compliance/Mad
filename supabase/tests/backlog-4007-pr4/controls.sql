-- BACKLOG-4007 PR-4 DB controls: brokerage contacts, the one billing-only login, and every gate
-- that login must pass or fail.
-- Venue: keepr-test, ONE call, ONE transaction that ends in RAISE, so nothing persists.
-- Run after 20261020180000 is applied, or compose it in front (compose.py --with-migration).
-- __MODES__ is replaced with a comma list of quoted mode names. Each mode runs in its own
-- subtransaction: apply the mutation (exact-once replace that raises on 0 or 2+ matches; the md5
-- of pg_get_functiondef must change, else MUTATION NOT APPLIED), build fixtures, run every
-- check, roll back. 'base' = no mutation (every check must PASS).
-- Output: RAISE 'P4007PR4_RESULT {mode: {mutation, pass, fail, reds}}'.
-- Fixtures: new auth users p4007c-*@example.test, organizations P4007C *, phones 202-555-01xx.

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
    SELECT count(*)::int FROM public.billing_outbox b WHERE b.organization_id = o AND b.kind = 'notify_setup_reminder'
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.seats(o uuid) RETURNS int LANGUAGE sql AS $b$
    SELECT count(*)::int FROM public.organization_members m
     WHERE m.organization_id = o AND public.member_row_holds_seat(m.license_status, m.invitation_expires_at, m.user_id)
  $b$$f$;
  -- count of rows a statement returns for a user, or -1 when refused
  EXECUTE $f$CREATE FUNCTION pg_temp.count_as(u uuid, q text) RETURNS int LANGUAGE plpgsql AS $b$
  DECLARE n int;
  BEGIN
    BEGIN
      PERFORM pg_temp.as_user(u);
      EXECUTE 'SET LOCAL ROLE authenticated';
      EXECUTE 'SELECT count(*)::int FROM (' || q || ') s' INTO n;
      EXECUTE 'RESET ROLE';
      RETURN n;
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      RETURN -1;
    END;
  END $b$$f$;

  -- One matrix cell: run q as u, then roll its effects back. 'allowed' (any result that is not a
  -- refusal), 'denied' (42501), or 'ERR ...' for anything else.
  EXECUTE $f$CREATE FUNCTION pg_temp.cell(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE v jsonb; d text;
  BEGIN
    BEGIN
      PERFORM pg_temp.as_user(u);
      EXECUTE 'SET LOCAL ROLE authenticated';
      EXECUTE q INTO v;
      EXECUTE 'RESET ROLE';
      RAISE EXCEPTION 'CELL_DONE' USING DETAIL = coalesce(v::text, 'null');
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      IF SQLERRM = 'CELL_DONE' THEN
        GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL;
        IF d::jsonb ? 'success' AND d::jsonb ->> 'success' = 'false'
           AND d::jsonb ->> 'error' NOT IN ('billing_login_exists', 'no_billing_login') THEN
          RETURN 'ERR refusal ' || left(d, 60);
        END IF;
        RETURN 'allowed';
      END IF;
      IF SQLSTATE = '42501' THEN RETURN 'denied'; END IF;
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 60);
    END;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE
    lc text := 'public._org_billing_login_create(uuid,uuid)';
    ls text := 'public.org_billing_login_set(uuid,boolean)';
    ac text := 'public.org_billing_contact_login(uuid)';
    sv text := 'public.org_contact_save(uuid,jsonb)';
    cl text := 'public._org_contact_caller(uuid,boolean)';
    cs text := 'public.broker_complete_billing_setup(uuid,integer,jsonb,jsonb,boolean)';
    rv text := 'public.org_contact_remove(uuid,uuid)';
  BEGIN
    CASE m
    WHEN 'base' THEN RETURN 'none';
    -- WRONG BUILD 1: the billing-only login invited with a license ('pending' holds a seat)
    WHEN 'login_licensed' THEN RETURN pg_temp.mut_fn(lc,
      $q$VALUES (p_org, v_email, 'agent', 'unassigned',$q$, $q$VALUES (p_org, v_email, 'agent', 'pending',$q$);
    -- WRONG BUILD 2: Billing opens for any unlicensed member of the brokerage
    WHEN 'access_any_unlicensed' THEN RETURN pg_temp.mut_fn(ac,
      $q$JOIN public.organization_members m ON m.id = c.member_id$q$, $q$JOIN public.organization_members m ON true$q$);
    -- the old billing contact keeps Billing after the contact changes
    WHEN 'access_ignores_removed' THEN RETURN pg_temp.mut_fn(ac,
      $q$c.role = 'billing' AND c.removed_at IS NULL$q$, $q$c.role = 'billing'$q$);
    -- a member given a license later still counts as the billing-only login
    WHEN 'access_ignores_license' THEN RETURN pg_temp.mut_fn(ac,
      $q$
       AND m.license_status = 'unassigned')$q$, ')');
    -- WRONG BUILD 3: "Select existing user" links a member row of ANOTHER brokerage
    WHEN 'cross_org_link' THEN RETURN pg_temp.mut_fn(sv,
      $q$     WHERE m.organization_id = p_org AND m.user_id = v_user$q$, $q$     WHERE m.user_id = v_user$q$);
    -- WRONG BUILD 4: the generic save writes the billing contact itself (no single writer)
    WHEN 'billing_via_generic' THEN RETURN pg_temp.mut_fn(sv,
      $q$  IF v_role = 'billing' THEN$q$, '  IF false THEN');
    -- WRONG BUILD 5: no duplicate-invitation check (a second open invitation for one email)
    WHEN 'no_duplicate_check' THEN RETURN pg_temp.mut_fn(lc,
      $q$  IF EXISTS (SELECT 1 FROM public.organization_members m
              WHERE lower(m.invited_email) = v_email$q$, $q$  IF false AND EXISTS (SELECT 1 FROM public.organization_members m
              WHERE lower(m.invited_email) = v_email$q$);
    -- the billing-only login offered for "Me"
    WHEN 'login_for_me' THEN RETURN pg_temp.mut_fn(cs,
      $q$IF coalesce(p_billing_login, false) AND v_who IS DISTINCT FROM 'other' THEN$q$, 'IF false THEN');
    -- a login refusal undoes setup (no sub-block)
    WHEN 'login_failure_aborts' THEN RETURN pg_temp.mut_fn(cs,
      $q$      v_login := public._org_billing_login_create(p_org, v_uid);
    EXCEPTION WHEN OTHERS THEN$q$, $q$      v_login := public._org_billing_login_create(p_org, v_uid);
      IF v_login ->> 'success' <> 'true' THEN RAISE EXCEPTION 'login refused'; END IF;
    EXCEPTION WHEN division_by_zero THEN$q$);
    -- a login before setup is done
    WHEN 'login_while_draft' THEN RETURN pg_temp.mut_fn(lc,
      $q$IF v_status IS NULL OR v_status = 'draft' THEN$q$, 'IF v_status IS NULL THEN');
    -- caller check: a broker/admin of ANY brokerage may edit this one
    WHEN 'caller_any_org' THEN RETURN pg_temp.mut_fn(cl,
      $q$WHERE m.organization_id = p_org AND m.user_id = auth.uid()
                    AND m.license_status = 'active' AND m.role IN ('broker', 'admin'))$q$, $q$WHERE m.user_id = auth.uid()
                    AND m.license_status = 'active' AND m.role IN ('broker', 'admin'))$q$);
    -- the same for the IT admin branch: an IT admin of ANY brokerage may edit this one's people
    WHEN 'caller_any_org_it' THEN RETURN pg_temp.mut_fn(cl,
      $q$WHERE m.organization_id = p_org AND m.user_id = auth.uid()
                    AND m.license_status = 'active' AND m.role = 'it_admin')$q$, $q$WHERE m.user_id = auth.uid()
                    AND m.license_status = 'active' AND m.role = 'it_admin')$q$);
    -- caller check: IT admin and agents may edit contacts (3855: billing details Broker/Admin only)
    WHEN 'caller_any_role' THEN RETURN pg_temp.mut_fn(cl,
      $q$AND m.license_status = 'active' AND m.role IN ('broker', 'admin')) THEN 'broker'$q$,
      $q$AND m.license_status = 'active') THEN 'broker'$q$);
    -- turning the login off deletes a member who has since been given a license
    WHEN 'disable_deletes_licensed' THEN RETURN pg_temp.mut_fn(ls,
      $q$IF FOUND AND v_m.license_status = 'unassigned' THEN$q$, 'IF FOUND THEN');
    -- the billing contact can be removed
    WHEN 'remove_billing' THEN RETURN pg_temp.mut_fn(rv,
      $q$  IF v_cur.role = 'billing' THEN$q$, '  IF false THEN');
    -- one IT contact rule off
    WHEN 'many_it' THEN RETURN pg_temp.mut_fn(sv,
      $q$  IF v_role = 'it' AND EXISTS$q$, $q$  IF false AND EXISTS$q$);
    -- broker may pick any Keepr user (user directory exposed to a brokerage)
    WHEN 'broker_picks_any_user' THEN RETURN pg_temp.mut_fn(sv,
      $q$IF v_caller <> 'staff' OR NOT EXISTS$q$, $q$IF NOT EXISTS$q$);
    -- 4012 path: a JIT sign-in that upgrades an existing member (the billing-only login would gain a seat)
    WHEN 'jit_upgrades_existing' THEN RETURN pg_temp.mut_fn('public.jit_join_organization(text,text)',
      $q$  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'organization_id', v_org.id, 'role', v_existing, 'already_member', true);$q$,
      $q$  IF FOUND THEN
    UPDATE public.organization_members SET license_status = 'active' WHERE organization_id = v_org.id AND user_id = v_uid;
    RETURN jsonb_build_object('success', true, 'organization_id', v_org.id, 'role', v_existing, 'already_member', true);$q$);
    -- catalog: the access check readable by anon / org_contacts readable by authenticated
    WHEN 'grant_anon_access_check' THEN
      EXECUTE 'GRANT EXECUTE ON FUNCTION public.org_billing_contact_login(uuid) TO anon';
      IF NOT has_function_privilege('anon', 'public.org_billing_contact_login(uuid)', 'EXECUTE') THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: grant missing'; END IF;
      RETURN 'MUTATION APPLIED GRANT EXECUTE org_billing_contact_login TO anon';
    WHEN 'grant_contacts_select' THEN
      EXECUTE 'GRANT SELECT ON public.org_contacts TO authenticated';
      EXECUTE 'CREATE POLICY p4007c_mut ON public.org_contacts FOR SELECT TO authenticated USING (true)';
      IF NOT has_table_privilege('authenticated', 'public.org_contacts', 'SELECT') THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: grant missing'; END IF;
      RETURN 'MUTATION APPLIED GRANT SELECT ON org_contacts TO authenticated (+ open policy)';
    -- BACKLOG-4007 PR-4 fix-up (founder e8571c1f). WRONG BUILD 6: an IT admin treated as a broker
    -- (may set the billing contact and the billing-only login)
    WHEN 'it_admin_as_broker' THEN RETURN pg_temp.mut_fn(cl,
      $q$m.role IN ('broker', 'admin')) THEN 'broker'$q$, $q$m.role IN ('broker', 'admin', 'it_admin')) THEN 'broker'$q$);
    -- a broker (role 'broker') refused People
    WHEN 'broker_refused' THEN RETURN pg_temp.mut_fn(cl,
      $q$m.role IN ('broker', 'admin')) THEN 'broker'$q$, $q$m.role IN ('admin')) THEN 'broker'$q$);
    -- an agent admitted with the IT admin's rights
    WHEN 'agent_admitted' THEN RETURN pg_temp.mut_fn(cl,
      $q$m.role = 'it_admin') THEN 'it_admin'$q$, $q$m.role IN ('it_admin', 'agent')) THEN 'it_admin'$q$);
    -- the billing branch of save does not check the caller kind
    WHEN 'save_billing_any_kind' THEN RETURN pg_temp.mut_fn(sv,
      $q$IF v_role = 'billing' AND v_caller NOT IN ('staff', 'broker') THEN$q$, $q$IF false THEN$q$);
    -- the billing-only login on/off does not check the caller kind
    WHEN 'login_set_any_kind' THEN RETURN pg_temp.mut_fn(ls,
      $q$IF v_caller IS NULL OR v_caller NOT IN ('staff', 'broker') THEN$q$, $q$IF v_caller IS NULL THEN$q$);
    -- an IT admin reads the billing contact's email
    WHEN 'it_admin_sees_billing_email' THEN RETURN pg_temp.mut_fn('public.org_contacts_list(uuid)',
      $q$'email', CASE WHEN c.role = 'billing' AND v_caller = 'it_admin' THEN NULL ELSE c.email END,$q$, $q$'email', c.email,$q$);
    -- F3: a contact change leaves the old billing-only login behind
    WHEN 'contact_change_keeps_login' THEN RETURN pg_temp.mut_fn('public._org_billing_contact_set(uuid,text,text,text,uuid)',
      $q$           AND m.license_status = 'unassigned'
           AND coalesce$q$, $q$           AND false
           AND coalesce$q$);
    ELSE RAISE EXCEPTION 'unknown mode %', m;
    END CASE;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    o1 uuid := gen_random_uuid();  -- main: setup with "Someone else" + billing-only login
    o2 uuid := gen_random_uuid();  -- another brokerage (active deal)
    o3 uuid := gen_random_uuid();  -- duplicate open invitation for the payer email
    o4 uuid := gen_random_uuid();  -- waiting deal (draft): no login before setup
    o5 uuid := gen_random_uuid();  -- suspended deal
    u_sales uuid := gen_random_uuid(); u_b uuid := gen_random_uuid(); u_it uuid := gen_random_uuid();
    u_ag uuid := gen_random_uuid(); u_un uuid := gen_random_uuid(); u_x uuid := gen_random_uuid();
    u_solo uuid := gen_random_uuid(); u_bo uuid := gen_random_uuid(); u_b3 uuid := gen_random_uuid();
    u_b4 uuid := gen_random_uuid(); u_b5 uuid := gen_random_uuid(); u_super uuid := gen_random_uuid();
    u_br uuid := gen_random_uuid(); u_itx uuid := gen_random_uuid();  -- u_itx: IT admin of o2  -- role 'broker' in o1 (founder e8571c1f: People is open to brokers)
    v_who record; v_op record; v_got text;
    v_team uuid; s text; s2 text; n int; n2 int; d record; v_mem uuid; v_tok text; v_cid uuid; v_seats int;
    payer text := 'p4007c-payer-' || left(gen_random_uuid()::text, 6) || '@example.test';
    payer3 text := 'p4007c-payer3-' || left(gen_random_uuid()::text, 6) || '@example.test';
    q10 text := 'SELECT public.admin_save_deal(%L::uuid, %L, %s, %s, %L, %L, NULL::uuid, %L, %s, %s)';
    qt  text := 'SELECT public.broker_accept_terms(%L::uuid, %s, %L, %L)';
    qc  text := 'SELECT public.broker_complete_billing_setup(%L::uuid, %s, %L::jsonb, %L::jsonb, %s)';
    qs  text := 'SELECT public.org_contact_save(%L::uuid, %L::jsonb)';
    qa  text := 'SELECT to_jsonb(public.org_billing_contact_login(%L::uuid))';
    co  text := '{"legal_name":"P4007C Realty LLC","address_line1":"1 Main St","city":"Seattle","region":"WA","postal_code":"98101","country":"US"}';
    tv  text := 'keepr-terms-2026-10'; tu text := 'https://keeprcompliance.com/terms';
  BEGIN
    SELECT id INTO v_team FROM public.plans WHERE name = 'Team';

    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT x, 'p4007c-' || left(x::text, 8) || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM unnest(ARRAY[u_sales, u_b, u_it, u_ag, u_un, u_x, u_solo, u_b3, u_b4, u_b5, u_super, u_br, u_itx]) x;
    -- the payer signs up with the invited address
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (u_bo, payer, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now());
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    SELECT x, 'p4007c-' || left(x::text, 8) || '@example.test', 'email', x::text, 'P4007C ' || left(x::text, 4)
      FROM unnest(ARRAY[u_sales, u_b, u_it, u_ag, u_un, u_x, u_solo, u_b3, u_b4, u_b5, u_super, u_br, u_itx]) x
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.internal_roles (user_id, role_id)
    SELECT x.u, ar.id FROM (VALUES (u_sales, 'sales'), (u_super, 'super-admin')) x(u, slug) JOIN public.admin_roles ar ON ar.slug = x.slug;
    INSERT INTO public.organizations (id, name, slug, max_seats, is_test)
    SELECT x, 'P4007C ' || left(x::text, 8), 'p4007c-' || left(x::text, 8), 10, true FROM unnest(ARRAY[o1, o2, o3, o4, o5]) x;
    INSERT INTO public.organization_plans (organization_id, plan_id) SELECT x, v_team FROM unnest(ARRAY[o1, o2, o3, o4, o5]) x;
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at) VALUES
      (o1, u_b, 'admin', 'active', now()), (o1, u_it, 'it_admin', 'active', now()), (o1, u_ag, 'agent', 'active', now()),
      (o1, u_un, 'agent', 'unassigned', now()), (o1, u_br, 'broker', 'active', now()),
      (o2, u_x, 'admin', 'active', now()), (o2, u_itx, 'it_admin', 'active', now()), (o3, u_b3, 'admin', 'active', now()), (o4, u_b4, 'admin', 'active', now()),
      (o5, u_b5, 'admin', 'active', now());
    -- one submission in o1, so a reader that should see nothing has something to see
    INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address)
    VALUES (o1, u_ag, 'p4007c-local', '1 Test St');

    -- deals: o1, o3, o4 waiting; o2, o5 completed by their admins
    FOR d IN SELECT * FROM (VALUES (o1), (o2), (o3), (o4), (o5)) t(o) LOOP
      s := pg_temp.call_as(u_sales, format(q10, d.o, 'test', 6, 2499, NULL, NULL, 'new deal', 'NULL', 'NULL::date'));
      IF pg_temp.j(s)->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'fixture deal % %', d.o, s; END IF;
    END LOOP;
    s := pg_temp.call_as(u_x, format(qt, o2, 1, tv, tu));
    s := pg_temp.call_as(u_x, format(qc, o2, 1, '{"who":"me","phone":"202-555-0123"}', co, 'false'));
    s := pg_temp.call_as(u_b5, format(qt, o5, 1, tv, tu));
    s := pg_temp.call_as(u_b5, format(qc, o5, 1, '{"who":"me","phone":"202-555-0124"}', co, 'false'));
    UPDATE public.org_deals SET status = 'suspended', suspended_reason = 'non_payment', suspended_at = now() WHERE organization_id = o5;

    -- ===== C-BL0 "Me" + billing-only login refused before any write =====
    s := pg_temp.call_as(u_b, format(qt, o1, 1, tv, tu));
    s := pg_temp.call_as(u_b, format(qc, o1, 1, '{"who":"me","phone":"202-555-0125"}', co, 'true'));
    r := r || jsonb_build_object('C_BL0_login_for_me_refused_deal_waits', CASE WHEN pg_temp.j(s)->>'error' = 'billing_login_needs_someone_else'
      AND (SELECT status FROM public.org_deals WHERE organization_id = o1) = 'draft' THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== C-S4 completion with "Someone else" + login: active, one sync, login unassigned, no seat =====
    v_seats := pg_temp.seats(o1);
    n := pg_temp.rem_rows(o1);
    s := pg_temp.call_as(u_b, format(qc, o1, 1,
      json_build_object('who', 'other', 'name', 'P4007C Payer', 'email', payer, 'phone', '202-555-0126')::text, co, 'true'));
    SELECT * INTO d FROM public.org_deals WHERE organization_id = o1;
    r := r || jsonb_build_object('C_BL1_setup_completes_with_login', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND pg_temp.j(s)->'billing_login'->>'success' = 'true' AND d.status = 'active' AND pg_temp.sync_rows(o1) = 1
      THEN 'PASS' ELSE 'FAIL ' || s END);
    SELECT m.id, m.invitation_token INTO v_mem, v_tok FROM public.organization_members m
     WHERE m.organization_id = o1 AND lower(m.invited_email) = payer;
    r := r || jsonb_build_object('C_S4_login_is_unassigned_agent_linked', CASE WHEN EXISTS (SELECT 1 FROM public.organization_members m
      JOIN public.org_contacts c ON c.member_id = m.id AND c.role = 'billing' AND c.removed_at IS NULL
      WHERE m.id = v_mem AND m.license_status = 'unassigned' AND m.role = 'agent' AND m.user_id IS NULL
        AND c.id = d.billing_contact_id AND c.phone = '+12025550126') THEN 'PASS' ELSE 'FAIL' END);
    r := r || jsonb_build_object('C_S4_seat_count_unchanged', CASE WHEN pg_temp.seats(o1) = v_seats THEN 'PASS'
      ELSE 'FAIL ' || v_seats || '->' || pg_temp.seats(o1) END);
    r := r || jsonb_build_object('C_S4_no_reminder_rows_for_login', CASE WHEN pg_temp.rem_rows(o1) = n THEN 'PASS' ELSE 'FAIL' END);
    r := r || jsonb_build_object('C_S4_token_returned_for_email', CASE WHEN pg_temp.j(s)->'billing_login'->>'token' = v_tok
      AND v_tok IS NOT NULL THEN 'PASS' ELSE 'FAIL' END);

    -- the payer accepts the invitation through the real path; stays unassigned
    s := pg_temp.call_as(u_bo, format('SELECT public.accept_invitation(%L)', v_tok));
    r := r || jsonb_build_object('C_S4_accept_keeps_unassigned', CASE WHEN pg_temp.j(s)->>'license_status' = 'unassigned'
      AND (SELECT user_id FROM public.organization_members WHERE id = v_mem) = u_bo AND pg_temp.seats(o1) = v_seats
      THEN 'PASS' ELSE 'FAIL ' || left(s, 80) END);

    -- ===== 4012 join guard: the billing-only login signs in with Microsoft in the brokerage's tenant =====
    -- JIT finds the existing member row and changes nothing (no seat, still billing-only).
    UPDATE public.organizations SET microsoft_tenant_id = 'p4007c-tid-' || left(o1::text, 8), jit_provisioning_enabled = true,
           default_member_role = 'agent' WHERE id = o1;
    UPDATE public.organization_plans SET feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{"jit_provisioning":{"enabled":true}}'::jsonb
     WHERE organization_id = o1;
    INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
    VALUES ('p4007c-oid-' || left(u_bo::text, 8), u_bo, jsonb_build_object('sub', 'p4007c', 'custom_claims',
            jsonb_build_object('tid', 'p4007c-tid-' || left(o1::text, 8))), 'azure', now(), now());
    INSERT INTO auth.sessions (id, user_id, created_at, updated_at, aal) VALUES (gen_random_uuid(), u_bo, now(), now(), 'aal1');
    INSERT INTO auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method)
    SELECT gen_random_uuid(), s3.id, now(), now(), 'oauth' FROM auth.sessions s3 WHERE s3.user_id = u_bo;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u_bo, 'role', 'authenticated',
        'session_id', (SELECT s3.id FROM auth.sessions s3 WHERE s3.user_id = u_bo LIMIT 1))::text, true);
      PERFORM set_config('request.jwt.claim.sub', u_bo::text, true);
      SET LOCAL ROLE authenticated;
      s := (public.jit_join_organization('azure_ad', 'p4007c-tid-' || left(o1::text, 8)))::text;
      RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
    END;
    r := r || jsonb_build_object('C_J1_jit_leaves_billing_login_alone', CASE WHEN pg_temp.j(s)->>'already_member' = 'true'
      AND (SELECT license_status FROM public.organization_members WHERE id = v_mem) = 'unassigned'
      AND pg_temp.seats(o1) = v_seats AND pg_temp.call_as(u_bo, format(qa, o1)) = 'true' THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== C-A1 the Billing gate =====
    r := r || jsonb_build_object('C_A1_linked_billing_login_true', CASE WHEN pg_temp.call_as(u_bo, format(qa, o1)) = 'true' THEN 'PASS' ELSE 'FAIL ' || pg_temp.call_as(u_bo, format(qa, o1)) END);
    r := r || jsonb_build_object('C_A1_other_unlicensed_member_false', CASE WHEN pg_temp.call_as(u_un, format(qa, o1)) = 'false' THEN 'PASS' ELSE 'FAIL' END);
    r := r || jsonb_build_object('C_A1_agent_admin_false', CASE WHEN pg_temp.call_as(u_ag, format(qa, o1)) = 'false'
      AND pg_temp.call_as(u_b, format(qa, o1)) = 'false' THEN 'PASS' ELSE 'FAIL' END);
    r := r || jsonb_build_object('C_A1_other_org_false', CASE WHEN pg_temp.call_as(u_bo, format(qa, o2)) = 'false' THEN 'PASS' ELSE 'FAIL' END);
    r := r || jsonb_build_object('C_8_access_check_not_anon', CASE WHEN NOT has_function_privilege('anon', 'public.org_billing_contact_login(uuid)', 'EXECUTE')
      THEN 'PASS' ELSE 'FAIL' END);

    -- ===== C-M who may do what in People (founder e8571c1f; BACKLOG-4007 PR-4 fix-up) =====
    -- State here: o1 active, billing contact = payer, billing-only login claimed by u_bo.
    -- Each cell runs as the caller and is rolled back. Expected: People (list, save IT/office/MSP)
    -- = admin, broker, IT admin. Billing contact and the login (on, off) = admin, broker.
    FOR v_who IN SELECT * FROM (VALUES
        ('admin', u_b, true, true), ('broker', u_br, true, true), ('it_admin', u_it, true, false),
        ('agent', u_ag, false, false), ('unlicensed', u_un, false, false), ('billing_login', u_bo, false, false)
      ) t(k, u, people, billing) LOOP
      FOR v_op IN SELECT * FROM (VALUES
          ('list', format('SELECT public.org_contacts_list(%L::uuid)', o1), false),
          ('save_contact', format(qs, o1, '{"role":"it","name":"P4007C Cell IT","email":"p4007c-cell-it@example.test"}'), false),
          ('save_billing', format(qs, o1, json_build_object('role', 'billing', 'name', 'P4007C Payer', 'email', payer, 'phone', '202-555-0126')::text), true),
          ('login_on', format('SELECT public.org_billing_login_set(%L::uuid, true)', o1), true),
          ('login_off', format('SELECT public.org_billing_login_set(%L::uuid, false)', o1), true)
        ) t(op, q, billing_op) LOOP
        v_got := pg_temp.cell(v_who.u, v_op.q);
        r := r || jsonb_build_object('C_M_' || v_who.k || '_' || v_op.op,
          CASE WHEN v_got = CASE WHEN (CASE WHEN v_op.billing_op THEN v_who.billing ELSE v_who.people END) THEN 'allowed' ELSE 'denied' END
               THEN 'PASS' ELSE 'FAIL ' || v_got END);
      END LOOP;
    END LOOP;
    -- the cells left nothing behind
    r := r || jsonb_build_object('C_M_cells_rolled_back', CASE WHEN pg_temp.call_as(u_bo, format(qa, o1)) = 'true'
      AND NOT EXISTS (SELECT 1 FROM public.org_contacts WHERE organization_id = o1 AND email = 'p4007c-cell-it@example.test')
      THEN 'PASS' ELSE 'FAIL' END);
    -- what an IT admin reads: the billing contact's name, not its email or phone; can_edit_billing false
    s := pg_temp.call_as(u_it, format('SELECT public.org_contacts_list(%L::uuid)', o1));
    r := r || jsonb_build_object('C_M_it_admin_list_billing_without_details', CASE WHEN pg_temp.j(s)->>'can_edit' = 'true'
      AND pg_temp.j(s)->>'can_edit_billing' = 'false'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(pg_temp.j(s)->'contacts') e WHERE e->>'role' = 'billing'
                   AND e->>'name' = 'P4007C Payer' AND e->>'email' IS NULL AND e->>'phone' IS NULL)
      THEN 'PASS' ELSE 'FAIL ' || left(s, 80) END);
    s := pg_temp.call_as(u_br, format('SELECT public.org_contacts_list(%L::uuid)', o1));
    r := r || jsonb_build_object('C_M_broker_list_billing_with_details', CASE WHEN pg_temp.j(s)->>'can_edit_billing' = 'true'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(pg_temp.j(s)->'contacts') e WHERE e->>'role' = 'billing'
                   AND e->>'email' = payer AND e->>'phone' = '+12025550126')
      THEN 'PASS' ELSE 'FAIL ' || left(s, 80) END);
    -- named controls (brief): a broker adds an IT contact (kept; removed again below)
    s := pg_temp.call_as(u_br, format(qs, o1, '{"role":"it","name":"P4007C Broker IT","email":"p4007c-broker-it@example.test"}'));
    v_cid := (pg_temp.j(s)->>'id')::uuid;
    r := r || jsonb_build_object('C_M_broker_adds_it_contact', CASE WHEN EXISTS (SELECT 1 FROM public.org_contacts c
      WHERE c.id = v_cid AND c.role = 'it' AND c.created_by = u_br AND c.removed_at IS NULL) THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_it, format('SELECT public.org_contact_remove(%L::uuid, %L::uuid)', o1, v_cid));
    r := r || jsonb_build_object('C_M_it_admin_removes_it_contact', CASE WHEN pg_temp.j(s)->>'success' = 'true' THEN 'PASS' ELSE 'FAIL ' || s END);
    -- an IT admin cannot set the billing contact: refused, and the contact is unchanged
    s := pg_temp.call_as(u_it, format(qs, o1, '{"role":"billing","name":"P4007C IT Payer","email":"p4007c-itpayer@example.test","phone":"202-555-0132"}'));
    r := r || jsonb_build_object('C_M_it_admin_cannot_set_billing_contact', CASE WHEN s LIKE 'ERR 42501%'
      AND (SELECT billing_contact_email FROM public.org_deals WHERE organization_id = o1) = payer THEN 'PASS' ELSE 'FAIL ' || left(s, 60) END);

    -- ===== RLS: what the billing-only login can read directly =====
    r := r || jsonb_build_object('C_RLS_contacts_deals_log_refused', CASE WHEN
      pg_temp.count_as(u_bo, 'SELECT 1 FROM public.org_contacts') = -1
      AND pg_temp.count_as(u_bo, 'SELECT 1 FROM public.org_deals') = -1
      AND pg_temp.count_as(u_bo, 'SELECT 1 FROM public.billing_change_log') = -1 THEN 'PASS'
      ELSE 'FAIL ' || pg_temp.count_as(u_bo, 'SELECT 1 FROM public.org_contacts') END);
    r := r || jsonb_build_object('C_RLS_no_submissions', CASE WHEN
      pg_temp.count_as(u_bo, format('SELECT 1 FROM public.transaction_submissions WHERE organization_id = %L', o1)) = 0
      AND pg_temp.count_as(u_ag, format('SELECT 1 FROM public.transaction_submissions WHERE organization_id = %L', o1)) = 1
      THEN 'PASS' ELSE 'FAIL' END);
    r := r || jsonb_build_object('C_RLS_member_list_own_row_only', CASE WHEN
      pg_temp.count_as(u_bo, format('SELECT 1 FROM public.organization_members WHERE organization_id = %L', o1)) = 1
      AND pg_temp.count_as(u_bo, format('SELECT 1 FROM public.users WHERE id <> %L', u_bo)) = 0
      THEN 'PASS' ELSE 'FAIL ' || pg_temp.count_as(u_bo, format('SELECT 1 FROM public.organization_members WHERE organization_id = %L', o1)) END);
    r := r || jsonb_build_object('C_RLS_no_checklist_templates', CASE WHEN
      pg_temp.count_as(u_bo, 'SELECT 1 FROM public.checklist_templates WHERE organization_id IS NOT NULL') = 0 THEN 'PASS' ELSE 'FAIL' END);
    r := r || jsonb_build_object('C_RLS_contact_rpcs_refused', CASE WHEN
      pg_temp.call_as(u_bo, format('SELECT public.org_contacts_list(%L::uuid)', o1)) LIKE 'ERR 42501%'
      AND pg_temp.call_as(u_bo, format('SELECT public.broker_get_billing_setup(%L::uuid)', o1)) LIKE 'ERR 42501%'
      AND pg_temp.call_as(u_bo, format('SELECT public.org_billing_login_set(%L::uuid, false)', o1)) LIKE 'ERR 42501%'
      THEN 'PASS' ELSE 'FAIL' END);
    -- a client invite by the billing-only login is refused (not an admin)
    s := pg_temp.call_as(u_bo, format($q$INSERT INTO public.organization_members (organization_id, invited_email, role, license_status,
      invitation_token, invitation_expires_at, invited_by, provisioned_by, group_sync_enabled)
      VALUES (%L::uuid, 'p4007c-inv@example.test', 'agent', 'pending', md5(random()::text), now() + interval '7 days', %L::uuid, 'invite', false)
      RETURNING to_jsonb(true)$q$, o1, u_bo));
    r := r || jsonb_build_object('C_RLS_billing_login_cannot_invite', CASE WHEN s LIKE 'ERR%' THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== one billing-only login per brokerage =====
    s := pg_temp.call_as(u_b, format('SELECT public.org_billing_login_set(%L::uuid, true)', o1));
    r := r || jsonb_build_object('C_BL2_second_login_refused', CASE WHEN pg_temp.j(s)->>'error' = 'billing_login_exists' THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== a license assigned later: not billing-only any more =====
    UPDATE public.organization_members SET license_status = 'active' WHERE id = v_mem;
    r := r || jsonb_build_object('C_A1_licensed_later_false', CASE WHEN pg_temp.call_as(u_bo, format(qa, o1)) = 'false' THEN 'PASS' ELSE 'FAIL' END);
    -- turning the login off keeps a licensed member, unlinks it
    s := pg_temp.call_as(u_b, format('SELECT public.org_billing_login_set(%L::uuid, false)', o1));
    r := r || jsonb_build_object('C_BL3_off_keeps_licensed_member', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND EXISTS (SELECT 1 FROM public.organization_members WHERE id = v_mem)
      AND (SELECT member_id FROM public.org_contacts WHERE id = d.billing_contact_id) IS NULL THEN 'PASS' ELSE 'FAIL ' || s END);
    -- back to billing-only for the next checks
    DELETE FROM public.organization_members WHERE id = v_mem;
    s := pg_temp.call_as(u_sales, format('SELECT public.org_billing_login_set(%L::uuid, true)', o1));
    SELECT m.id, m.invitation_token INTO v_mem, v_tok FROM public.organization_members m
     WHERE m.organization_id = o1 AND lower(m.invited_email) = payer;
    r := r || jsonb_build_object('C_BL4_staff_can_turn_login_on', CASE WHEN pg_temp.j(s)->>'success' = 'true' AND v_mem IS NOT NULL
      THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_bo, format('SELECT public.accept_invitation(%L)', v_tok));
    -- turning it off deletes the still-unassigned login and closes Billing
    s := pg_temp.call_as(u_b, format('SELECT public.org_billing_login_set(%L::uuid, false)', o1));
    r := r || jsonb_build_object('C_BL5_off_deletes_unassigned_login', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND NOT EXISTS (SELECT 1 FROM public.organization_members WHERE id = v_mem)
      AND pg_temp.call_as(u_bo, format(qa, o1)) = 'false' THEN 'PASS' ELSE 'FAIL ' || s END);
    -- on again, accepted, then the billing contact changes to another person: Billing closes
    s := pg_temp.call_as(u_b, format('SELECT public.org_billing_login_set(%L::uuid, true)', o1));
    SELECT m.invitation_token INTO v_tok FROM public.organization_members m WHERE m.organization_id = o1 AND lower(m.invited_email) = payer;
    s := pg_temp.call_as(u_bo, format('SELECT public.accept_invitation(%L)', v_tok));
    n := CASE WHEN pg_temp.call_as(u_bo, format(qa, o1)) = 'true' THEN 1 ELSE 0 END;
    s := pg_temp.call_as(u_b, format(qs, o1, '{"role":"billing","name":"P4007C New Payer","email":"p4007c-newpayer@example.test","phone":"202-555-0127"}'));
    SELECT * INTO d FROM public.org_deals WHERE organization_id = o1;
    r := r || jsonb_build_object('C_A1_contact_changed_closes_billing', CASE WHEN n = 1 AND pg_temp.j(s)->>'success' = 'true'
      AND pg_temp.call_as(u_bo, format(qa, o1)) = 'false' THEN 'PASS' ELSE 'FAIL ' || n || ' ' || s END);
    -- C-W1 (single writer): the billing contact row and the deal columns agree
    r := r || jsonb_build_object('C_W1_billing_save_single_writer', CASE WHEN EXISTS (SELECT 1 FROM public.org_contacts c
      WHERE c.id = d.billing_contact_id AND c.email = 'p4007c-newpayer@example.test' AND c.phone = '+12025550127'
        AND d.billing_contact_email = c.email AND d.billing_contact_name = c.full_name AND c.removed_at IS NULL)
      AND (SELECT count(*) FROM public.org_contacts WHERE organization_id = o1 AND role = 'billing' AND removed_at IS NULL) = 1
      AND pg_temp.sync_rows(o1) = 1 THEN 'PASS' ELSE 'FAIL' END);
    s := pg_temp.call_as(u_b, format(qs, o1, '{"role":"billing","name":"X","email":"p4007c-x2@example.test"}'));
    r := r || jsonb_build_object('C_W2_billing_contact_needs_phone', CASE WHEN pg_temp.j(s)->>'error' = 'invalid_phone' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_b4, format(qs, o4, '{"role":"billing","name":"X","email":"p4007c-x3@example.test","phone":"202-555-0128"}'));
    r := r || jsonb_build_object('C_W3_billing_contact_waits_for_setup', CASE WHEN pg_temp.j(s)->>'error' = 'billing_set_in_setup' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_b, format('SELECT public.org_contact_remove(%L::uuid, %L::uuid)', o1, d.billing_contact_id));
    r := r || jsonb_build_object('C_W4_billing_contact_not_removable', CASE WHEN pg_temp.j(s)->>'error' = 'billing_contact_required' THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== F3: the contact change above took the old billing-only login with it =====
    r := r || jsonb_build_object('C_F3_old_login_deleted_on_change', CASE WHEN
      NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = o1
                   AND (m.user_id = u_bo OR lower(m.invited_email) = payer))
      AND (SELECT count(*) FROM public.organization_members m WHERE m.organization_id = o1
            AND m.provisioning_metadata ->> 'billing_only' = 'true') = 0
      AND EXISTS (SELECT 1 FROM public.billing_change_log l WHERE l.organization_id = o1
                   AND l.action = 'billing_login_removed' AND l.detail ->> 'reason' = 'contact_changed')
      THEN 'PASS' ELSE 'FAIL' END);
    -- the contact back to the first person: the login can be given again
    s := pg_temp.call_as(u_b, format(qs, o1, json_build_object('role', 'billing', 'name', 'P4007C Payer', 'email', payer, 'phone', '202-555-0126')::text));
    s2 := pg_temp.call_as(u_b, format('SELECT public.org_billing_login_set(%L::uuid, true)', o1));
    r := r || jsonb_build_object('C_F3_login_given_again_after_return', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND pg_temp.j(s2)->>'success' = 'true'
      AND (SELECT count(*) FROM public.organization_members m WHERE m.organization_id = o1
            AND m.provisioning_metadata ->> 'billing_only' = 'true') = 1 THEN 'PASS' ELSE 'FAIL ' || s || ' | ' || s2 END);
    -- a licensed member linked from the old contact is kept on a change (not billing-only any more)
    SELECT m.id, m.invitation_token INTO v_mem, v_tok FROM public.organization_members m WHERE m.organization_id = o1 AND lower(m.invited_email) = payer;
    s := pg_temp.call_as(u_bo, format('SELECT public.accept_invitation(%L)', v_tok));
    UPDATE public.organization_members SET license_status = 'active' WHERE id = v_mem;
    s := pg_temp.call_as(u_b, format(qs, o1, '{"role":"billing","name":"P4007C New Payer","email":"p4007c-newpayer@example.test","phone":"202-555-0127"}'));
    r := r || jsonb_build_object('C_F3_licensed_member_kept_on_change', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND EXISTS (SELECT 1 FROM public.organization_members WHERE id = v_mem AND user_id = u_bo) THEN 'PASS' ELSE 'FAIL ' || s END);
    -- that member's license taken away later (set_member_license 'unassign', the real path): the
    -- removed contact row still links it, and Billing stays closed (the removed_at term)
    s := pg_temp.call_as(u_b, format($q$SELECT public.set_member_license(%L::uuid, 'unassign')$q$, v_mem));
    r := r || jsonb_build_object('C_F3_unassigned_again_old_contact_no_billing', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND (SELECT license_status FROM public.organization_members WHERE id = v_mem) = 'unassigned'
      AND pg_temp.call_as(u_bo, format(qa, o1)) = 'false' THEN 'PASS' ELSE 'FAIL ' || s || ' ' || pg_temp.call_as(u_bo, format(qa, o1)) END);

    -- ===== gates: draft, suspended, duplicate =====
    s := pg_temp.call_as(u_b4, format('SELECT public.org_billing_login_set(%L::uuid, true)', o4));
    r := r || jsonb_build_object('C_G1_no_login_before_setup', CASE WHEN pg_temp.j(s)->>'error' IN ('billing_setup_incomplete')
      AND NOT EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = o4 AND license_status = 'unassigned') THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_b5, format('SELECT public.org_billing_login_set(%L::uuid, true)', o5));
    r := r || jsonb_build_object('C_G2_no_login_while_suspended', CASE WHEN pg_temp.j(s)->>'error' = 'account_suspended'
      AND NOT EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = o5 AND license_status = 'unassigned') THEN 'PASS' ELSE 'FAIL ' || s END);
    -- an open invitation for the payer email elsewhere: setup completes, login reported, not created
    s := pg_temp.call_as(u_super, format($q$SELECT public.admin_invite_user(%L::uuid, %L, 'agent', %L::uuid, 'trial', NULL)$q$, o2, payer3, u_super));
    IF pg_temp.j(s)->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'fixture invite o2 %', s; END IF;
    s := pg_temp.call_as(u_b3, format(qt, o3, 1, tv, tu));
    s := pg_temp.call_as(u_b3, format(qc, o3, 1,
      json_build_object('who', 'other', 'name', 'P4007C Payer3', 'email', payer3, 'phone', '202-555-0129')::text, co, 'true'));
    r := r || jsonb_build_object('C_G3_duplicate_invite_reported_setup_done', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND pg_temp.j(s)->'billing_login'->>'error' = 'duplicate_invitation'
      AND (SELECT status FROM public.org_deals WHERE organization_id = o3) = 'active' AND pg_temp.sync_rows(o3) = 1
      AND NOT EXISTS (SELECT 1 FROM public.organization_members WHERE organization_id = o3 AND lower(invited_email) = payer3)
      THEN 'PASS' ELSE 'FAIL ' || s END);
    -- full brokerage: the billing-only login still goes in (holds no seat)
    UPDATE public.organizations SET max_seats = pg_temp.seats(o2) WHERE id = o2;
    s := pg_temp.call_as(u_x, format(qs, o2, '{"role":"billing","name":"P4007C Payer2","email":"p4007c-payer2@example.test","phone":"202-555-0130"}'));
    s := pg_temp.call_as(u_x, format('SELECT public.org_billing_login_set(%L::uuid, true)', o2));
    r := r || jsonb_build_object('C_S4_full_brokerage_login_allowed', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND pg_temp.seats(o2) = (SELECT max_seats FROM public.organizations WHERE id = o2) THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== contacts: who may edit =====
    -- (an IT admin may now: founder e8571c1f; see C_M_*)
    s2 := pg_temp.call_as(u_ag, format(qs, o1, '{"role":"it","name":"P4007C IT","email":"p4007c-it@example.test"}'));
    r := r || jsonb_build_object('C_C1_agent_refused', CASE WHEN s2 LIKE 'ERR 42501%' THEN 'PASS' ELSE 'FAIL ' || left(s2, 40) END);
    s := pg_temp.call_as(u_x, format(qs, o1, '{"role":"it","name":"P4007C IT","email":"p4007c-it@example.test"}'));
    s2 := pg_temp.call_as(u_x, format('SELECT public.org_contacts_list(%L::uuid)', o1));
    s2 := pg_temp.call_as(u_itx, format(qs, o1, '{"role":"it","name":"P4007C IT","email":"p4007c-it@example.test"}'));
    r := r || jsonb_build_object('C_C1_other_org_it_admin_refused', CASE WHEN s2 LIKE 'ERR 42501%'
      AND pg_temp.call_as(u_itx, format('SELECT public.org_contacts_list(%L::uuid)', o1)) LIKE 'ERR 42501%' THEN 'PASS' ELSE 'FAIL ' || left(s2, 60) END);
    s2 := pg_temp.call_as(u_x, format('SELECT public.org_contacts_list(%L::uuid)', o1));
    r := r || jsonb_build_object('C_C1_other_org_admin_refused', CASE WHEN s LIKE 'ERR 42501%' AND s2 LIKE 'ERR 42501%' THEN 'PASS' ELSE 'FAIL ' || left(s, 60) END);

    -- ===== contacts: create new =====
    s := pg_temp.call_as(u_b, format(qs, o1, '{"role":"it","name":"P4007C IT","email":"P4007C-IT@example.test","phone":"(202) 555-0131"}'));
    v_cid := (pg_temp.j(s)->>'id')::uuid;
    r := r || jsonb_build_object('C_C2_it_contact_saved', CASE WHEN EXISTS (SELECT 1 FROM public.org_contacts c WHERE c.id = v_cid
      AND c.role = 'it' AND c.email = 'p4007c-it@example.test' AND c.phone = '+12025550131' AND c.member_id IS NULL AND c.created_by = u_b)
      THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_b, format(qs, o1, '{"role":"it","name":"P4007C IT2","email":"p4007c-it2@example.test"}'));
    r := r || jsonb_build_object('C_C3_one_it_contact', CASE WHEN pg_temp.j(s)->>'error' = 'it_contact_exists' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_b, format(qs, o1, json_build_object('id', v_cid, 'role', 'it', 'name', 'P4007C IT Renamed', 'email', 'p4007c-it@example.test')::text));
    r := r || jsonb_build_object('C_C3_it_contact_editable', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND (SELECT full_name FROM public.org_contacts WHERE id = v_cid) = 'P4007C IT Renamed' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_b, format(qs, o1, '{"role":"office","name":"P4007C Office A","email":"p4007c-oa@example.test"}'));
    s2 := pg_temp.call_as(u_b, format(qs, o1, '{"role":"office","name":"P4007C Office B","email":"p4007c-ob@example.test"}'));
    r := r || jsonb_build_object('C_C4_many_office_contacts', CASE WHEN pg_temp.j(s)->>'success' = 'true' AND pg_temp.j(s2)->>'success' = 'true' THEN 'PASS' ELSE 'FAIL ' || s || s2 END);
    s := pg_temp.call_as(u_b, format(qs, o1, '{"role":"office","name":"P4007C Office A","email":"p4007c-oa@example.test"}'));
    r := r || jsonb_build_object('C_C4_same_email_same_role_refused', CASE WHEN pg_temp.j(s)->>'error' = 'contact_exists' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_b, format(qs, o1, '{"role":"msp","name":"P4007C MSP","email":"p4007c-msp@example.test"}'));
    r := r || jsonb_build_object('C_C5_msp_needs_company', CASE WHEN pg_temp.j(s)->>'error' = 'company_name_required' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_b, format(qs, o1, '{"role":"msp","name":"P4007C MSP","email":"p4007c-msp@example.test","company_name":"P4007C IT Co"}'));
    r := r || jsonb_build_object('C_C5_msp_saved', CASE WHEN pg_temp.j(s)->>'success' = 'true' THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_b, format(qs, o1, '{"role":"office","name":"P4007C Bad","email":"p4007c-bad@example.test","phone":"12"}'));
    s2 := pg_temp.call_as(u_b, format(qs, o1, '{"role":"office","name":"P4007C Bad","email":"not-an-email"}'));
    r := r || jsonb_build_object('C_C6_bad_phone_email_refused', CASE WHEN pg_temp.j(s)->>'error' = 'invalid_phone' AND pg_temp.j(s2)->>'error' = 'contact_email_required' THEN 'PASS' ELSE 'FAIL ' || s || s2 END);
    -- an MSP person invited first (staff invite, it_admin) is linked by email
    s := pg_temp.call_as(u_super, format($q$SELECT public.admin_invite_user(%L::uuid, 'p4007c-msp2@example.test', 'it_admin', %L::uuid, 'trial', NULL)$q$, o1, u_super));
    IF pg_temp.j(s)->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'fixture invite o1 %', s; END IF;
    s := pg_temp.call_as(u_sales, format(qs, o1, '{"role":"msp","name":"P4007C MSP2","email":"p4007c-msp2@example.test","company_name":"P4007C IT Co"}'));
    r := r || jsonb_build_object('C_C7_invited_msp_linked_by_email', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND (pg_temp.j(s)->>'member_id')::uuid = (SELECT id FROM public.organization_members WHERE organization_id = o1 AND invited_email = 'p4007c-msp2@example.test')
      THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== contacts: select existing user =====
    s := pg_temp.call_as(u_b, format(qs, o1, json_build_object('role', 'office', 'user_id', u_ag)::text));
    r := r || jsonb_build_object('C_E1_member_linked', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND (pg_temp.j(s)->>'member_id')::uuid = (SELECT id FROM public.organization_members WHERE organization_id = o1 AND user_id = u_ag)
      AND EXISTS (SELECT 1 FROM public.org_contacts c WHERE c.id = (pg_temp.j(s)->>'id')::uuid AND c.email = 'p4007c-' || left(u_ag::text, 8) || '@example.test')
      THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_b, format(qs, o1, json_build_object('role', 'office', 'user_id', u_x)::text));
    s2 := pg_temp.call_as(u_b, format(qs, o1, json_build_object('role', 'office', 'user_id', u_solo)::text));
    r := r || jsonb_build_object('C_E2_broker_picks_own_members_only', CASE WHEN pg_temp.j(s)->>'error' = 'user_not_found'
      AND pg_temp.j(s2)->>'error' = 'user_not_found' THEN 'PASS' ELSE 'FAIL ' || s || ' | ' || s2 END);
    s := pg_temp.call_as(u_sales, format(qs, o1, json_build_object('role', 'office', 'user_id', u_x)::text));
    r := r || jsonb_build_object('C_E3_staff_other_brokerage_refused', CASE WHEN pg_temp.j(s)->>'error' = 'user_in_other_brokerage'
      AND NOT EXISTS (SELECT 1 FROM public.org_contacts c WHERE c.organization_id = o1 AND c.email LIKE 'p4007c-' || left(u_x::text, 8) || '%')
      THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sales, format(qs, o1, json_build_object('role', 'office', 'user_id', u_solo)::text));
    r := r || jsonb_build_object('C_E4_staff_no_brokerage_user_contact_only', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND pg_temp.j(s)->>'member_id' IS NULL THEN 'PASS' ELSE 'FAIL ' || s END);
    s := pg_temp.call_as(u_sales, format('SELECT public.admin_search_users_for_contact(%L::uuid, %L)', o1, 'p4007c-' || left(u_x::text, 8)));
    s2 := pg_temp.call_as(u_b, format('SELECT public.admin_search_users_for_contact(%L::uuid, %L)', o1, 'p4007c'));
    r := r || jsonb_build_object('C_E5_staff_search_marks_status_broker_refused', CASE WHEN pg_temp.j(s)->'users'->0->>'status' = 'other_brokerage'
      AND s2 LIKE 'ERR 42501%' THEN 'PASS' ELSE 'FAIL ' || left(s, 80) || ' | ' || left(s2, 40) END);

    -- ===== list + remove =====
    s := pg_temp.call_as(u_b, format('SELECT public.org_contacts_list(%L::uuid)', o1));
    r := r || jsonb_build_object('C_L1_broker_lists_contacts_and_members', CASE WHEN jsonb_array_length(pg_temp.j(s)->'contacts') >= 6
      AND jsonb_array_length(pg_temp.j(s)->'members') >= 3 AND pg_temp.j(s)->>'can_edit' = 'true' THEN 'PASS' ELSE 'FAIL ' || left(s, 80) END);
    s := pg_temp.call_as(u_b, format('SELECT public.org_contact_remove(%L::uuid, %L::uuid)', o1, v_cid));
    s2 := pg_temp.call_as(u_b, format('SELECT public.org_contacts_list(%L::uuid)', o1));
    r := r || jsonb_build_object('C_L2_removed_contact_gone', CASE WHEN pg_temp.j(s)->>'success' = 'true'
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pg_temp.j(s2)->'contacts') e WHERE (e->>'id')::uuid = v_cid) THEN 'PASS' ELSE 'FAIL ' || s END);
    r := r || jsonb_build_object('C_L3_change_log_written', CASE WHEN
      (SELECT count(*) FROM public.billing_change_log WHERE organization_id = o1 AND action = 'contact_saved') >= 6
      AND EXISTS (SELECT 1 FROM public.billing_change_log WHERE organization_id = o1 AND action = 'contact_removed')
      AND EXISTS (SELECT 1 FROM public.billing_change_log WHERE organization_id = o1 AND action = 'billing_login_added')
      AND EXISTS (SELECT 1 FROM public.billing_change_log WHERE organization_id = o1 AND action = 'billing_login_removed') THEN 'PASS' ELSE 'FAIL' END);

    -- ===== catalog =====
    r := r || jsonb_build_object('C_8_catalog', CASE WHEN
      NOT has_table_privilege('authenticated', 'public.org_contacts', 'SELECT')
      AND NOT has_function_privilege('anon', 'public.org_contact_save(uuid,jsonb)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.org_contacts_list(uuid)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.org_billing_login_set(uuid,boolean)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public._org_billing_login_create(uuid,uuid)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public._org_contact_caller(uuid,boolean)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public._org_user_in_other_brokerage(uuid,uuid)', 'EXECUTE')
      AND (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
            AND p.proname IN ('org_contacts_list', 'org_contact_save', 'org_contact_remove', 'org_billing_login_set',
                              'org_billing_contact_login', 'admin_search_users_for_contact', '_org_billing_login_create',
                              '_org_contact_caller', '_org_user_in_other_brokerage')
            AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')) = 0
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
  RAISE EXCEPTION 'P4007PR4_RESULT %', v_res;
END
$drv$;
