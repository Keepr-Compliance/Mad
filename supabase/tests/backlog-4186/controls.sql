-- BACKLOG-4186 PR A DB controls: sender_rule_set_admin_state() / sender_rule_set_admin_content().
-- Venue: keepr-test ONLY (kt-sql refuses the production ref). ONE call, ONE transaction ending in
-- RAISE, so nothing persists. compose.py drops the two functions, applies the migration TWICE in
-- front, then runs this. Needs 20261107235503 (BACKLOG-4175) and 20261105100000 (BACKLOG-4144).
-- Mutations are applied to the migration FILE by mutate.py, then this runs.
-- Fixtures (invented; ids built at run time from fx(n), emails p4186-<n>@example.test; admin roles
-- picked BY NAME), as in backlog-4175/controls.sql plus u6:
--   u1 Super Admin (owner)   u2 Support Supervisor + editor on sender-rules   u3 same, viewer
--   u4 Support Agent (no analytics.view)   u5 signed in, no internal role
--   u6 Executive (HAS analytics.view, so share-eligible) with NO grant: access NULL while eligible
--   orgs A, B, D (D is deleted inside the run)
-- Output: RAISE 'P4186_RESULT {total, pass, fail, reds}'.

DO $drv$
DECLARE
  v_r jsonb;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
    SELECT ('00000000-0000-4186-8000-' || lpad(n::text, 12, '0'))::uuid
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);
  END $b$$f$;

  -- run one statement as a role ('authenticated' with a user, or 'anon'): a SELECT returning jsonb
  -- gives its value as text; any other statement gives '"ok"'; an error gives
  -- 'ERR <sqlstate> <message>'. Each call is its own subtransaction.
  EXECUTE $f$CREATE FUNCTION pg_temp.call_as(u uuid, q text, r text DEFAULT 'authenticated') RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE j jsonb;
  BEGIN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
      PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
      PERFORM set_config('request.jwt.claim.role', r, true);
      EXECUTE format('SET LOCAL ROLE %I', r);
      IF q ~* '^\s*(select|with)\M' THEN
        EXECUTE q INTO j;
      ELSE
        EXECUTE q;
        j := '"ok"'::jsonb;
      END IF;
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN coalesce(j::text, 'null');
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 100);
    END;
  END $b$$f$;

  -- text -> jsonb, NULL when it is not JSON (an 'ERR ...' answer)
  EXECUTE $f$CREATE FUNCTION pg_temp.j(t text) RETURNS jsonb LANGUAGE plpgsql AS $b$
  BEGIN
    RETURN t::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.pass(ok boolean, detail text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || left(coalesce(detail, 'null'), 300) END
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.st(u uuid, r text DEFAULT 'authenticated') RETURNS text LANGUAGE sql AS $b$
    SELECT pg_temp.call_as(u, 'SELECT public.sender_rule_set_admin_state()', r)
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.ct(u uuid, v bigint, r text DEFAULT 'authenticated') RETURNS text LANGUAGE sql AS $b$
    SELECT pg_temp.call_as(u, format('SELECT public.sender_rule_set_admin_content(%L::bigint)', v), r)
  $b$$f$;

  -- the 4175 write RPCs (unchanged code; used for fixtures and the write half of R1)
  EXECUTE $f$CREATE FUNCTION pg_temp.pub(c jsonb, org uuid DEFAULT NULL, u uuid DEFAULT NULL) RETURNS text LANGUAGE sql AS $b$
    SELECT pg_temp.call_as(coalesce(u, pg_temp.fx(1)),
      format('SELECT to_jsonb(public.sender_rule_set_publish(%L::jsonb, %L::uuid))', c, org))
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.pin(org uuid, v bigint, u uuid DEFAULT NULL) RETURNS text LANGUAGE sql AS $b$
    SELECT pg_temp.call_as(coalesce(u, pg_temp.fx(1)),
      format('SELECT to_jsonb(public.sender_rule_set_pin(%L::uuid, %L::bigint))', org, v))
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.revert(u uuid DEFAULT NULL) RETURNS text LANGUAGE sql AS $b$
    SELECT pg_temp.call_as(coalesce(u, pg_temp.fx(1)), 'SELECT to_jsonb(public.sender_rule_set_revert_all())')
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.maxv() RETURNS bigint LANGUAGE sql AS $b$
    SELECT max(version) FROM public.sender_rule_sets
  $b$$f$;

  -- sorted key list of a jsonb object, as text
  EXECUTE $f$CREATE FUNCTION pg_temp.keys(o jsonb) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN jsonb_typeof(o) = 'object'
      THEN (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(o) k) ELSE 'not-object' END
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    s text; s2 text; s3 text; s4 text; s5 text; n int; k text; ok boolean;
    d jsonb; d2 jsonb; seed jsonb;
    vR bigint; vA bigint; vD bigint; v bigint;
    u1 uuid := pg_temp.fx(1); u2 uuid := pg_temp.fx(2); u3 uuid := pg_temp.fx(3); u4 uuid := pg_temp.fx(4);
    u5 uuid := pg_temp.fx(5); u6 uuid := pg_temp.fx(6);
    oA uuid := pg_temp.fx(31); oB uuid := pg_temp.fx(32); oD uuid := pg_temp.fx(33);
    r_sa uuid := (SELECT id FROM public.admin_roles WHERE name = 'Super Admin');
    r_ss uuid := (SELECT id FROM public.admin_roles WHERE name = 'Support Supervisor');
    r_ag uuid := (SELECT id FROM public.admin_roles WHERE name = 'Support Agent');
    r_ex uuid := (SELECT id FROM public.admin_roles WHERE name = 'Executive');
    NA text := 'ERR 42501 Not allowed';
    sigs text[] := ARRAY['public.sender_rule_set_admin_state()', 'public.sender_rule_set_admin_content(bigint)'];
    TOP_KEYS text := 'pins,released_version,truncated,versions';
    VER_KEYS text := 'bundled,canary_org,canary_org_name,published_at,released,version';
    PIN_KEYS text := 'org_id,org_name,pinned_at,version';
  BEGIN
    seed := (SELECT content FROM public.sender_rule_sets WHERE released ORDER BY version DESC LIMIT 1);

    -- ===== fixtures =====
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT pg_temp.fx(x), 'p4186-' || x || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM generate_series(1, 6) x;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    SELECT pg_temp.fx(x), 'p4186-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'P4186 user ' || x
      FROM generate_series(1, 6) x
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;
    INSERT INTO public.internal_roles (user_id, role_id) VALUES (u1, r_sa), (u2, r_ss), (u3, r_ss), (u4, r_ag), (u6, r_ex);
    INSERT INTO public.report_access (report_key, user_id, role) VALUES ('sender-rules', u2, 'editor'), ('sender-rules', u3, 'viewer');
    -- org fixtures: triggers off for the INSERT only (billing / seat / personal-org guards are not
    -- under test). The delete in R6 runs with triggers ON, so the pin's ON DELETE CASCADE fires.
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.organizations (id, name, slug) VALUES
      (oA, 'P4186 Org A', 'p4186-a'), (oB, 'P4186 Org B', 'p4186-b'), (oD, 'P4186 Org D', 'p4186-d');
    SET LOCAL session_replication_role = origin;

    r := r || jsonb_build_object('K0_fixtures', pg_temp.pass(
      r_sa IS NOT NULL AND r_ss IS NOT NULL AND r_ag IS NOT NULL AND r_ex IS NOT NULL AND seed IS NOT NULL
      AND pg_temp.call_as(u1, 'SELECT to_jsonb(public.report_my_access(''sender-rules''))') = '"owner"'
      AND pg_temp.call_as(u2, 'SELECT to_jsonb(public.report_my_access(''sender-rules''))') = '"editor"'
      AND pg_temp.call_as(u3, 'SELECT to_jsonb(public.report_my_access(''sender-rules''))') = '"viewer"'
      AND pg_temp.call_as(u4, 'SELECT to_jsonb(public.report_my_access(''sender-rules''))') = 'null'
      AND pg_temp.call_as(u5, 'SELECT to_jsonb(public.report_my_access(''sender-rules''))') = 'null'
      AND pg_temp.call_as(u6, 'SELECT to_jsonb(public.report_my_access(''sender-rules''))') = 'null'
      AND public._report_share_eligible(u6) AND NOT public._report_share_eligible(u4)
      AND current_setting('session_replication_role') = 'origin',
      'u1=' || pg_temp.call_as(u1, 'SELECT to_jsonb(public.report_my_access(''sender-rules''))')
      || ' u6=' || pg_temp.call_as(u6, 'SELECT to_jsonb(public.report_my_access(''sender-rules''))')
      || ' u6elig=' || public._report_share_eligible(u6)::text));

    -- ===== R1: every grant reads (owner, editor, viewer), both functions =====
    s := '';
    FOREACH k IN ARRAY ARRAY[u1::text, u2::text, u3::text] LOOP
      s2 := pg_temp.st(k::uuid);
      s3 := pg_temp.ct(k::uuid, 1);
      IF s2 LIKE 'ERR%' OR pg_temp.keys(pg_temp.j(s2)) <> TOP_KEYS
         OR s3 LIKE 'ERR%' OR pg_temp.j(s3) IS DISTINCT FROM (SELECT content FROM public.sender_rule_sets WHERE version = 1) THEN
        s := s || right(k, 2) || '[' || left(s2, 40) || '|' || left(s3, 40) || '] ';
      END IF;
    END LOOP;
    r := r || jsonb_build_object('R1_grant_holders_read', pg_temp.pass(s = '', s));

    -- ===== R1 write half: editor and viewer still cannot write. This exercises UNCHANGED 4175
    -- code; it is not a write-gate control (those mutations live in backlog-4175). =====
    n := (SELECT count(*) FROM public.sender_rule_sets);
    s := '';
    FOREACH k IN ARRAY ARRAY[u2::text, u3::text] LOOP
      s2 := pg_temp.pub(seed, NULL, k::uuid);
      s3 := pg_temp.pub(seed, oA, k::uuid);
      s4 := pg_temp.pin(oA, 1, k::uuid);
      s5 := pg_temp.revert(k::uuid);
      IF NOT (s2 = NA AND s3 = NA AND s4 = NA AND s5 = NA) THEN
        s := s || right(k, 2) || '[' || left(s2, 30) || '|' || left(s3, 30) || '|' || left(s4, 30) || '|' || left(s5, 30) || '] ';
      END IF;
    END LOOP;
    r := r || jsonb_build_object('R1w_readers_cannot_write_4175', pg_temp.pass(
      s = '' AND (SELECT count(*) FROM public.sender_rule_sets) = n, s));

    -- ===== R1b: no grant -> 42501 on both: eligible no-grant (u6), no analytics.view (u4),
    -- no internal role (u5), no JWT sub; anon refused by the grant =====
    s := '';
    FOREACH k IN ARRAY ARRAY[u4::text, u5::text, u6::text] LOOP
      s2 := pg_temp.st(k::uuid);
      s3 := pg_temp.ct(k::uuid, 1);
      IF NOT (s2 = NA AND s3 = NA) THEN
        s := s || right(k, 2) || '[' || left(s2, 40) || '|' || left(s3, 40) || '] ';
      END IF;
    END LOOP;
    s2 := pg_temp.st(NULL);
    s3 := pg_temp.ct(NULL, 1);
    IF NOT (s2 = NA AND s3 = NA) THEN s := s || 'nosub[' || left(s2, 40) || '|' || left(s3, 40) || '] '; END IF;
    s2 := pg_temp.st(NULL, 'anon');
    s3 := pg_temp.ct(NULL, 1, 'anon');
    IF NOT (s2 LIKE 'ERR 42501 permission denied%' AND s3 LIKE 'ERR 42501 permission denied%') THEN
      s := s || 'anon[' || left(s2, 40) || '|' || left(s3, 40) || '] ';
    END IF;
    r := r || jsonb_build_object('R1b_no_grant_refused', pg_temp.pass(s = '', s));

    -- ===== R2: EXECUTE grants. anon none, no PUBLIC entry, authenticated yes; definer, STABLE,
    -- search_path pinned =====
    s := '';
    FOREACH k IN ARRAY sigs LOOP
      IF has_function_privilege('anon', k, 'EXECUTE') OR NOT has_function_privilege('authenticated', k, 'EXECUTE')
         OR NOT (SELECT prosecdef AND provolatile = 's' AND coalesce(array_to_string(proconfig, ',') LIKE '%search_path=%', false)
                 FROM pg_proc WHERE oid = k::regprocedure)
         OR (SELECT coalesce(proacl::text, '') ~ '(^|[{,])=X' FROM pg_proc WHERE oid = k::regprocedure) THEN
        s := s || k || ' ';
      END IF;
    END LOOP;
    r := r || jsonb_build_object('R2_function_grants', pg_temp.pass(
      s = '' AND (SELECT count(*) FROM pg_proc WHERE proname LIKE 'sender_rule_set_admin_%') = 2, s));

    -- ===== scenario: release vR, canary vA for org A, pin B to vA, unpin A =====
    vR := (pg_temp.pub(seed))::bigint;
    vA := (pg_temp.pub(seed, oA))::bigint;
    s2 := pg_temp.pin(oB, vA);
    s3 := pg_temp.pin(oA, NULL);
    d := pg_temp.j(pg_temp.st(u1));

    -- R4: pins come from the pin table, not from canary_org
    r := r || jsonb_build_object('R4_pins_from_pin_table', pg_temp.pass(
      s2 = '""' AND s3 = '""'
      AND (SELECT jsonb_agg(e->>'org_id' ORDER BY e->>'org_id') FROM jsonb_array_elements(d->'pins') e
           WHERE (e->>'org_id')::uuid IN (oA, oB)) = jsonb_build_array(oB::text)
      AND (SELECT e->>'org_name' = 'P4186 Org B' AND (e->>'version')::bigint = vA
           FROM jsonb_array_elements(d->'pins') e WHERE (e->>'org_id')::uuid = oB)
      AND jsonb_array_length(d->'pins') = (SELECT count(*) FROM public.sender_rule_set_pins),
      'pin=' || s2 || ' unpin=' || s3 || ' pins=' || left(coalesce((d->'pins')::text, '-'), 200)));

    -- R5: released_version is the newest RELEASED version, not the newest version
    r := r || jsonb_build_object('R5_released_version', pg_temp.pass(
      vA > vR AND (d->>'released_version')::bigint = vR AND pg_temp.maxv() = vA,
      'released_version=' || coalesce(d->>'released_version', '-') || ' vR=' || vR || ' vA=' || vA));

    -- R3: exact key sets at all three levels (no published_by, no pinned_by, nothing extra)
    r := r || jsonb_build_object('R3_exact_keys', pg_temp.pass(
      pg_temp.keys(d) = TOP_KEYS
      AND jsonb_array_length(d->'versions') > 0 AND jsonb_array_length(d->'pins') > 0
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d->'versions') e WHERE pg_temp.keys(e) IS DISTINCT FROM VER_KEYS)
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d->'pins') e WHERE pg_temp.keys(e) IS DISTINCT FROM PIN_KEYS),
      'top=' || pg_temp.keys(d)
      || ' ver=' || coalesce((SELECT string_agg(DISTINCT pg_temp.keys(e), ';') FROM jsonb_array_elements(d->'versions') e), '-')
      || ' pin=' || coalesce((SELECT string_agg(DISTINCT pg_temp.keys(e), ';') FROM jsonb_array_elements(d->'pins') e), '-')));

    -- V1: listing is every version newest first (<= 200 here), with the canary's org and flags
    r := r || jsonb_build_object('V1_versions_listing', pg_temp.pass(
      (d->>'truncated')::boolean = false
      AND jsonb_array_length(d->'versions') = (SELECT count(*) FROM public.sender_rule_sets)
      AND (SELECT jsonb_agg((e->>'version')::bigint ORDER BY o) FROM jsonb_array_elements(d->'versions') WITH ORDINALITY x(e, o))
          = (SELECT jsonb_agg(version ORDER BY version DESC) FROM public.sender_rule_sets)
      AND (SELECT (e->>'released')::boolean = false AND (e->>'bundled')::boolean = false
                  AND e->>'canary_org' = oA::text AND e->>'canary_org_name' = 'P4186 Org A'
           FROM jsonb_array_elements(d->'versions') e WHERE (e->>'version')::bigint = vA)
      AND (SELECT (e->>'released')::boolean AND e->'canary_org' = 'null'::jsonb AND e->'canary_org_name' = 'null'::jsonb
           FROM jsonb_array_elements(d->'versions') e WHERE (e->>'version')::bigint = vR)
      AND (SELECT (e->>'bundled')::boolean FROM jsonb_array_elements(d->'versions') e WHERE (e->>'version')::bigint = 1),
      'n=' || jsonb_array_length(d->'versions') || ' truncated=' || coalesce(d->>'truncated', '-')
      || ' head=' || left(coalesce((d->'versions'->0)::text, '-'), 200)));

    -- C1: content returns the REQUESTED version (each row's content carries its own version), NULL if absent
    s2 := pg_temp.ct(u3, vA);
    s3 := pg_temp.ct(u2, vR);
    s4 := pg_temp.ct(u1, 999999999);
    r := r || jsonb_build_object('C1_content_by_version', pg_temp.pass(
      s2 NOT LIKE 'ERR%' AND pg_temp.j(s2) = (SELECT content FROM public.sender_rule_sets WHERE version = vA)
      AND (pg_temp.j(s2)->>'version')::bigint = vA
      AND s3 NOT LIKE 'ERR%' AND pg_temp.j(s3) = (SELECT content FROM public.sender_rule_sets WHERE version = vR)
      AND s4 = 'null',
      'vA->' || left(coalesce(pg_temp.j(s2)->>'version', s2), 40) || ' vR->' || left(coalesce(pg_temp.j(s3)->>'version', s3), 40)
      || ' missing->' || left(s4, 40)));

    -- ===== R6: a canary whose org is deleted stays listed, with a NULL name =====
    vD := (pg_temp.pub(seed, oD))::bigint;
    BEGIN
      DELETE FROM public.organizations WHERE id = oD;
      s := 'deleted';
    EXCEPTION WHEN OTHERS THEN
      s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 100);
    END;
    d := pg_temp.j(pg_temp.st(u1));
    r := r || jsonb_build_object('R6_deleted_org_kept', pg_temp.pass(
      s = 'deleted' AND NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = oD)
      AND (SELECT count(*) FROM jsonb_array_elements(d->'versions') e
           WHERE (e->>'version')::bigint = vD AND e->>'canary_org' = oD::text AND e->'canary_org_name' = 'null'::jsonb) = 1
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d->'pins') e WHERE (e->>'org_id')::uuid = oD)
      AND jsonb_array_length(d->'versions') = (SELECT count(*) FROM public.sender_rule_sets),
      s || ' vD=' || coalesce(vD::text, '-') || ' n=' || coalesce(jsonb_array_length(d->'versions')::text, '-')));

    -- ===== R7: cap at 200, newest first; truncated false at exactly 200, true at 201 =====
    v := pg_temp.maxv();
    n := (SELECT count(*) FROM public.sender_rule_sets);
    INSERT INTO public.sender_rule_sets (version, content, released, bundled)
    SELECT v + g, jsonb_set(seed, '{version}', to_jsonb(v + g)), true, false
      FROM generate_series(1, 200 - n) g;
    d := pg_temp.j(pg_temp.st(u1));
    ok := (SELECT count(*) FROM public.sender_rule_sets) = 200
      AND jsonb_array_length(d->'versions') = 200 AND (d->>'truncated')::boolean = false;
    s := 'at200 n=' || coalesce(jsonb_array_length(d->'versions')::text, '-') || ' t=' || coalesce(d->>'truncated', '-');
    v := pg_temp.maxv();
    INSERT INTO public.sender_rule_sets (version, content, released, bundled)
    VALUES (v + 1, jsonb_set(seed, '{version}', to_jsonb(v + 1)), true, false);
    d := pg_temp.j(pg_temp.st(u1));
    r := r || jsonb_build_object('R7_cap_200', pg_temp.pass(
      ok AND (SELECT count(*) FROM public.sender_rule_sets) = 201
      AND jsonb_array_length(d->'versions') = 200 AND (d->>'truncated')::boolean = true
      AND (d->'versions'->0->>'version')::bigint = v + 1
      AND (d->'versions'->199->>'version')::bigint = (SELECT version FROM public.sender_rule_sets ORDER BY version DESC OFFSET 199 LIMIT 1)
      AND (d->>'released_version')::bigint = v + 1,
      s || ' at201 n=' || coalesce(jsonb_array_length(d->'versions')::text, '-') || ' t=' || coalesce(d->>'truncated', '-')
      || ' first=' || coalesce(d->'versions'->0->>'version', '-') || ' last=' || coalesce(d->'versions'->199->>'version', '-')));

    -- ===== RB: the rollback removes both functions =====
    BEGIN
      EXECUTE $rb$__ROLLBACK__$rb$;
      s := CASE WHEN (SELECT count(*) FROM pg_proc WHERE proname LIKE 'sender_rule_set_admin_%') = 0
                 AND to_regclass('public.sender_rule_sets') IS NOT NULL
            THEN 'removed' ELSE 'left: ' || coalesce((SELECT string_agg(proname, ',') FROM pg_proc WHERE proname LIKE 'sender_rule_set_admin_%'), '-') END;
      RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
      ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 100); END IF;
    END;
    r := r || jsonb_build_object('RB_rollback_removes_functions', pg_temp.pass(s = 'removed', s));

    RETURN r;
  END $b$$f$;

  v_r := pg_temp.run();
  RAISE EXCEPTION 'P4186_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(v_r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'));
END
$drv$;
