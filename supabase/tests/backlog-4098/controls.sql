-- BACKLOG-4098 DB controls (public.admin_list_organizations(): is_personal / is_test keys, guard, grants).
-- Venue: keepr-test, ONE call, ONE transaction ending in RAISE, so nothing persists. Run with
-- compose.py --with-migration (the migration is applied TWICE in front), or after 20261031160000 is
-- applied.
-- __MODES__ is replaced with a comma list of quoted mode names. Each mode runs in its own
-- subtransaction: apply the mutation (its effect is checked; otherwise MUTATION NOT APPLIED), build
-- fixtures, run every check, roll back. 'base' = no mutation (every check must PASS).
-- Fixtures (invented; ids are built at run time from fx(n), emails p4098-<n>@example.test):
--   users  1 internal (holds an internal role), 2 authenticated with no internal role,
--          3 personal owner, 4 second member of the personal org, 5 sole member of the brokerage
--   orgs   11 brokerage with ONE member, not test, tier team
--          12 personal org with TWO members (owner 3 + 4), not test, tier team
--          13 brokerage, plan tier individual, not personal, no members
--          14 test brokerage, tier enterprise
-- Wrong implementations these fixtures separate: is_personal from member_count <= 1 (11 and 12
-- flip), is_personal from plan tier individual (12 and 13 flip).
-- Output: RAISE 'P4098_RESULT {mode: {mutation, pass, fail, reds}}'.

