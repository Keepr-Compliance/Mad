-- BACKLOG-4048 caller check on org_billing_suspended / org_billing_service_off: DB controls.
-- Venue: keepr-test, ONE call, ONE transaction ending in RAISE, so nothing persists.
-- Run after 20261104210000 is applied, or compose it in front (compose.py --with-migration).
-- __MODES__ is replaced with a comma list of quoted mode names. Each mode runs in its own
-- subtransaction: apply the mutation (exact-once replace that raises on 0 or 2+ matches; the md5
-- must change, else MUTATION NOT APPLIED), build fixtures, run every check, roll back.
-- 'base' = the shipped migration, no mutation (every check must PASS).
-- Output: RAISE 'P4048_RESULT {mode: {mutation, pass, fail, reds, cells}}'.
-- Fixtures: auth users p4048-*@example.test, organizations "P4048 *" (is_test).
--
-- Cells:
--  C1a/C1b  admin of another organization asks about a suspended organization: false (both functions)
--  C2a/C2b  member: true (both)          C3 billing-only (unassigned) login: true
--  C4       suspended-licence member: true                      C5 internal staff: true
--  C6       service role, billing_purchase_blocked for a member: true
--  C7       anon: permission denied (42501)
--  C8       ex-member submitter, finalize_submission during suspension: account_suspended
--  C9       other organization's admin adds a submission to its own organization: 1 row
--  C10      other organization's admin, wide submissions edit: no error
--  C11a     null organization: false   C11b service role, user with no organization: false
--  C12a/b   other organization's admin about its own active organization: false (both)
--  C13a/b   session with no request role, about the suspended organization: true (both)
--  C14      grants: helper not executable by PUBLIC/anon/authenticated; both functions
--           executable by authenticated and service_role, not by anon or PUBLIC
--  C15      ex-member submitter moves own row to another organization: submission_owner_fields_locked
--  C16      user who submitted in another organization (C9 gave it a row there) asks about this
--           organization: false (runs after C9)

DO $drv$
DECLARE
  v_modes text[] := ARRAY[__MODES__]::text[];
  v_m text; v_res jsonb := '{}'::jsonb; v_detail text;
BEGIN
  -- run q as role k ('auth' | 'svc' | 'anon') with user u, or with no claims and no role switch ('none')
  EXECUTE $f$CREATE FUNCTION pg_temp.v(k text, u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE r text; rl text := CASE k WHEN 'auth' THEN 'authenticated' WHEN 'svc' THEN 'service_role' ELSE 'anon' END;
  BEGIN
    IF k = 'none' THEN
      PERFORM set_config('request.jwt.claims', '', true);
      PERFORM set_config('request.jwt.claim.sub', '', true);
      PERFORM set_config('request.jwt.claim.role', '', true);
      IF auth.role() IS NOT NULL THEN RETURN 'FIXTURE auth.role not null'; END IF;
      BEGIN EXECUTE q INTO r; EXCEPTION WHEN OTHERS THEN r := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 60); END;
      RETURN coalesce(r, 'null');
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', rl)::text, true);
    PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
    PERFORM set_config('request.jwt.claim.role', rl, true);
    BEGIN
      EXECUTE 'SET LOCAL ROLE ' || rl;
      EXECUTE q INTO r;
      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      r := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 60);
    END;
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);
    RETURN coalesce(r, 'null');
  END $b$$f$;

  -- exact-once text mutation of a function definition; md5 must change
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

  -- the pre-4048 bodies (prosrc md5 22c2a8f2 / 79c10d87); p_which: 'both' | 'service_off'
  EXECUTE $f$CREATE FUNCTION pg_temp.old_bodies(p_which text) RETURNS text LANGUAGE plpgsql AS $b$
  BEGIN
    IF p_which = 'both' THEN
      EXECUTE $x$CREATE OR REPLACE FUNCTION public.org_billing_suspended(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.org_deals d
     WHERE d.organization_id = p_org AND d.status = 'suspended'
  );
