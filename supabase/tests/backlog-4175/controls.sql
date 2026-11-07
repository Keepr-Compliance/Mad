-- BACKLOG-4175 migration A DB controls: sender_rule_sets, sender_rule_set_pins, the validators,
-- the release guard, sender_rule_set_current / _publish / _pin / _revert_all, grants, rollback.
-- Venue: keepr-test ONLY (kt-sql refuses the production ref). ONE call, ONE transaction ending in
-- RAISE, so nothing persists. Run with compose.py --with-migration (migration applied TWICE in
-- front). Needs 20261105100000 (BACKLOG-4144, report_my_access) applied.
-- Mutations are applied to the migration / rollback FILE by mutate.py, then this runs.
-- Fixtures (invented; ids built at run time from fx(n), emails p4175-<n>@example.test; admin roles
-- picked BY NAME):
--   u1 Super Admin (owner)   u2 Support Supervisor + editor on sender-rules   u3 same, viewer
--   u4 Support Agent (no analytics.view)   u5 signed in, no internal role, no org
--   u6 member of org X (brokerage, active)   u7 member of org Y (active)
--   u8 personal org P (membership created EARLIER) + org X (later)  -> resolves to X
--   u9 org X membership suspended only  -> resolves to no org
-- Output: RAISE 'P4175_RESULT {total, pass, fail, reds, checks}'.