DO $drv$
DECLARE
  v_modes text[] := ARRAY[__MODES__]::text[];
  v_m text;
  v_mut text;
  v_res jsonb := '{}'::jsonb;
  v_r jsonb;
  v_detail text;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
    SELECT ('00000000-0000-4098-8000-' || lpad(n::text, 12, '0'))::uuid
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);
  END $b$$f$;

  -- call the function as a role ('authenticated' with a user, or 'anon'): the jsonb reply as text,
  -- or 'ERR <sqlstate> ...'
  EXECUTE $f$CREATE FUNCTION pg_temp.call_as(u uuid, r text DEFAULT 'authenticated') RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE j jsonb;
  BEGIN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
      PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
      PERFORM set_config('request.jwt.claim.role', r, true);
      EXECUTE format('SET LOCAL ROLE %I', r);
      EXECUTE 'SELECT public.admin_list_organizations()' INTO j;
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN j::text;
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
    END;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.pass(ok boolean, detail text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || coalesce(detail, 'null') END
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.chk(actual text, pattern text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN actual LIKE pattern THEN 'PASS' ELSE 'FAIL ' || left(coalesce(actual, 'null'), 120) END
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.def() RETURNS text LANGUAGE sql AS $b$
    SELECT pg_get_functiondef('public.admin_list_organizations()'::regprocedure)
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.acl() RETURNS text LANGUAGE sql AS $b$
    SELECT coalesce(proacl::text, 'null') || ' definer=' || prosecdef || ' cfg=' || coalesce(proconfig::text, 'null')
      FROM pg_proc WHERE oid = 'public.admin_list_organizations()'::regprocedure
  $b$$f$;

  -- replace exactly one occurrence of a fragment in the live definition and re-create it
  EXECUTE $f$CREATE FUNCTION pg_temp.rewrite(old_frag text, new_frag text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE d text := pg_temp.def(); n int; d2 text;
  BEGIN
    n := (length(d) - length(replace(d, old_frag, ''))) / length(old_frag);
    IF n <> 1 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: fragment matched % times', n; END IF;
    d2 := replace(d, old_frag, new_frag);
    EXECUTE d2;
    IF md5(pg_temp.def()) = md5(d) OR position(new_frag IN pg_temp.def()) = 0 THEN
      RAISE EXCEPTION 'MUTATION NOT APPLIED: definition unchanged';
    END IF;
    RETURN 'MUTATION APPLIED ' || old_frag || ' -> ' || new_frag;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE before text; after text;
  BEGIN
    IF m = 'base' THEN RETURN 'none'; END IF;
    before := pg_temp.acl();
    IF m = 'flag_by_members' THEN
      RETURN pg_temp.rewrite($q$'is_personal', (o.personal_owner_user_id IS NOT NULL)$q$,
        $q$'is_personal', ((SELECT count(*) FROM organization_members om2 WHERE om2.organization_id = o.id) <= 1)$q$);
    ELSIF m = 'flag_by_tier' THEN
      RETURN pg_temp.rewrite($q$'is_personal', (o.personal_owner_user_id IS NOT NULL)$q$,
        $q$'is_personal', coalesce(p.tier = 'individual', false)$q$);
    ELSIF m = 'leak_id' THEN
      RETURN pg_temp.rewrite($q$'is_test', o.is_test$q$,
        $q$'is_test', o.is_test, 'owner_ref', o.personal_owner_user_id$q$);
    ELSIF m = 'no_guard' THEN
      RETURN pg_temp.rewrite('IF NOT has_internal_role(auth.uid()) THEN', 'IF false THEN');
    ELSIF m = 'grant_anon' THEN
      GRANT EXECUTE ON FUNCTION public.admin_list_organizations() TO anon;
      after := pg_temp.acl();
      IF after = before OR NOT has_function_privilege('anon', 'public.admin_list_organizations()', 'EXECUTE') THEN
        RAISE EXCEPTION 'MUTATION NOT APPLIED: %', m;
      END IF;
      RETURN 'MUTATION APPLIED GRANT EXECUTE TO anon [' || after || ']';
    ELSIF m = 'no_definer' THEN
      ALTER FUNCTION public.admin_list_organizations() SECURITY INVOKER;
      after := pg_temp.acl();
      IF after = before OR after NOT LIKE '%definer=false%' THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: %', m; END IF;
      RETURN 'MUTATION APPLIED SECURITY INVOKER [' || after || ']';
    END IF;
    RAISE EXCEPTION 'unknown mode %', m;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    j jsonb; rows jsonb; s text; s2 text; n int; n2 int;
    d0 text; a0 text;
    tier_team uuid; tier_ind uuid; tier_ent uuid;
  BEGIN
    SELECT id INTO tier_team FROM public.plans WHERE tier = 'team' ORDER BY id LIMIT 1;
    SELECT id INTO tier_ind FROM public.plans WHERE tier = 'individual' ORDER BY id LIMIT 1;
    SELECT id INTO tier_ent FROM public.plans WHERE tier = 'enterprise' ORDER BY id LIMIT 1;

    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT pg_temp.fx(x), 'p4098-' || x || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM generate_series(1, 5) x;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    SELECT pg_temp.fx(x), 'p4098-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'P4098 user ' || x
      FROM generate_series(1, 5) x
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.internal_roles (user_id, role_id)
    SELECT pg_temp.fx(1), ar.id FROM public.admin_roles ar ORDER BY ar.slug LIMIT 1;

    INSERT INTO public.organizations (id, name, slug, max_seats, is_test, personal_owner_user_id) VALUES
      (pg_temp.fx(11), 'P4098 brokerage one member', 'p4098-brokerage-one', 10, false, NULL),
      (pg_temp.fx(12), 'P4098 personal two members', 'p4098-personal-two', 10, false, pg_temp.fx(3)),
      (pg_temp.fx(13), 'P4098 brokerage individual tier', 'p4098-brokerage-individual', 10, false, NULL),
      (pg_temp.fx(14), 'P4098 test brokerage', 'p4098-test-brokerage', 10, true, NULL);
    INSERT INTO public.organization_plans (organization_id, plan_id) VALUES
      (pg_temp.fx(11), tier_team), (pg_temp.fx(12), tier_team),
      (pg_temp.fx(13), tier_ind), (pg_temp.fx(14), tier_ent)
    ON CONFLICT (organization_id) DO UPDATE SET plan_id = EXCLUDED.plan_id;
    INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
      (pg_temp.fx(11), pg_temp.fx(5), 'admin'),
      (pg_temp.fx(12), pg_temp.fx(3), 'admin'),
      (pg_temp.fx(12), pg_temp.fx(4), 'agent')
    ON CONFLICT (organization_id, user_id) DO NOTHING;

    -- ===== C0: the fixtures are what they claim =====
    r := r || jsonb_build_object('C0_fixtures', pg_temp.pass(
      (SELECT count(*) FROM public.organization_members WHERE organization_id = pg_temp.fx(11)) = 1
      AND (SELECT count(*) FROM public.organization_members WHERE organization_id = pg_temp.fx(12)) = 2
      AND (SELECT count(*) FROM public.organization_members WHERE organization_id = pg_temp.fx(13)) = 0
      AND (SELECT p.tier FROM public.organization_plans op JOIN public.plans p ON p.id = op.plan_id WHERE op.organization_id = pg_temp.fx(13)) = 'individual'
      AND (SELECT p.tier FROM public.organization_plans op JOIN public.plans p ON p.id = op.plan_id WHERE op.organization_id = pg_temp.fx(12)) = 'team'
      AND EXISTS (SELECT 1 FROM public.internal_roles WHERE user_id = pg_temp.fx(1))
      AND NOT EXISTS (SELECT 1 FROM public.internal_roles WHERE user_id = pg_temp.fx(2)),
      'fixture mismatch'));

    s := pg_temp.call_as(pg_temp.fx(1));
    IF s LIKE 'ERR%' THEN
      r := r || jsonb_build_object('C1_internal_call', 'FAIL ' || s);
      rows := '[]'::jsonb;
    ELSE
      j := s::jsonb;
      rows := coalesce(j->'organizations', '[]'::jsonb);
      r := r || jsonb_build_object('C1_internal_call', pg_temp.pass((j->>'success')::boolean IS TRUE, left(s, 120)));
    END IF;

    -- ===== C1: flags are correct =====
    -- C1a: the four fixtures carry the expected literals
    SELECT string_agg(e->>'slug' || '=' || coalesce(e->>'is_personal', '?') || '/' || coalesce(e->>'is_test', '?'), ',' ORDER BY e->>'slug')
      INTO s2 FROM jsonb_array_elements(rows) e WHERE e->>'slug' LIKE 'p4098-%';
    r := r || jsonb_build_object('C1a_fixture_flags', pg_temp.chk(s2,
      'p4098-brokerage-individual=false/false,p4098-brokerage-one=false/false,p4098-personal-two=true/false,p4098-test-brokerage=false/true'));
    -- C1b: every row's flags are booleans that match the table
    SELECT count(*) INTO n FROM jsonb_array_elements(rows) e JOIN public.organizations o ON o.id = (e->>'id')::uuid
      WHERE jsonb_typeof(e->'is_personal') = 'boolean' AND jsonb_typeof(e->'is_test') = 'boolean'
        AND (e->>'is_personal')::boolean = (o.personal_owner_user_id IS NOT NULL)
        AND (e->>'is_test')::boolean = o.is_test;
    SELECT count(*) INTO n2 FROM public.organizations;
    r := r || jsonb_build_object('C1b_all_rows_match_table', pg_temp.pass(
      n = n2 AND jsonb_array_length(rows) = n2, n || ' matching of ' || jsonb_array_length(rows) || ' rows, table ' || n2));
    -- C1c: the key set is the old eight plus the two flags, nothing else
    SELECT count(*) INTO n FROM jsonb_array_elements(rows) e
      WHERE (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k)
         <> ARRAY['created_at','id','is_personal','is_test','max_seats','member_count','name','plan_name','plan_tier','slug'];
    r := r || jsonb_build_object('C1c_key_set', pg_temp.pass(n = 0 AND jsonb_array_length(rows) > 0, n || ' rows with other keys'));
    -- C1d: the old keys keep their values (member_count, plan_tier) and the order stays ORDER BY name
    -- (compared by name: keepr-test has two organizations with the same name, so ids can tie)
    r := r || jsonb_build_object('C1d_old_keys_and_order', pg_temp.pass(
      (SELECT string_agg(e->>'slug' || ':' || (e->>'member_count') || ':' || coalesce(e->>'plan_tier', '-'), ',' ORDER BY e->>'slug')
         FROM jsonb_array_elements(rows) e WHERE e->>'slug' LIKE 'p4098-%')
        = 'p4098-brokerage-individual:0:individual,p4098-brokerage-one:1:team,p4098-personal-two:2:team,p4098-test-brokerage:0:enterprise'
      AND (SELECT array_agg(e->>'name' ORDER BY ord) FROM jsonb_array_elements(rows) WITH ORDINALITY t(e, ord))
        = (SELECT array_agg(o.name::text ORDER BY o.name) FROM public.organizations o),
      'values or order differ'));

    -- ===== C2: no owner id leaves the function, under any key or value except id =====
    SELECT count(*) INTO n FROM jsonb_array_elements(rows) e JOIN public.organizations o ON o.id = (e->>'id')::uuid
      WHERE o.personal_owner_user_id IS NOT NULL AND position(o.personal_owner_user_id::text IN (e - 'id')::text) > 0;
    SELECT count(*) INTO n2 FROM jsonb_array_elements(rows) e, jsonb_object_keys(e) k WHERE k ILIKE '%owner%';
    r := r || jsonb_build_object('C2_no_owner_id', pg_temp.pass(n = 0 AND n2 = 0 AND jsonb_array_length(rows) > 0,
      n || ' rows carry an owner id, ' || n2 || ' owner keys'));

    -- ===== C3: an authenticated user with no internal role gets not_authorized =====
    r := r || jsonb_build_object('C3_non_internal_refused', pg_temp.chk(
      pg_temp.call_as(pg_temp.fx(2)), '{"error": "not_authorized", "success": false}'));

    -- ===== C4: anon cannot execute =====
    r := r || jsonb_build_object('C4_anon_denied', pg_temp.chk(pg_temp.call_as(NULL, 'anon'), 'ERR 42501%'));

    -- ===== C5: catalog: grants, SECURITY DEFINER, search_path =====
    r := r || jsonb_build_object('C5_catalog', pg_temp.pass(
      NOT has_function_privilege('anon', 'public.admin_list_organizations()', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.admin_list_organizations()', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.admin_list_organizations()', 'EXECUTE')
      AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                       WHERE p.oid = 'public.admin_list_organizations()'::regprocedure AND a.grantee = 0)
      AND (SELECT prosecdef AND proconfig = ARRAY['search_path=public'] FROM pg_proc
            WHERE oid = 'public.admin_list_organizations()'::regprocedure),
      pg_temp.acl()));

    -- ===== C6: re-applying the migration changes nothing; the rollback restores the old body =====
    d0 := md5(pg_temp.def()); a0 := pg_temp.acl();
    BEGIN
      EXECUTE $mg$__MIGRATION__$mg$;
      s := CASE WHEN md5(pg_temp.def()) = d0 AND pg_temp.acl() = a0 THEN 'same' ELSE 'changed' END;
      RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
      ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
    END;
    r := r || jsonb_build_object('C6a_reapply_idempotent', pg_temp.chk(s, 'same'));
    BEGIN
      EXECUTE $rb$__ROLLBACK__$rb$;
      s2 := pg_temp.call_as(pg_temp.fx(1));
      s := CASE WHEN s2 NOT LIKE 'ERR%'
                 AND position('is_personal' IN s2) = 0 AND position('is_test' IN s2) = 0
                 AND position('member_count' IN s2) > 0
                 AND pg_temp.acl() = a0
                 AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261031160000')
            THEN 'restored' ELSE 'not restored: ' || left(s2, 60) || ' ' || pg_temp.acl() END;
      RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
      ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
    END;
    r := r || jsonb_build_object('C6b_rollback_restores_old_body', pg_temp.pass(
      s = 'restored' AND md5(pg_temp.def()) = d0, s));

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
  RAISE EXCEPTION 'P4098_RESULT %', v_res;
END
$drv$;