$function$$x$;
      IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.org_billing_suspended(uuid)'::regprocedure)
         <> '22c2a8f2df610fef3fba55b9085939fc' THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: suspended body md5'; END IF;
    END IF;
    EXECUTE $x$CREATE OR REPLACE FUNCTION public.org_billing_service_off(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
  -- BACKLOG-4019: suspended OR canceled. Submission and review gates read this.
  SELECT EXISTS (
    SELECT 1 FROM public.org_deals d
     WHERE d.organization_id = p_org AND d.status IN ('suspended', 'canceled')
  );
$function$$x$;
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.org_billing_service_off(uuid)'::regprocedure)
       <> '79c10d873c207522fbf08c0f8e02af64' THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: service_off body md5'; END IF;
    RETURN 'MUTATION APPLIED pre-4048 body: ' || p_which;
  END $b$$f$;

  -- grants check: 'ok' or the list of violations
  EXECUTE $f$CREATE FUNCTION pg_temp.grants() RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE bad text[] := '{}'; f text;
  BEGIN
    IF has_function_privilege('anon', 'public._org_billing_state_visible(uuid)', 'EXECUTE') THEN bad := array_append(bad, 'helper:anon'); END IF;
    IF has_function_privilege('authenticated', 'public._org_billing_state_visible(uuid)', 'EXECUTE') THEN bad := array_append(bad, 'helper:authenticated'); END IF;
    FOREACH f IN ARRAY ARRAY['public.org_billing_suspended(uuid)', 'public.org_billing_service_off(uuid)', 'public._org_billing_state_visible(uuid)'] LOOP
      IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = f::regprocedure AND a.grantee = 0) THEN
        bad := array_append(bad, f || ':PUBLIC');
      END IF;
    END LOOP;
    FOREACH f IN ARRAY ARRAY['public.org_billing_suspended(uuid)', 'public.org_billing_service_off(uuid)'] LOOP
      IF has_function_privilege('anon', f, 'EXECUTE') THEN bad := array_append(bad, f || ':anon'); END IF;
      IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN bad := array_append(bad, f || ':authenticated missing'); END IF;
      IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN bad := array_append(bad, f || ':service_role missing'); END IF;
    END LOOP;
    RETURN CASE WHEN cardinality(bad) = 0 THEN 'ok' ELSE array_to_string(bad, ',') END;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run(p_mode text) RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    c jsonb; mut text := 'none'; exp jsonb; k text; reds text[] := '{}'; npass int := 0;
    o1 uuid := gen_random_uuid(); o2 uuid := gen_random_uuid();
    u_sales uuid := gen_random_uuid(); u_ag uuid := gen_random_uuid(); u_bo uuid := gen_random_uuid();
    u_sa uuid := gen_random_uuid(); u_x uuid := gen_random_uuid(); u_ex uuid := gen_random_uuid();
    u_none uuid := gen_random_uuid();
    v_team uuid; s_ex uuid;
  BEGIN
    mut := CASE p_mode
      WHEN 'base' THEN 'none'
      WHEN 'current' THEN pg_temp.old_bodies('both') || ' (helper unused)'
      WHEN 'M1_grant_only' THEN pg_temp.old_bodies('both')
      WHEN 'M2_no_service_bypass' THEN pg_temp.mut_fn('public._org_billing_state_visible(uuid)',
        $q$OR auth.role() = 'service_role'$q$, '')
      WHEN 'M3_no_submitter' THEN pg_temp.mut_fn('public._org_billing_state_visible(uuid)',
        $q$WHERE s.organization_id = p_org AND s.submitted_by = (SELECT auth.uid()))$q$, 'WHERE false)')
      WHEN 'M4_active_only' THEN pg_temp.mut_fn('public._org_billing_state_visible(uuid)',
        $q$m.user_id = (SELECT auth.uid()))$q$, $q$m.user_id = (SELECT auth.uid()) AND public.member_status_grants_access(m.license_status))$q$)
      WHEN 'M5_any_org' THEN pg_temp.mut_fn('public._org_billing_state_visible(uuid)',
        'WHERE m.organization_id = p_org AND m.user_id', 'WHERE m.user_id')
      -- non-constant divisor: a literal 1/0 is folded at plan time and reds every cell
      WHEN 'M6_raise_for_outsider' THEN pg_temp.mut_fn('public.org_billing_suspended(uuid)',
        'AND public._org_billing_state_visible(p_org);', 'AND (public._org_billing_state_visible(p_org) OR 1/(length(p_org::text) - 36) = 1);')
        || ' | ' || pg_temp.mut_fn('public.org_billing_service_off(uuid)',
        'AND public._org_billing_state_visible(p_org);', 'AND (public._org_billing_state_visible(p_org) OR 1/(length(p_org::text) - 36) = 1);')
      WHEN 'M7_only_suspended_fixed' THEN pg_temp.old_bodies('service_off')
      WHEN 'M8_no_null_role' THEN pg_temp.mut_fn('public._org_billing_state_visible(uuid)',
        'OR auth.role() IS NULL', '')
      WHEN 'M9_or_not_and' THEN pg_temp.mut_fn('public.org_billing_suspended(uuid)',
        'AND public._org_billing_state_visible(p_org);', 'OR public._org_billing_state_visible(p_org);')
        || ' | ' || pg_temp.mut_fn('public.org_billing_service_off(uuid)',
        'AND public._org_billing_state_visible(p_org);', 'OR public._org_billing_state_visible(p_org);')
      WHEN 'M10_helper_granted_authenticated' THEN 'grant'
      WHEN 'M12_suspended_granted_anon' THEN 'grant'
      WHEN 'SR_M13_submitter_any_org' THEN pg_temp.mut_fn('public._org_billing_state_visible(uuid)',
        'WHERE s.organization_id = p_org AND s.submitted_by', 'WHERE s.submitted_by')
      WHEN 'M11_guard_org_unlocked' THEN pg_temp.mut_fn('public.guard_status_history_append_only()',
        'OR NEW.organization_id      IS DISTINCT FROM OLD.organization_id', '')
      ELSE NULL END;
    IF mut IS NULL THEN RAISE EXCEPTION 'unknown mode %', p_mode; END IF;
    IF p_mode = 'M1_grant_only' THEN
      REVOKE EXECUTE ON FUNCTION public.org_billing_suspended(uuid) FROM authenticated;
      REVOKE EXECUTE ON FUNCTION public.org_billing_service_off(uuid) FROM authenticated;
      IF has_function_privilege('authenticated', 'public.org_billing_suspended(uuid)', 'EXECUTE')
         OR has_function_privilege('authenticated', 'public.org_billing_service_off(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'MUTATION NOT APPLIED: authenticated still executes';
      END IF;
      mut := mut || ' | MUTATION APPLIED authenticated EXECUTE taken from both';
    END IF;
    IF p_mode = 'M10_helper_granted_authenticated' THEN
      GRANT EXECUTE ON FUNCTION public._org_billing_state_visible(uuid) TO authenticated;
      IF NOT has_function_privilege('authenticated', 'public._org_billing_state_visible(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'MUTATION NOT APPLIED: helper grant';
      END IF;
      mut := 'MUTATION APPLIED helper EXECUTE granted to authenticated';
    END IF;

    IF p_mode = 'M12_suspended_granted_anon' THEN
      GRANT EXECUTE ON FUNCTION public.org_billing_suspended(uuid) TO anon;
      IF NOT has_function_privilege('anon', 'public.org_billing_suspended(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'MUTATION NOT APPLIED: anon grant';
      END IF;
      mut := 'MUTATION APPLIED org_billing_suspended EXECUTE granted to anon';
    END IF;

    SELECT id INTO v_team FROM public.plans WHERE name = 'Team';
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT x, 'p4048-' || left(x::text, 8) || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM unnest(ARRAY[u_sales, u_ag, u_bo, u_sa, u_x, u_ex, u_none]) x;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    SELECT x, (SELECT a.email FROM auth.users a WHERE a.id = x), 'email', x::text, 'P4048 ' || left(x::text, 4)
      FROM unnest(ARRAY[u_sales, u_ag, u_bo, u_sa, u_x, u_ex, u_none]) x
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.internal_roles (user_id, role_id) SELECT u_sales, ar.id FROM public.admin_roles ar WHERE ar.slug = 'sales';
    INSERT INTO public.organizations (id, name, slug, max_seats, is_test)
    SELECT x, 'P4048 ' || left(x::text, 8), 'p4048-' || left(x::text, 8), 20, true FROM unnest(ARRAY[o1, o2]) x;
    INSERT INTO public.organization_plans (organization_id, plan_id) SELECT x, v_team FROM unnest(ARRAY[o1, o2]) x;
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, created_at) VALUES
      (o1, u_ag, 'agent', 'active', now(), now()), (o1, u_sa, 'agent', 'suspended', now(), now()),
      (o1, u_ex, 'agent', 'active', now(), now()), (o2, u_x, 'admin', 'active', now(), now());
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, created_at, provisioning_metadata)
      VALUES (o1, u_bo, 'agent', 'unassigned', now(), now(), '{"billing_only":"true"}');
    INSERT INTO public.org_deals (organization_id, stripe_mode, plan_id, seats, start_date, status, version)
    SELECT x, 'test', v_team, 5, current_date, 'active', 1 FROM unnest(ARRAY[o1, o2]) x;
    INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, status)
      VALUES (o1, u_ex, 'p4048-ex', 'p4048 address 1', 'uploading') RETURNING id INTO s_ex;
    INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, status)
      VALUES (o1, u_ag, 'p4048-ag', 'p4048 address 2', 'submitted');
    DELETE FROM public.organization_members WHERE organization_id = o1 AND user_id = u_ex;  -- ex-member, own submission kept
    PERFORM public._billing_suspend_org(o1, 'non_payment', 'p4048', u_sales);
    IF NOT EXISTS (SELECT 1 FROM public.org_deals WHERE organization_id = o1 AND status = 'suspended') THEN
      RAISE EXCEPTION 'fixture: o1 not suspended';
    END IF;

    c := jsonb_build_object(
      'C1a', pg_temp.v('auth', u_x, format('SELECT public.org_billing_suspended(%L)::text', o1)),
      'C1b', pg_temp.v('auth', u_x, format('SELECT public.org_billing_service_off(%L)::text', o1)),
      'C2a', pg_temp.v('auth', u_ag, format('SELECT public.org_billing_suspended(%L)::text', o1)),
      'C2b', pg_temp.v('auth', u_ag, format('SELECT public.org_billing_service_off(%L)::text', o1)),
      'C3', pg_temp.v('auth', u_bo, format('SELECT public.org_billing_suspended(%L)::text', o1)),
      'C4', pg_temp.v('auth', u_sa, format('SELECT public.org_billing_suspended(%L)::text', o1)),
      'C5', pg_temp.v('auth', u_sales, format('SELECT public.org_billing_suspended(%L)::text', o1)),
      'C6', pg_temp.v('svc', NULL, format('SELECT public.billing_purchase_blocked(%L)::text', u_ag)),
      'C7', pg_temp.v('anon', NULL, format('SELECT public.org_billing_suspended(%L)::text', o1)),
      'C8', pg_temp.v('auth', u_ex, format($q$SELECT public.finalize_submission(%L, '{}'::jsonb) ->> 'code'$q$, s_ex)),
      'C9', pg_temp.v('auth', u_x, format($q$WITH i AS (INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, status) VALUES (%L, %L, 'p4048-o2', 'p4048 address 3', 'submitted') RETURNING 1) SELECT count(*)::text FROM i$q$, o2, u_x)),
      'C10', pg_temp.v('auth', u_x, $q$WITH u AS (UPDATE public.transaction_submissions SET review_notes = review_notes WHERE property_address LIKE 'p4048%' RETURNING 1) SELECT count(*)::text FROM u$q$),
      'C11a', pg_temp.v('auth', u_ag, 'SELECT public.org_billing_suspended(NULL)::text'),
      'C11b', pg_temp.v('svc', NULL, format('SELECT public.billing_purchase_blocked(%L)::text', u_none)),
      'C12a', pg_temp.v('auth', u_x, format('SELECT public.org_billing_suspended(%L)::text', o2)),
      'C12b', pg_temp.v('auth', u_x, format('SELECT public.org_billing_service_off(%L)::text', o2)),
      'C13a', pg_temp.v('none', NULL, format('SELECT public.org_billing_suspended(%L)::text', o1)),
      'C13b', pg_temp.v('none', NULL, format('SELECT public.org_billing_service_off(%L)::text', o1)),
      'C14', pg_temp.grants(),
      'C15', pg_temp.v('auth', u_ex, format($q$WITH u AS (UPDATE public.transaction_submissions SET organization_id = %L WHERE id = %L RETURNING 1) SELECT count(*)::text FROM u$q$, o2, s_ex)),
      'C16', pg_temp.v('auth', u_x, format('SELECT public.org_billing_suspended(%L)::text', o1)));

    -- expected value per cell; a value starting with '^' is a prefix match
    exp := jsonb_build_object('C1a','false','C1b','false','C2a','true','C2b','true','C3','true','C4','true',
      'C5','true','C6','true','C7','^ERR 42501','C8','account_suspended','C9','1','C10','1',
      'C11a','false','C11b','false','C12a','false','C12b','false','C13a','true','C13b','true',
      'C14','ok','C15','^ERR 42501 submission_owner_fields_locked','C16','false');
    FOR k IN SELECT jsonb_object_keys(exp) ORDER BY 1 LOOP
      IF (CASE WHEN left(exp->>k, 1) = '^' THEN (c->>k) LIKE substr(exp->>k, 2) || '%' ELSE (c->>k) = (exp->>k) END) THEN
        npass := npass + 1;
      ELSE
        reds := reds || k;
      END IF;
    END LOOP;
    RETURN jsonb_build_object('mutation', mut, 'pass', npass, 'fail', cardinality(reds),
                              'total', npass + cardinality(reds), 'reds', to_jsonb(reds), 'cells', c);
  END $b$$f$;

  FOREACH v_m IN ARRAY v_modes LOOP
    BEGIN
      v_detail := pg_temp.run(v_m)::text;
      RAISE EXCEPTION USING ERRCODE = 'P4048', MESSAGE = v_detail;
    EXCEPTION WHEN SQLSTATE 'P4048' THEN
      v_res := v_res || jsonb_build_object(v_m, SQLERRM::jsonb);
    WHEN OTHERS THEN
      v_res := v_res || jsonb_build_object(v_m, 'MODE ERROR ' || SQLSTATE || ' ' || SQLERRM);
    END;
  END LOOP;
  RAISE EXCEPTION 'P4048_RESULT %', v_res::text;
END $drv$;