DO $drv$
DECLARE
  v_r jsonb;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
    SELECT ('00000000-0000-4175-8000-' || lpad(n::text, 12, '0'))::uuid
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);
  END $b$$f$;

  -- run one statement as a role ('authenticated' with a user, or 'anon'): a SELECT/WITH returning
  -- jsonb gives its value as text; any other statement gives '"ok"'; an error gives
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

  -- the DETAIL of the error a statement raises as a user ('none' when it does not raise)
  EXECUTE $f$CREATE FUNCTION pg_temp.detail_as(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE j jsonb; d text;
  BEGIN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', u::text, true);
      SET LOCAL ROLE authenticated;
      EXECUTE q INTO j;
      RESET ROLE;
      PERFORM pg_temp.clear_claims();
      RETURN 'none';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL;
      RESET ROLE;
      PERFORM pg_temp.clear_claims();
      RETURN coalesce(d, '');
    END;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.pass(ok boolean, detail text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || left(coalesce(detail, 'null'), 300) END
  $b$$f$;

  -- (a void RPC answers '""')
  -- the version current() gives a user, as text ('null' / 'ERR ...' otherwise)
  EXECUTE $f$CREATE FUNCTION pg_temp.cur(u uuid) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE s text;
  BEGIN
    s := pg_temp.call_as(u, 'SELECT public.sender_rule_set_current()');
    IF s LIKE 'ERR%' OR s = 'null' THEN RETURN s; END IF;
    RETURN (s::jsonb->>'version');
  END $b$$f$;

  -- publish as the owner (u1): a release (org NULL) or a canary. The new version as text, or 'ERR ...'
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

  -- the latest released content
  EXECUTE $f$CREATE FUNCTION pg_temp.latest() RETURNS jsonb LANGUAGE sql AS $b$
    SELECT content FROM public.sender_rule_sets WHERE released ORDER BY version DESC LIMIT 1
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.maxv() RETURNS bigint LANGUAGE sql AS $b$
    SELECT max(version) FROM public.sender_rule_sets
  $b$$f$;

  -- set all three surfaces of one signal
  EXECUTE $f$CREATE FUNCTION pg_temp.sig(c jsonb, s text, m text) RETURNS jsonb LANGUAGE sql AS $b$
    SELECT jsonb_set(c, ARRAY['modes', s], jsonb_build_object('learnQuestions', m, 'addressPass', m, 'detector', m))
  $b$$f$;

  -- set every cell (gmailUpdates never live)
  EXECUTE $f$CREATE FUNCTION pg_temp.allm(c jsonb, m text) RETURNS jsonb LANGUAGE sql AS $b$
    SELECT jsonb_set(c, '{modes}', (SELECT jsonb_object_agg(k.key, jsonb_build_object(
      'learnQuestions', CASE WHEN k.key = 'gmailUpdates' AND m = 'live' THEN 'measure' ELSE m END,
      'addressPass', CASE WHEN k.key = 'gmailUpdates' AND m = 'live' THEN 'measure' ELSE m END,
      'detector', CASE WHEN k.key = 'gmailUpdates' AND m = 'live' THEN 'measure' ELSE m END))
      FROM jsonb_each(c->'modes') k))
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    s text; s2 text; s3 text; s4 text; s5 text; s6 text; n int; n2 int; ok boolean; k text; f text;
    c jsonb; c2 jsonb; d jsonb; v bigint; v2 bigint; vC bigint; vR bigint; vb bigint; vM bigint; vN bigint;
    u1 uuid := pg_temp.fx(1); u2 uuid := pg_temp.fx(2); u3 uuid := pg_temp.fx(3); u4 uuid := pg_temp.fx(4);
    u5 uuid := pg_temp.fx(5); u6 uuid := pg_temp.fx(6); u7 uuid := pg_temp.fx(7); u8 uuid := pg_temp.fx(8);
    u9 uuid := pg_temp.fx(9);
    oX uuid := pg_temp.fx(31); oY uuid := pg_temp.fx(32); oP uuid := pg_temp.fx(33);
    r_sa uuid := (SELECT id FROM public.admin_roles WHERE name = 'Super Admin');
    r_ss uuid := (SELECT id FROM public.admin_roles WHERE name = 'Support Supervisor');
    r_ag uuid := (SELECT id FROM public.admin_roles WHERE name = 'Support Agent');
    seed jsonb;
    corpus jsonb := $cp$__CORPUS__$cp$::jsonb;
    GUARD text := 'ERR 22023 Publish to one test organization first%';
    INVALID text := 'ERR 22023 Invalid rule set%';
    NA text := 'ERR 42501 Not allowed';
    pub_sigs text[] := ARRAY['public.sender_rule_set_current()', 'public.sender_rule_set_publish(jsonb,uuid)',
                             'public.sender_rule_set_pin(uuid,bigint)', 'public.sender_rule_set_revert_all()'];
    priv_sigs text[] := ARRAY['public._sender_rule_set_invalid(jsonb)', 'public._sender_rule_set_keys_exact(jsonb,text[])',
                              'public._sender_rule_set_str_ok(jsonb,text)', 'public._sender_rule_set_int_ok(jsonb,numeric,numeric)',
                              'public._sender_rule_set_list_invalid(jsonb,integer,text)',
                              'public._sender_rule_set_release_blocks(jsonb,jsonb,bigint)'];
  BEGIN
    -- ===== S19 / S20a: the seed row exists once, released, bundled, valid; the catalog key once =====
    seed := (SELECT content FROM public.sender_rule_sets WHERE version = 1);
    r := r || jsonb_build_object('S19_seed_row', pg_temp.pass(
      (SELECT count(*) FROM public.sender_rule_sets) = 1
      AND (SELECT released AND bundled AND canary_org IS NULL FROM public.sender_rule_sets WHERE version = 1)
      AND public._sender_rule_set_invalid(seed) IS NULL
      AND seed #> '{keep,platformHosts}' = '["docusign.net", "docusign.com", "springcm.net", "showingtime.com", "showingtime.net"]'::jsonb
      AND seed->'version' = '1'::jsonb
      AND (SELECT count(*) FROM public.reports WHERE report_key = 'sender-rules') = 1,
      'rows=' || (SELECT count(*) FROM public.sender_rule_sets) || ' inv=' || coalesce(public._sender_rule_set_invalid(seed), '-')
      || ' hosts=' || coalesce((seed #> '{keep,platformHosts}')::text, '-')));

    -- ===== fixtures =====
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT pg_temp.fx(x), 'p4175-' || x || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM generate_series(1, 9) x;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    SELECT pg_temp.fx(x), 'p4175-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'P4175 user ' || x
      FROM generate_series(1, 9) x
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;
    INSERT INTO public.internal_roles (user_id, role_id) VALUES (u1, r_sa), (u2, r_ss), (u3, r_ss), (u4, r_ag);
    INSERT INTO public.report_access (report_key, user_id, role) VALUES ('sender-rules', u2, 'editor'), ('sender-rules', u3, 'viewer');
    -- org fixtures: triggers off for these rows only (billing / seat / personal-org guards are not under test)
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.organizations (id, name, slug) VALUES (oX, 'P4175 X', 'p4175-x'), (oY, 'P4175 Y', 'p4175-y');
    INSERT INTO public.organizations (id, name, slug, personal_owner_user_id) VALUES (oP, 'P4175 P', 'p4175-p', u8);
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, created_at) VALUES
      (oX, u6, 'agent', 'active', now()),
      (oY, u7, 'agent', 'active', now()),
      (oP, u8, 'admin', 'active', now() - interval '1 day'),
      (oX, u8, 'agent', 'active', now()),
      (oX, u9, 'agent', 'suspended', now());
    SET LOCAL session_replication_role = origin;

    r := r || jsonb_build_object('K0_fixtures', pg_temp.pass(
      r_sa IS NOT NULL AND r_ss IS NOT NULL AND r_ag IS NOT NULL
      AND pg_temp.call_as(u1, 'SELECT to_jsonb(public.report_my_access(''sender-rules''))') = '"owner"'
      AND pg_temp.call_as(u2, 'SELECT to_jsonb(public.report_my_access(''sender-rules''))') = '"editor"'
      AND pg_temp.call_as(u3, 'SELECT to_jsonb(public.report_my_access(''sender-rules''))') = '"viewer"'
      AND pg_temp.call_as(u4, 'SELECT to_jsonb(public.report_my_access(''sender-rules''))') = 'null'
      AND pg_temp.call_as(u5, 'SELECT to_jsonb(public.report_my_access(''sender-rules''))') = 'null'
      AND (SELECT count(*) FROM public.organization_members WHERE user_id IN (u6, u7, u8, u9)) = 5
      AND current_setting('session_replication_role') = 'origin',
      'u1=' || pg_temp.call_as(u1, 'SELECT to_jsonb(public.report_my_access(''sender-rules''))')
      || ' u2=' || pg_temp.call_as(u2, 'SELECT to_jsonb(public.report_my_access(''sender-rules''))')));

    -- ===== S8a: both tables closed to authenticated and anon (every statement -> 42501) =====
    s := '';
    FOREACH k IN ARRAY ARRAY['authenticated', 'anon'] LOOP
      FOREACH f IN ARRAY ARRAY[
        'SELECT to_jsonb(count(*)) FROM public.sender_rule_sets',
        'INSERT INTO public.sender_rule_sets (version, content, released) VALUES (424242, ''{}'', true)',
        'UPDATE public.sender_rule_sets SET published_by = NULL WHERE true',
        'DELETE FROM public.sender_rule_sets WHERE true',
        'TRUNCATE public.sender_rule_sets',
        'SELECT to_jsonb(count(*)) FROM public.sender_rule_set_pins',
        'INSERT INTO public.sender_rule_set_pins (org_id, version) VALUES (' || quote_literal(oX) || ', 1)',
        'UPDATE public.sender_rule_set_pins SET pinned_by = NULL WHERE true',
        'DELETE FROM public.sender_rule_set_pins WHERE true',
        'TRUNCATE public.sender_rule_set_pins'] LOOP
        s2 := pg_temp.call_as(CASE WHEN k = 'anon' THEN NULL ELSE u5 END, f, k);
        IF s2 NOT LIKE 'ERR 42501 permission denied%' THEN
          s := s || k || ':' || left(f, 40) || '=' || left(s2, 40) || ' ';
        END IF;
      END LOOP;
    END LOOP;
    r := r || jsonb_build_object('S8a_tables_closed', pg_temp.pass(s = '', s));

    -- ===== S8b: current() refused to anon by the GRANT (not by the body); a user gets exactly {version, content} =====
    s := pg_temp.call_as(NULL, 'SELECT public.sender_rule_set_current()', 'anon');
    s2 := pg_temp.call_as(u5, 'SELECT public.sender_rule_set_current()');
    r := r || jsonb_build_object('S8b_current_anon_refused_by_grant_and_shape', pg_temp.pass(
      s LIKE 'ERR 42501 permission denied for function%'
      AND s2 NOT LIKE 'ERR%'
      AND (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(s2::jsonb) x) = ARRAY['content', 'version']
      AND s2::jsonb->'version' = '1'::jsonb AND s2::jsonb->'content' = seed,
      'anon=' || s || ' u5=' || left(s2, 80)));

    -- ===== S8c: EXECUTE grants. anon none; authenticated the 4 RPCs only; definers pin search_path =====
    s := '';
    FOREACH k IN ARRAY pub_sigs LOOP
      IF has_function_privilege('anon', k, 'EXECUTE') OR NOT has_function_privilege('authenticated', k, 'EXECUTE')
         OR NOT (SELECT prosecdef AND coalesce(array_to_string(proconfig, ',') LIKE '%search_path=%', false) FROM pg_proc WHERE oid = k::regprocedure)
         OR (SELECT coalesce(proacl::text, '') ~ '(^|[{,])=X' FROM pg_proc WHERE oid = k::regprocedure) THEN
        s := s || k || ' ';
      END IF;
    END LOOP;
    FOREACH k IN ARRAY priv_sigs LOOP
      IF has_function_privilege('anon', k, 'EXECUTE') OR has_function_privilege('authenticated', k, 'EXECUTE')
         OR (SELECT prosecdef FROM pg_proc WHERE oid = k::regprocedure)
         OR (SELECT coalesce(proacl::text, '') ~ '(^|[{,])=X' FROM pg_proc WHERE oid = k::regprocedure) THEN
        s := s || k || ' ';
      END IF;
    END LOOP;
    r := r || jsonb_build_object('S8c_function_grants', pg_temp.pass(
      s = '' AND (SELECT count(*) FROM pg_proc WHERE proname LIKE '%sender_rule_set%') = 10, s
      || ' n=' || (SELECT count(*) FROM pg_proc WHERE proname LIKE '%sender_rule_set%')));

    -- ===== S9: owner gate. editor, viewer, no analytics.view, plain user, no JWT sub: refused; nothing written =====
    n := (SELECT count(*) FROM public.sender_rule_sets);
    s := '';
    FOREACH k IN ARRAY ARRAY[u2::text, u3::text, u4::text, u5::text] LOOP
      s2 := pg_temp.pub(seed, NULL, k::uuid);
      s3 := pg_temp.pub(seed, oX, k::uuid);
      s4 := pg_temp.pin(oX, 1, k::uuid);
      s5 := pg_temp.revert(k::uuid);
      IF NOT (s2 = NA AND s3 = NA AND s4 = NA AND s5 = NA) THEN
        s := s || right(k, 2) || '[' || left(s2, 30) || '|' || left(s3, 30) || '|' || left(s4, 30) || '|' || left(s5, 30) || '] ';
      END IF;
    END LOOP;
    s2 := pg_temp.call_as(NULL, format('SELECT to_jsonb(public.sender_rule_set_publish(%L::jsonb))', seed));
    r := r || jsonb_build_object('S9_non_owners_refused', pg_temp.pass(
      s = '' AND s2 = NA
      AND (SELECT count(*) FROM public.sender_rule_sets) = n
      AND NOT EXISTS (SELECT 1 FROM public.sender_rule_set_pins),
      s || ' nojwt=' || s2 || ' rows=' || (SELECT count(*) FROM public.sender_rule_sets) || '/' || n));

    -- owner: an unchanged release (live -> live) is allowed and gets max+1
    s := pg_temp.pub(seed);
    r := r || jsonb_build_object('S9b_owner_release_unchanged', pg_temp.pass(
      s = '2' AND (SELECT content->'version' FROM public.sender_rule_sets WHERE version = 2) = '2'::jsonb
      AND (SELECT released AND NOT bundled AND published_by = u1 FROM public.sender_rule_sets WHERE version = 2),
      s));

    -- ===== S18: content.version is overwritten with the assigned version =====
    s := pg_temp.pub(jsonb_set(seed, '{version}', '999'));
    r := r || jsonb_build_object('S18_version_overwritten', pg_temp.pass(
      s = '3' AND (SELECT content->'version' FROM public.sender_rule_sets WHERE version = 3) = '3'::jsonb
      AND NOT EXISTS (SELECT 1 FROM public.sender_rule_sets WHERE version = 999)
      AND NOT EXISTS (SELECT 1 FROM public.sender_rule_sets WHERE content->'version' <> to_jsonb(version)),
      s));

    -- ===== R2: a raw INSERT of an invalid rule set is refused by the table CHECK (23514) =====
    BEGIN
      INSERT INTO public.sender_rule_sets (version, content, released, bundled)
      VALUES (900, jsonb_set(jsonb_set(seed, '{version}', '900'), '{suppress,hosts}', '["a b"]'), true, true);
      s := 'inserted';
    EXCEPTION WHEN OTHERS THEN
      s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 200);
    END;
    r := r || jsonb_build_object('R2_check_refuses_raw_invalid_insert', pg_temp.pass(
      s LIKE 'ERR 23514%sender_rule_sets_content_valid%' AND NOT EXISTS (SELECT 1 FROM public.sender_rule_sets WHERE version = 900), s));

    -- ===== S10 / S14: org resolution and canaries =====
    c := jsonb_set(pg_temp.latest(), '{modes,localPart,learnQuestions}', '"live"');
    s := pg_temp.pub(c, oX);
    vC := CASE WHEN s ~ '^\d+$' THEN s::bigint END;
    r := r || jsonb_build_object('S10a_canary_published', pg_temp.pass(
      vC = 4 AND (SELECT NOT released AND canary_org = oX FROM public.sender_rule_sets WHERE version = 4)
      AND (SELECT version FROM public.sender_rule_set_pins WHERE org_id = oX) = 4, s));
    r := r || jsonb_build_object('S10b_who_gets_what', pg_temp.pass(
      pg_temp.cur(u6) = '4' AND pg_temp.cur(u8) = '4' AND pg_temp.cur(u9) = '3' AND pg_temp.cur(u5) = '3',
      'u6=' || pg_temp.cur(u6) || ' u8=' || pg_temp.cur(u8) || ' u9=' || pg_temp.cur(u9) || ' u5=' || pg_temp.cur(u5)));
    r := r || jsonb_build_object('S14_unpinned_org_never_gets_canary', pg_temp.pass(pg_temp.cur(u7) = '3', 'u7=' || pg_temp.cur(u7)));
    s := pg_temp.pin(oY, 424242);
    s2 := pg_temp.pin(oY, 1);
    s3 := pg_temp.pin(NULL, 4);
    r := r || jsonb_build_object('S10c_pin_refusals', pg_temp.pass(
      s = 'ERR 22023 Version not found' AND s2 LIKE 'ERR 22023 Cannot pin below the latest released%'
      AND s3 = 'ERR 22023 Organization required' AND pg_temp.cur(u7) = '3'
      AND NOT EXISTS (SELECT 1 FROM public.sender_rule_set_pins WHERE org_id = oY),
      s || ' | ' || s2 || ' | ' || s3));
    s := pg_temp.pin(oY, 4);
    s2 := pg_temp.cur(u7);
    s3 := pg_temp.pin(oY, NULL);
    s4 := pg_temp.cur(u7);
    s5 := pg_temp.pin(oX, NULL);
    r := r || jsonb_build_object('S10d_pin_and_unpin', pg_temp.pass(
      s = '""' AND s2 = '4' AND s3 = '""' AND s4 = '3' AND s5 = '""' AND pg_temp.cur(u6) = '3'
      AND NOT EXISTS (SELECT 1 FROM public.sender_rule_set_pins),
      s || ' ' || s2 || ' ' || s3 || ' ' || s4 || ' ' || s5 || ' u6=' || pg_temp.cur(u6)));

    -- ===== S11: the corpus through the SQL validator, and 4 rejects through publish =====
    s := '';
    SELECT count(*) INTO n FROM jsonb_array_elements(corpus) e;
    FOR d IN SELECT e FROM jsonb_array_elements(corpus) e LOOP
      IF (public._sender_rule_set_invalid(d->'content') IS NULL) IS DISTINCT FROM (d->>'sql')::boolean THEN
        s := s || (d->>'name') || '; ';
      END IF;
    END LOOP;
    r := r || jsonb_build_object('S11a_corpus_sql_side', pg_temp.pass(s = '' AND n > 200, 'n=' || n || ' wrong: ' || s));
    n := (SELECT count(*) FROM public.sender_rule_sets);
    s := pg_temp.pub(jsonb_set(seed, '{suppress,extra}', '1'));
    s2 := pg_temp.pub(jsonb_set(seed, '{suppress,localParts}', '[{"value":"x","match":"exact","extra":1}]'));
    s3 := pg_temp.pub(jsonb_set(seed, '{modes,gmailUpdates,detector}', '"live"'));
    s4 := pg_temp.pub(jsonb_set(seed, '{suppress,hosts}', '["a b"]'), oX);
    r := r || jsonb_build_object('S11b_publish_refuses_invalid', pg_temp.pass(
      s LIKE INVALID AND s2 LIKE INVALID AND s3 LIKE INVALID AND s4 LIKE INVALID
      AND (SELECT count(*) FROM public.sender_rule_sets) = n,
      s || ' | ' || s2 || ' | ' || s3 || ' | ' || s4));

    -- ===== S13: live-without-pin sweep. 18 cells x {off->live, measure->live} = exactly 36 refusals =====
    -- allowed transitions first: live->measure, then everything off (live->off, measure->off)
    s := pg_temp.pub(pg_temp.sig(pg_temp.latest(), 'seedAddress', 'measure'));
    s2 := pg_temp.pub(pg_temp.allm(pg_temp.latest(), 'off'));
    n := 0; n2 := 0; s4 := '';
    v := pg_temp.maxv();
    FOR k, f IN SELECT a.key, b.key FROM jsonb_each(seed->'modes') a, jsonb_each(a.value) b WHERE a.key <> 'gmailUpdates' LOOP
      s3 := pg_temp.pub(jsonb_set(pg_temp.latest(), ARRAY['modes', k, f], '"live"'));
      IF s3 LIKE GUARD THEN n := n + 1; ELSE s4 := s4 || 'off:' || k || '.' || f || '=' || left(s3, 20) || ' '; END IF;
    END LOOP;
    s5 := pg_temp.pub(pg_temp.allm(pg_temp.latest(), 'measure'));   -- off -> measure: allowed
    FOR k, f IN SELECT a.key, b.key FROM jsonb_each(seed->'modes') a, jsonb_each(a.value) b WHERE a.key <> 'gmailUpdates' LOOP
      s3 := pg_temp.pub(jsonb_set(pg_temp.latest(), ARRAY['modes', k, f], '"live"'));
      IF s3 LIKE GUARD THEN n := n + 1; ELSE s4 := s4 || 'measure:' || k || '.' || f || '=' || left(s3, 20) || ' '; END IF;
    END LOOP;
    FOREACH f IN ARRAY ARRAY['learnQuestions', 'addressPass', 'detector'] LOOP
      IF pg_temp.pub(jsonb_set(pg_temp.latest(), ARRAY['modes', 'gmailUpdates', f], '"live"')) LIKE INVALID THEN n2 := n2 + 1; END IF;
    END LOOP;
    r := r || jsonb_build_object('S13_sweep_36_refusals', pg_temp.pass(
      s ~ '^\d+$' AND s2 ~ '^\d+$' AND s5 ~ '^\d+$' AND n = 36 AND n2 = 3
      AND pg_temp.maxv() = v + 1,
      'live->measure=' || s || ' ->off=' || s2 || ' ->measure=' || s5 || ' refused=' || n || '/36 gmailUpdates=' || n2 || ' allowed: ' || s4));

    -- ===== S15: promotion clears canary pins; a canary older than the latest release does not count =====
    c := jsonb_set(pg_temp.latest(), '{modes,localPart,addressPass}', '"live"');
    s := pg_temp.pub(c, oX);
    s2 := pg_temp.cur(u6);
    s3 := pg_temp.pub(c);
    vR := CASE WHEN s3 ~ '^\d+$' THEN s3::bigint END;
    r := r || jsonb_build_object('S15a_promotion', pg_temp.pass(
      s ~ '^\d+$' AND s2 = s AND vR = s::bigint + 1
      AND NOT EXISTS (SELECT 1 FROM public.sender_rule_set_pins)
      AND pg_temp.cur(u6) = s3 AND pg_temp.cur(u7) = s3,
      'canary=' || s || ' u6=' || s2 || ' release=' || s3 || ' u6=' || pg_temp.cur(u6) || ' u7=' || pg_temp.cur(u7)));
    s := pg_temp.pub(jsonb_set(pg_temp.latest(), '{modes,localPart,addressPass}', '"measure"'));
    s2 := pg_temp.pub(jsonb_set(pg_temp.latest(), '{modes,localPart,addressPass}', '"live"'));
    r := r || jsonb_build_object('S15b_stale_canary_does_not_count', pg_temp.pass(s ~ '^\d+$' AND s2 LIKE GUARD, s || ' | ' || s2));

    -- ===== Q: list changes that hide more mail under a live signal need a canary =====
    -- setup: approvedHost live through canary + promotion
    c := pg_temp.sig(pg_temp.latest(), 'approvedHost', 'live');
    s := pg_temp.pub(c, oX); s2 := pg_temp.pub(c);
    r := r || jsonb_build_object('Q0_setup_approvedHost_live', pg_temp.pass(s ~ '^\d+$' AND s2 ~ '^\d+$', s || ' | ' || s2));
    -- Q1: a host added while approvedHost is live -> refused, DETAIL names it
    c := jsonb_set(pg_temp.latest(), '{suppress,hosts}', '["q1.example.test"]');
    s := pg_temp.pub(c);
    s2 := pg_temp.detail_as(u1, format('SELECT to_jsonb(public.sender_rule_set_publish(%L::jsonb))', c));
    r := r || jsonb_build_object('Q1_host_added_live_refused', pg_temp.pass(
      s LIKE GUARD AND s2 <> 'none' AND s2::jsonb = '[{"kind":"add","list":"suppress.hosts","item":"q1.example.test"}]'::jsonb,
      s || ' detail=' || s2));
    -- Q2: the same after a canary that holds the host -> allowed
    s := pg_temp.pub(c, oX); s2 := pg_temp.pub(c);
    r := r || jsonb_build_object('Q2_host_added_after_canary_allowed', pg_temp.pass(s ~ '^\d+$' AND s2 ~ '^\d+$', s || ' | ' || s2));
    -- Q4: seedAddress live (canary + promotion), then swap one address for another (same length) -> refused
    c := pg_temp.sig(pg_temp.latest(), 'seedAddress', 'live');
    s := pg_temp.pub(c, oX); s2 := pg_temp.pub(c);
    c := jsonb_set(pg_temp.latest(), '{suppress,exactAddresses,0}', '"swap@mail.example.test"');
    s3 := pg_temp.pub(c);
    r := r || jsonb_build_object('Q4_same_length_swap_refused', pg_temp.pass(
      s ~ '^\d+$' AND s2 ~ '^\d+$' AND s3 LIKE GUARD
      AND jsonb_array_length(c #> '{suppress,exactAddresses}') = jsonb_array_length(pg_temp.latest() #> '{suppress,exactAddresses}'),
      s || ' | ' || s2 || ' | ' || s3));
    -- Q5: localPart live with {q5, exact} (canary + promotion), then match exact -> prefix -> refused
    c := jsonb_set(pg_temp.sig(pg_temp.latest(), 'localPart', 'live'), '{suppress,localParts}', '[{"value":"q5","match":"exact"}]');
    s := pg_temp.pub(c, oX); s2 := pg_temp.pub(c);
    s3 := pg_temp.pub(jsonb_set(pg_temp.latest(), '{suppress,localParts}', '[{"match":"prefix","value":"q5"}]'));
    s4 := pg_temp.pub(jsonb_set(pg_temp.latest(), '{suppress,localParts}', '[{"match":"exact","value":"q5"}]'));
    r := r || jsonb_build_object('Q5_localpart_match_change_refused', pg_temp.pass(
      s ~ '^\d+$' AND s2 ~ '^\d+$' AND s3 LIKE GUARD AND s4 ~ '^\d+$',
      s || ' | ' || s2 || ' | prefix=' || s3 || ' | same-reordered=' || s4));
    -- Q6: a deal-platform host removed from keep while S1-S6 is live -> refused
    s := pg_temp.pub(jsonb_set(pg_temp.latest(), '{keep,platformHosts}', (pg_temp.latest() #> '{keep,platformHosts}') - 'docusign.net'));
    -- Q7: a free-mail domain added while S1-S6 is live -> refused
    s2 := pg_temp.pub(jsonb_set(pg_temp.latest(), '{freeMailDomains}', (pg_temp.latest()->'freeMailDomains') || '"q7.example.test"'));
    r := r || jsonb_build_object('Q6_keep_host_removed_refused', pg_temp.pass(s LIKE GUARD, s));
    r := r || jsonb_build_object('Q7_freemail_added_refused', pg_temp.pass(s2 LIKE GUARD, s2));
    -- Q8: bulkHeaders live (canary + promotion); autoSubmittedCounts false -> true refused; a header key added refused
    c := pg_temp.sig(pg_temp.latest(), 'bulkHeaders', 'live');
    s := pg_temp.pub(c, oX); s2 := pg_temp.pub(c);
    s3 := pg_temp.pub(jsonb_set(pg_temp.latest(), '{suppress,bulkHeaders,autoSubmittedCounts}', 'true'));
    s4 := pg_temp.pub(jsonb_set(pg_temp.latest(), '{suppress,bulkHeaders,anyKeyPresent}',
                                (pg_temp.latest() #> '{suppress,bulkHeaders,anyKeyPresent}') || '"precedence"'));
    s5 := pg_temp.pub(jsonb_set(pg_temp.latest(), '{suppress,bulkHeaders,precedenceValues}',
                                (pg_temp.latest() #> '{suppress,bulkHeaders,precedenceValues}') || '"q8"'));
    r := r || jsonb_build_object('Q8_bulk_headers_widened_refused', pg_temp.pass(
      s ~ '^\d+$' AND s2 ~ '^\d+$' AND s3 LIKE GUARD AND s4 LIKE GUARD AND s5 LIKE GUARD,
      s || ' | ' || s2 || ' | auto=' || s3 || ' | key=' || s4 || ' | prec=' || s5));
    -- Q9: removing items (hides less) is allowed under a live signal
    s := pg_temp.pub(jsonb_set(pg_temp.latest(), '{suppress,hosts}', '[]'));
    r := r || jsonb_build_object('Q9_removal_allowed', pg_temp.pass(s ~ '^\d+$', s));
    -- Q3: approvedHost measure everywhere (allowed), then a host added -> allowed (guard not over-strict)
    s := pg_temp.pub(pg_temp.sig(pg_temp.latest(), 'approvedHost', 'measure'));
    s2 := pg_temp.pub(jsonb_set(pg_temp.latest(), '{suppress,hosts}', '["q3.example.test"]'));
    r := r || jsonb_build_object('Q3_host_added_signal_measure_allowed', pg_temp.pass(s ~ '^\d+$' AND s2 ~ '^\d+$', s || ' | ' || s2));

    -- ===== S16: revert_all -> newest bundled content as a new released version, every pin gone, guard bypassed =====
    vb := pg_temp.maxv() + 1;
    INSERT INTO public.sender_rule_sets (version, content, released, bundled)
    VALUES (vb, jsonb_set(jsonb_set(seed, '{version}', to_jsonb(vb)), '{freeMailDomains}',
                          (seed->'freeMailDomains') || '"bundled2.example.test"'), true, true);
    s := pg_temp.pub(pg_temp.sig(pg_temp.latest(), 'seedAddress', 'measure'));     -- live -> measure
    vM := CASE WHEN s ~ '^\d+$' THEN s::bigint END;
    s2 := pg_temp.pub(pg_temp.latest(), oX);
    s3 := pg_temp.pin(oY, CASE WHEN s2 ~ '^\d+$' THEN s2::bigint END);
    s4 := pg_temp.revert();
    vN := CASE WHEN s4 ~ '^\d+$' THEN s4::bigint END;
    r := r || jsonb_build_object('S16_revert_all', pg_temp.pass(
      vM IS NOT NULL AND s3 = '""' AND vN = vM + 2
      AND (SELECT content - 'version' FROM public.sender_rule_sets WHERE version = vN)
          = (SELECT content - 'version' FROM public.sender_rule_sets WHERE version = vb)
      AND (SELECT content->'version' = to_jsonb(vN) AND released AND NOT bundled AND canary_org IS NULL
             FROM public.sender_rule_sets WHERE version = vN)
      AND NOT EXISTS (SELECT 1 FROM public.sender_rule_set_pins)
      AND pg_temp.cur(u6) = vN::text AND pg_temp.cur(u7) = vN::text AND pg_temp.cur(u9) = vN::text,
      'vb=' || vb || ' vM=' || coalesce(vM::text, s) || ' canary=' || s2 || ' pinY=' || s3 || ' revert=' || s4
      || ' u6=' || pg_temp.cur(u6) || ' u7=' || pg_temp.cur(u7) || ' pins=' || (SELECT count(*) FROM public.sender_rule_set_pins)));

    -- ===== S17: rollback = publish old content again -> a NEW version; every existing row byte-identical =====
    s2 := (SELECT md5(string_agg(x::text, '|' ORDER BY x.version)) FROM public.sender_rule_sets x);
    v := pg_temp.maxv();
    s := pg_temp.pub((SELECT content FROM public.sender_rule_sets WHERE version = vM));
    r := r || jsonb_build_object('S17_rollback_is_new_version', pg_temp.pass(
      s = (v + 1)::text
      AND (SELECT md5(string_agg(x::text, '|' ORDER BY x.version)) FROM public.sender_rule_sets x WHERE x.version <= v) = s2
      AND (SELECT content - 'version' FROM public.sender_rule_sets WHERE version = v + 1)
          = (SELECT content - 'version' FROM public.sender_rule_sets WHERE version = vM),
      s || ' expected ' || (v + 1)));

    -- ===== S20: the rollback removes every object (tables before validators) =====
    BEGIN
      EXECUTE $rb$__ROLLBACK__$rb$;
      s := CASE WHEN to_regclass('public.sender_rule_sets') IS NULL
                 AND to_regclass('public.sender_rule_set_pins') IS NULL
                 AND (SELECT count(*) FROM pg_proc WHERE proname LIKE '%sender_rule_set%') = 0
                 AND NOT EXISTS (SELECT 1 FROM public.reports WHERE report_key = 'sender-rules')
                 AND NOT EXISTS (SELECT 1 FROM public.report_access WHERE report_key = 'sender-rules')
            THEN 'removed' ELSE 'left: procs=' || (SELECT string_agg(proname, ',') FROM pg_proc WHERE proname LIKE '%sender_rule_set%')
                 || ' tables=' || coalesce(to_regclass('public.sender_rule_sets')::text, '-') END;
      RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
      ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 100); END IF;
    END;
    r := r || jsonb_build_object('S20_rollback_removes_everything', pg_temp.pass(s = 'removed', s));

    RETURN r;
  END $b$$f$;

  v_r := pg_temp.run();
  RAISE EXCEPTION 'P4175_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(v_r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'));
END
$drv$;
