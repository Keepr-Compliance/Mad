-- BACKLOG-4144 M1 DB controls: reports catalog, report_access, the private access helper, the caller-bound
-- wrapper, the report_access_* RPCs, and the report-access predicate added to four BACKLOG-4087 functions.
-- Venue: keepr-test ONLY (kt-sql refuses the production ref). ONE call, ONE transaction ending in RAISE,
-- so nothing persists. Run with compose.py --with-migration (M1 applied TWICE in front), or after
-- 20261105100000 is applied. Needs 20261104200000 (BACKLOG-4087) applied.
-- Mutations are applied to the migration FILE by mutate.py, then this runs with --with-migration.
-- Fixtures (invented; ids are built at run time from fx(n), emails p4144-<n>@example.test; roles
-- picked BY NAME):
--   users  1 A Super Admin   2 B Support Supervisor   3 C Support Supervisor   4 D Super Admin
--          5 E Support Agent (internal role WITHOUT analytics.view)   6 F authenticated, no internal role
--   views  21 V = A on funnel   22 W = B on funnel   23 X = C on funnel   24 Y = B on exports
-- Output: RAISE 'P4144_RESULT {total, pass, fail, reds, checks}'.

DO $drv$
DECLARE
  v_r jsonb;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
    SELECT ('00000000-0000-4144-8000-' || lpad(n::text, 12, '0'))::uuid
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);
  END $b$$f$;

  -- run one SELECT returning jsonb as a role ('authenticated' with a user, or 'anon'):
  -- the reply as text, or 'ERR <sqlstate> <message>'
  EXECUTE $f$CREATE FUNCTION pg_temp.call_as(u uuid, q text, r text DEFAULT 'authenticated') RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE j jsonb;
  BEGIN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
      PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
      PERFORM set_config('request.jwt.claim.role', r, true);
      EXECUTE format('SET LOCAL ROLE %I', r);
      EXECUTE q INTO j;
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN coalesce(j::text, 'null');
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
    END;
  END $b$$f$;

  -- the caller's access to one report: '"owner"' | '"editor"' | '"viewer"' | 'null' | 'ERR ...'
  EXECUTE $f$CREATE FUNCTION pg_temp.my(u uuid, k text) RETURNS text LANGUAGE sql AS $b$
    SELECT pg_temp.call_as(u, format('SELECT to_jsonb(public.report_my_access(%L))', k))
  $b$$f$;

  -- report_list_my_reports as a user, as 'key:access,...' sorted, '-' when empty, or the error
  EXECUTE $f$CREATE FUNCTION pg_temp.mine(u uuid) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE s text;
  BEGIN
    s := pg_temp.call_as(u, 'SELECT public.report_list_my_reports()');
    IF s LIKE 'ERR%' THEN RETURN s; END IF;
    RETURN coalesce((SELECT string_agg((e->>'report_key') || ':' || (e->>'access'), ',' ORDER BY e->>'report_key')
                       FROM jsonb_array_elements(s::jsonb) e), '-');
  END $b$$f$;

  -- saved views listed for a user on a key: ids (last 2 chars) sorted, '-' when empty, or the error
  EXECUTE $f$CREATE FUNCTION pg_temp.views(u uuid, k text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE s text;
  BEGIN
    s := pg_temp.call_as(u, format('SELECT public.report_list_saved_views(%L)', k));
    IF s LIKE 'ERR%' THEN RETURN s; END IF;
    RETURN coalesce((SELECT string_agg(right(e->>'id', 2), ',' ORDER BY e->>'id') FROM jsonb_array_elements(s::jsonb) e), '-');
  END $b$$f$;

  -- fixture user ids (last 2 chars) in a candidates/list reply (real keepr-test users ignored), sorted, '-' when empty, or the error
  EXECUTE $f$CREATE FUNCTION pg_temp.uids(s text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN s LIKE 'ERR%' THEN s ELSE
      coalesce((SELECT string_agg(right(e->>'user_id', 2), ',' ORDER BY e->>'user_id') FROM jsonb_array_elements(s::jsonb) e
                 WHERE e->>'user_id' LIKE '00000000-0000-4144-8000-%'), '-') END
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.pass(ok boolean, detail text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || left(coalesce(detail, 'null'), 260) END
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.def(sig text) RETURNS text LANGUAGE sql AS $b$
    SELECT pg_get_functiondef(sig::regprocedure)
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.acl(sig text) RETURNS text LANGUAGE sql AS $b$
    SELECT coalesce(proacl::text, 'null') || ' definer=' || prosecdef || ' cfg=' || coalesce(proconfig::text, 'null')
      FROM pg_proc WHERE oid = sig::regprocedure
  $b$$f$;

  -- client-callable functions added by M1
  EXECUTE $f$CREATE FUNCTION pg_temp.rpcs() RETURNS text[] LANGUAGE sql AS $b$
    SELECT ARRAY['public.report_my_access(text)',
                 'public.report_list_my_reports()',
                 'public.report_access_list(text)',
                 'public.report_access_set(text,uuid,text)',
                 'public.report_access_remove(text,uuid)',
                 'public.report_access_candidates(text)']
  $b$$f$;

  -- BACKLOG-4087 functions amended by M1
  EXECUTE $f$CREATE FUNCTION pg_temp.amended() RETURNS text[] LANGUAGE sql AS $b$
    SELECT ARRAY['public.report_list_saved_views(text)',
                 'public.report_save_view(text,text,jsonb,jsonb,boolean,uuid)',
                 'public.report_share_candidates(uuid)',
                 'public.report_share_set(uuid,uuid,text)']
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    s text; s2 text; s3 text; s4 text; n int; n2 int; ok boolean; d0 text; a0 text; k text;
    uA uuid := pg_temp.fx(1); uB uuid := pg_temp.fx(2); uC uuid := pg_temp.fx(3);
    uD uuid := pg_temp.fx(4); uE uuid := pg_temp.fx(5); uF uuid := pg_temp.fx(6);
    V uuid := pg_temp.fx(21); W uuid := pg_temp.fx(22); XV uuid := pg_temp.fx(23); YV uuid := pg_temp.fx(24);
    r_sa uuid := (SELECT id FROM public.admin_roles WHERE name = 'Super Admin');
    r_ss uuid := (SELECT id FROM public.admin_roles WHERE name = 'Support Supervisor');
    r_ag uuid := (SELECT id FROM public.admin_roles WHERE name = 'Support Agent');
    m1 text := '{"col":"rows","fn":"count"}';
    NF text := 'ERR P0001 Report not found';
    VNF text := 'ERR P0001 Saved view not found';
    helper text := 'public._report_access_role(uuid,text)';
    keys text[] := ARRAY['analytics','exports','funnel','google-messages-sync','iphone-sync','submissions','support-sla','user-activity'];
    msgs text[];
  BEGIN
    -- ===== C7a: start closed. Before any fixture, no access row exists, and the catalog holds exactly the 8 registry keys =====
    r := r || jsonb_build_object('C7a_start_closed_catalog_8', pg_temp.pass(
      (SELECT count(*) FROM public.report_access) = 0
      AND (SELECT array_agg(report_key ORDER BY report_key) FROM public.reports) = keys,
      'access rows=' || (SELECT count(*) FROM public.report_access) || ' keys=' || (SELECT string_agg(report_key, ',' ORDER BY report_key) FROM public.reports)));

    -- ===== fixtures =====
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT pg_temp.fx(x), 'p4144-' || x || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM generate_series(1, 6) x;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    SELECT pg_temp.fx(x), 'p4144-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'P4144 user ' || x
      FROM generate_series(1, 6) x
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;
    INSERT INTO public.internal_roles (user_id, role_id) VALUES (uA, r_sa), (uB, r_ss), (uC, r_ss), (uD, r_sa), (uE, r_ag);
    INSERT INTO public.report_saved_views (id, user_id, report_key, name, filters, metric) VALUES
      (V, uA, 'funnel', 'A funnel', '{"q":"a"}', m1::jsonb),
      (W, uB, 'funnel', 'B funnel', '{}', m1::jsonb),
      (XV, uC, 'funnel', 'C funnel', '{}', m1::jsonb),
      (YV, uB, 'exports', 'B exports', '{}', m1::jsonb);

    r := r || jsonb_build_object('K0_fixtures', pg_temp.pass(
      r_sa IS NOT NULL AND r_ss IS NOT NULL AND r_ag IS NOT NULL
      AND (SELECT is_system FROM public.admin_roles WHERE id = r_sa)
      AND NOT (SELECT is_system FROM public.admin_roles WHERE id = r_ss)
      AND (SELECT count(*) FROM public.report_saved_views WHERE user_id IN (uA, uB, uC)) = 4
      AND NOT EXISTS (SELECT 1 FROM public.internal_roles WHERE user_id = uF)
      AND NOT EXISTS (SELECT 1 FROM public.report_access WHERE user_id IN (uA, uB, uC, uD, uE, uF)),
      'fixture mismatch'));

    -- ===== P0: role simulation binds the caller. A Super Admin reads a non-empty answer; the table is closed to the client =====
    s := pg_temp.mine(uA);
    s2 := pg_temp.call_as(uA, 'SELECT to_jsonb(count(*)) FROM public.report_access');
    s3 := pg_temp.call_as(uA, 'SELECT to_jsonb(count(*)) FROM public.reports');
    r := r || jsonb_build_object('P0_superadmin_nonempty_and_tables_closed', pg_temp.pass(
      pg_temp.my(uA, 'funnel') = '"owner"' AND pg_temp.my(uB, 'funnel') = 'null'
      AND s = (SELECT string_agg(x || ':owner', ',' ORDER BY x) FROM unnest(keys) x)
      AND s2 LIKE 'ERR 42501 permission denied%' AND s3 LIKE 'ERR 42501 permission denied%',
      'A=' || pg_temp.my(uA, 'funnel') || ' mine=' || s || ' | ' || s2 || ' | ' || s3));

    -- ===== C7b: an eligible non-Super-Admin opens nothing before a grant =====
    r := r || jsonb_build_object('C7b_eligible_user_sees_no_report', pg_temp.pass(
      pg_temp.mine(uB) = '-' AND pg_temp.mine(uC) = '-',
      'B=' || pg_temp.mine(uB) || ' C=' || pg_temp.mine(uC)));

    -- ===== C1: the access function per key. Owners on all 8; everyone else on none; unknown key = nobody =====
    s := '';
    FOREACH k IN ARRAY keys LOOP
      IF NOT (pg_temp.my(uA, k) = '"owner"' AND pg_temp.my(uD, k) = '"owner"'
              AND pg_temp.my(uB, k) = 'null' AND pg_temp.my(uC, k) = 'null'
              AND pg_temp.my(uE, k) = 'null' AND pg_temp.my(uF, k) = 'null') THEN
        s := s || k || '[A' || pg_temp.my(uA, k) || ' D' || pg_temp.my(uD, k) || ' B' || pg_temp.my(uB, k)
               || ' E' || pg_temp.my(uE, k) || '] ';
      END IF;
    END LOOP;
    r := r || jsonb_build_object('C1a_per_key_closed_except_owners', pg_temp.pass(
      s = '' AND pg_temp.my(uA, 'p4144-unknown') = 'null', s || ' unknown=' || pg_temp.my(uA, 'p4144-unknown')));

    -- grant B viewer on funnel through the RPC: funnel only
    s2 := pg_temp.call_as(uA, format('SELECT public.report_access_set(%L, %L::uuid, %L)', 'funnel', uB, 'viewer'));
    s := '';
    FOREACH k IN ARRAY keys LOOP
      IF pg_temp.my(uB, k) <> (CASE WHEN k = 'funnel' THEN '"viewer"' ELSE 'null' END) THEN
        s := s || k || '=' || pg_temp.my(uB, k) || ' ';
      END IF;
    END LOOP;
    r := r || jsonb_build_object('C1b_grant_opens_that_key_only', pg_temp.pass(
      s2 NOT LIKE 'ERR%' AND s = '' AND pg_temp.mine(uB) = 'funnel:viewer' AND pg_temp.mine(uC) = '-'
      AND (SELECT granted_by FROM public.report_access WHERE report_key = 'funnel' AND user_id = uB) = uA,
      s2 || ' | ' || s || ' mine=' || pg_temp.mine(uB)));

    -- ===== C3: revocation takes effect on the next read, in the same session =====
    s := pg_temp.call_as(uA, format('SELECT public.report_access_remove(%L, %L::uuid)', 'funnel', uB));
    r := r || jsonb_build_object('C3a_remove_closes_next_read', pg_temp.pass(
      s NOT LIKE 'ERR%' AND pg_temp.my(uB, 'funnel') = 'null' AND pg_temp.mine(uB) = '-',
      s || ' my=' || pg_temp.my(uB, 'funnel')));
    -- a row stays, the role loses analytics.view
    PERFORM pg_temp.call_as(uA, format('SELECT public.report_access_set(%L, %L::uuid, %L)', 'funnel', uB, 'viewer'));
    s := pg_temp.my(uB, 'funnel');
    UPDATE public.internal_roles SET role_id = r_ag WHERE user_id = uB;
    s2 := pg_temp.my(uB, 'funnel'); s3 := pg_temp.mine(uB);
    UPDATE public.internal_roles SET role_id = r_ss WHERE user_id = uB;
    s4 := pg_temp.my(uB, 'funnel');
    r := r || jsonb_build_object('C3b_role_without_analytics_view_closes', pg_temp.pass(
      s = '"viewer"' AND s2 = 'null' AND s3 = '-' AND s4 = '"viewer"',
      'before=' || s || ' agent=' || s2 || '/' || s3 || ' back=' || s4));
    -- a row for a user whose role never had analytics.view stays closed; the RPC will not write one
    INSERT INTO public.report_access (report_key, user_id, role) VALUES ('funnel', uE, 'editor');
    s := pg_temp.call_as(uA, format('SELECT public.report_access_set(%L, %L::uuid, %L)', 'exports', uE, 'viewer'));
    r := r || jsonb_build_object('C3c_row_without_analytics_view_closed', pg_temp.pass(
      pg_temp.my(uE, 'funnel') = 'null' AND pg_temp.mine(uE) = '-' AND s = NF
      AND NOT EXISTS (SELECT 1 FROM public.report_access WHERE report_key = 'exports' AND user_id = uE),
      'E=' || pg_temp.my(uE, 'funnel') || ' set=' || s));
    DELETE FROM public.report_access WHERE user_id = uE;
    PERFORM pg_temp.call_as(uA, format('SELECT public.report_access_remove(%L, %L::uuid)', 'funnel', uB));

    -- ===== C5: a shared saved view stays hidden until the recipient has report access (4 paths) =====
    -- V (A, funnel) is shared with B (editor) and C (viewer) by direct rows; B and C have no report access yet.
    INSERT INTO public.report_saved_view_shares (view_id, user_id, role, granted_by) VALUES (V, uB, 'editor', uA), (V, uC, 'viewer', uA);
    s := pg_temp.views(uC, 'funnel');
    s2 := pg_temp.call_as(uB, format('SELECT public.report_save_view(%L, NULL, %L::jsonb, %L::jsonb, false, %L::uuid)', 'funnel', '{"q":"b"}', m1, V));
    s3 := pg_temp.uids(pg_temp.call_as(uA, format('SELECT public.report_share_candidates(%L::uuid)', V)));
    d0 := pg_temp.call_as(uA, format('SELECT public.report_share_set(%L::uuid, %L::uuid, %L)', V, uC, 'editor'));
    -- now grant both
    PERFORM pg_temp.call_as(uA, format('SELECT public.report_access_set(%L, %L::uuid, %L)', 'funnel', uB, 'viewer'));
    PERFORM pg_temp.call_as(uA, format('SELECT public.report_access_set(%L, %L::uuid, %L)', 'funnel', uC, 'viewer'));
    r := r || jsonb_build_object('C5a_list_hides_shared_view_without_access', pg_temp.pass(
      s = '23' AND pg_temp.views(uC, 'funnel') = '21,23',
      'before=' || s || ' after=' || pg_temp.views(uC, 'funnel')));
    -- (the after-call runs as its own statement: a query does not see writes made by a function it calls)
    s4 := pg_temp.call_as(uB, format('SELECT public.report_save_view(%L, NULL, %L::jsonb, %L::jsonb, false, %L::uuid)', 'funnel', '{"q":"b2"}', m1, V));
    r := r || jsonb_build_object('C5b_editor_save_needs_access', pg_temp.pass(
      s2 = VNF AND s4 NOT LIKE 'ERR%'
      AND (SELECT filters->>'q' FROM public.report_saved_views WHERE id = V) = 'b2',
      'before=' || s2 || ' after=' || s4 || ' q=' || (SELECT filters->>'q' FROM public.report_saved_views WHERE id = V)));
    s := pg_temp.uids(pg_temp.call_as(uA, format('SELECT public.report_share_candidates(%L::uuid)', V)));
    r := r || jsonb_build_object('C5c_share_candidates_need_access', pg_temp.pass(
      s3 = '04' AND s = '02,03,04',
      'before=' || s3 || ' after=' || s));
    s := pg_temp.call_as(uA, format('SELECT public.report_share_set(%L::uuid, %L::uuid, %L)', V, uC, 'editor'));
    r := r || jsonb_build_object('C5d_share_set_grantee_needs_access', pg_temp.pass(
      d0 = VNF AND s NOT LIKE 'ERR%'
      AND (SELECT role FROM public.report_saved_view_shares WHERE view_id = V AND user_id = uC) = 'editor',
      'before=' || d0 || ' after=' || s));

    -- ===== C8: editor vs viewer for view sharing. B = editor, C = viewer on funnel; neither on exports =====
    PERFORM pg_temp.call_as(uA, format('SELECT public.report_access_set(%L, %L::uuid, %L)', 'funnel', uB, 'editor'));
    s := pg_temp.call_as(uB, format('SELECT public.report_share_set(%L::uuid, %L::uuid, %L)', W, uC, 'viewer'));
    s2 := pg_temp.uids(pg_temp.call_as(uB, format('SELECT public.report_share_candidates(%L::uuid)', W)));
    r := r || jsonb_build_object('C8a_editor_shares_own_view', pg_temp.pass(
      s NOT LIKE 'ERR%' AND s2 = '01,03,04' AND pg_temp.views(uC, 'funnel') = '21,22,23',
      s || ' cand=' || s2 || ' C=' || pg_temp.views(uC, 'funnel')));
    s := pg_temp.call_as(uC, format('SELECT public.report_share_set(%L::uuid, %L::uuid, %L)', XV, uB, 'viewer'));
    s2 := pg_temp.call_as(uC, format('SELECT public.report_share_candidates(%L::uuid)', XV));
    r := r || jsonb_build_object('C8b_viewer_cannot_share', pg_temp.pass(
      s = VNF AND s2 = VNF AND NOT EXISTS (SELECT 1 FROM public.report_saved_view_shares WHERE view_id = XV),
      s || ' | ' || s2));
    s := pg_temp.call_as(uB, format('SELECT public.report_share_set(%L::uuid, %L::uuid, %L)', YV, uA, 'viewer'));
    s2 := pg_temp.call_as(uB, format('SELECT public.report_share_candidates(%L::uuid)', YV));
    r := r || jsonb_build_object('C8c_editor_scoped_to_its_report', pg_temp.pass(
      s = VNF AND s2 = VNF AND NOT EXISTS (SELECT 1 FROM public.report_saved_view_shares WHERE view_id = YV),
      s || ' | ' || s2));

    -- ===== C9: only owners manage report access; a grantee may remove only their own =====
    msgs := ARRAY[
      pg_temp.call_as(uB, format('SELECT public.report_access_list(%L)', 'funnel')),
      pg_temp.call_as(uB, format('SELECT public.report_access_set(%L, %L::uuid, %L)', 'funnel', uC, 'editor')),
      pg_temp.call_as(uB, format('SELECT public.report_access_remove(%L, %L::uuid)', 'funnel', uC)),
      pg_temp.call_as(uB, format('SELECT public.report_access_candidates(%L)', 'funnel'))];
    r := r || jsonb_build_object('C9a_editor_cannot_manage_access', pg_temp.pass(
      (SELECT bool_and(x = NF) FROM unnest(msgs) x)
      AND (SELECT role FROM public.report_access WHERE report_key = 'funnel' AND user_id = uC) = 'viewer',
      (SELECT string_agg(left(x, 60), ' | ') FROM unnest(msgs) x)));
    s := pg_temp.call_as(uA, format('SELECT public.report_access_list(%L)', 'funnel'));
    s2 := pg_temp.call_as(uA, format('SELECT public.report_access_candidates(%L)', 'funnel'));
    r := r || jsonb_build_object('C9b_owner_list_and_candidates', pg_temp.pass(
      s NOT LIKE 'ERR%' AND s2 NOT LIKE 'ERR%'
      AND (SELECT string_agg(right(x->>'user_id', 1) || (x->>'role'), ',' ORDER BY x->>'user_id') FROM jsonb_array_elements(s::jsonb) x) = '2editor,3viewer'
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s::jsonb) c, jsonb_object_keys(c) kk WHERE kk NOT IN ('user_id', 'display_name', 'role', 'created_at'))
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(s2::jsonb) c WHERE c->>'user_id' = uB::text AND c->>'display_name' = 'P4144 user 2')
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(s2::jsonb) c WHERE c->>'user_id' = uC::text)
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s2::jsonb) c WHERE c->>'user_id' IN (uA::text, uD::text, uE::text, uF::text))
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s2::jsonb) c, jsonb_object_keys(c) kk WHERE kk NOT IN ('user_id', 'display_name')),
      left(s, 120) || ' | ' || left(s2, 120)));
    -- the owner cannot grant: themself, another owner, an ineligible user, a non-internal user, an unknown key
    msgs := ARRAY[
      pg_temp.call_as(uA, format('SELECT public.report_access_set(%L, %L::uuid, %L)', 'funnel', uA, 'viewer')),
      pg_temp.call_as(uA, format('SELECT public.report_access_set(%L, %L::uuid, %L)', 'funnel', uD, 'viewer')),
      pg_temp.call_as(uA, format('SELECT public.report_access_set(%L, %L::uuid, %L)', 'funnel', uE, 'viewer')),
      pg_temp.call_as(uA, format('SELECT public.report_access_set(%L, %L::uuid, %L)', 'funnel', uF, 'viewer')),
      pg_temp.call_as(uA, format('SELECT public.report_access_set(%L, %L::uuid, %L)', 'p4144-unknown', uC, 'viewer')),
      pg_temp.call_as(uA, format('SELECT public.report_access_list(%L)', 'p4144-unknown')),
      pg_temp.call_as(uA, format('SELECT public.report_access_candidates(%L)', 'p4144-unknown'))];
    r := r || jsonb_build_object('C9c_owner_grant_limits', pg_temp.pass(
      (SELECT bool_and(x = NF) FROM unnest(msgs) x)
      AND NOT EXISTS (SELECT 1 FROM public.report_access WHERE user_id IN (uA, uD, uE, uF))
      AND pg_temp.call_as(uA, format('SELECT public.report_access_set(%L, %L::uuid, %L)', 'funnel', uC, 'owner')) = 'ERR P0001 A report access role must be viewer or editor',
      (SELECT string_agg(DISTINCT left(x, 60), ' | ') FROM unnest(msgs) x)));
    -- a grantee removes their own access (and only their own)
    s := pg_temp.call_as(uC, format('SELECT public.report_access_remove(%L, %L::uuid)', 'funnel', uB));
    s2 := pg_temp.call_as(uC, format('SELECT public.report_access_remove(%L, %L::uuid)', 'funnel', uC));
    r := r || jsonb_build_object('C9d_grantee_removes_only_self', pg_temp.pass(
      s = NF AND s2 NOT LIKE 'ERR%' AND pg_temp.my(uC, 'funnel') = 'null' AND pg_temp.my(uB, 'funnel') = '"editor"',
      s || ' | ' || s2));
    PERFORM pg_temp.call_as(uA, format('SELECT public.report_access_set(%L, %L::uuid, %L)', 'funnel', uC, 'viewer'));

    -- ===== K10: one refusal message across every report_access_* refusal =====
    msgs := ARRAY[
      pg_temp.call_as(uB, format('SELECT public.report_access_list(%L)', 'funnel')),
      pg_temp.call_as(uB, format('SELECT public.report_access_list(%L)', 'exports')),
      pg_temp.call_as(uB, format('SELECT public.report_access_list(%L)', 'p4144-unknown')),
      pg_temp.call_as(uE, format('SELECT public.report_access_list(%L)', 'funnel')),
      pg_temp.call_as(uB, format('SELECT public.report_access_candidates(%L)', 'funnel')),
      pg_temp.call_as(uE, format('SELECT public.report_access_candidates(%L)', 'funnel')),
      pg_temp.call_as(uB, format('SELECT public.report_access_set(%L, %L::uuid, %L)', 'funnel', uC, 'viewer')),
      pg_temp.call_as(uE, format('SELECT public.report_access_set(%L, %L::uuid, %L)', 'funnel', uC, 'viewer')),
      pg_temp.call_as(uA, format('SELECT public.report_access_set(%L, %L::uuid, %L)', 'funnel', uD, 'viewer')),
      pg_temp.call_as(uA, format('SELECT public.report_access_set(%L, %L::uuid, %L)', 'funnel', uE, 'viewer')),
      pg_temp.call_as(uA, format('SELECT public.report_access_set(%L, %L::uuid, %L)', 'funnel', NULL, 'viewer')),
      pg_temp.call_as(uB, format('SELECT public.report_access_remove(%L, %L::uuid)', 'funnel', uC)),
      pg_temp.call_as(uA, format('SELECT public.report_access_remove(%L, %L::uuid)', 'funnel', uD)),
      pg_temp.call_as(uA, format('SELECT public.report_access_remove(%L, %L::uuid)', 'p4144-unknown', uB))];
    r := r || jsonb_build_object('K10_one_refusal_message', pg_temp.pass(
      (SELECT bool_and(x = NF) FROM unnest(msgs) x) AND cardinality(msgs) = 14,
      (SELECT string_agg(DISTINCT left(x, 60), ' | ') FROM unnest(msgs) x)));

    -- ===== K13: anon refused on every client function; non-internal callers refused; helper not callable =====
    SELECT array_agg(pg_temp.call_as(NULL, format('SELECT to_jsonb(%s)', q), 'anon')) INTO msgs FROM unnest(ARRAY[
      format('public.report_my_access(%L)', 'funnel'),
      'public.report_list_my_reports()',
      format('public.report_access_list(%L)', 'funnel'),
      format('public.report_access_set(%L, %L::uuid, %L)', 'funnel', uC, 'viewer'),
      format('public.report_access_remove(%L, %L::uuid)', 'funnel', uC),
      format('public.report_access_candidates(%L)', 'funnel'),
      format('public._report_access_role(%L::uuid, %L)', uA, 'funnel')]) q;
    s := pg_temp.call_as(uB, format('SELECT to_jsonb(public._report_access_role(%L::uuid, %L))', uA, 'funnel'));
    SELECT array_agg(pg_temp.call_as(uF, format('SELECT to_jsonb(%s)', q))) INTO s2 FROM unnest(ARRAY[
      'public.report_list_my_reports()',
      format('public.report_access_list(%L)', 'funnel'),
      format('public.report_access_set(%L, %L::uuid, %L)', 'funnel', uC, 'viewer'),
      format('public.report_access_remove(%L, %L::uuid)', 'funnel', uC),
      format('public.report_access_candidates(%L)', 'funnel')]) q;
    r := r || jsonb_build_object('K13_anon_non_internal_helper_refused', pg_temp.pass(
      (SELECT bool_and(x LIKE 'ERR 42501 permission denied%') FROM unnest(msgs) x) AND cardinality(msgs) = 7
      AND s LIKE 'ERR 42501 permission denied%'
      AND (SELECT bool_and(x LIKE 'ERR 42501 Access denied%') FROM unnest(s2::text[]) x)
      AND pg_temp.my(uF, 'funnel') = 'null',
      (SELECT string_agg(DISTINCT left(x, 40), ' | ') FROM unnest(msgs) x) || ' helper=' || s || ' F=' || left(s2, 120)));

    -- ===== C4: privileges catalog =====
    SELECT count(*) INTO n FROM unnest(pg_temp.rpcs() || pg_temp.amended()) sig JOIN pg_proc p ON p.oid = sig::regprocedure
     WHERE NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
       AND p.prosecdef AND p.proconfig = ARRAY['search_path=public'];
    SELECT count(*) INTO n2 FROM unnest(ARRAY['public.reports', 'public.report_access']) t,
           unnest(ARRAY['anon', 'authenticated']) g,
           unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) pv
     WHERE has_table_privilege(g, t, pv);
    r := r || jsonb_build_object('C4_privileges_catalog', pg_temp.pass(
      n = 10 AND n2 = 0
      AND (SELECT prosecdef AND proconfig = ARRAY['search_path=public']
                  AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
                  AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                  AND NOT EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0)
             FROM pg_proc WHERE oid = helper::regprocedure)
      AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                       WHERE table_schema = 'public' AND table_name IN ('reports', 'report_access') AND grantee = 'PUBLIC')
      AND (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.reports'::regclass, 'public.report_access'::regclass))
      AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('reports', 'report_access')),
      n || ' of 10 functions compliant; ' || n2 || ' table privileges held; helper ' || pg_temp.acl(helper)));

    -- ===== K16: re-applying the migration changes nothing, and seeds no access row (C7) =====
    d0 := (SELECT string_agg(md5(pg_temp.def(x)), ',') FROM unnest(pg_temp.rpcs() || pg_temp.amended() || helper) x);
    a0 := (SELECT string_agg(pg_temp.acl(x), ',') FROM unnest(pg_temp.rpcs() || pg_temp.amended() || helper) x);
    n := (SELECT count(*) FROM public.report_access);
    BEGIN
      EXECUTE $mg$__MIGRATION__$mg$;
      s := CASE WHEN (SELECT string_agg(md5(pg_temp.def(x)), ',') FROM unnest(pg_temp.rpcs() || pg_temp.amended() || helper) x) = d0
                 AND (SELECT string_agg(pg_temp.acl(x), ',') FROM unnest(pg_temp.rpcs() || pg_temp.amended() || helper) x) = a0
                 AND (SELECT count(*) FROM public.report_access) = n
                 AND (SELECT count(*) FROM public.reports) = 8
            THEN 'same' ELSE 'changed access_rows=' || (SELECT count(*) FROM public.report_access) || '/' || n END;
      RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
      ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
    END;
    r := r || jsonb_build_object('K16_reapply_idempotent_no_seed', pg_temp.pass(s = 'same', s));

    -- ===== K17: the rollback restores the four 4087 bodies exactly and removes every M1 object =====
    BEGIN
      EXECUTE $rb$__ROLLBACK__$rb$;
      s := CASE WHEN md5(pg_temp.def('public.report_list_saved_views(text)')) = 'a31218b2c09af74eb8565b659d15dc23'
                 AND md5(pg_temp.def('public.report_save_view(text,text,jsonb,jsonb,boolean,uuid)')) = '5a109e6acdaaa3e1c158089da097668c'
                 AND md5(pg_temp.def('public.report_share_candidates(uuid)')) = '50c4e9612edd1778d58e56655b1c461a'
                 AND md5(pg_temp.def('public.report_share_set(uuid,uuid,text)')) = 'bfe2f5e7f00c91fa93fe78901bd31057'
                 AND to_regclass('public.reports') IS NULL
                 AND to_regclass('public.report_access') IS NULL
                 AND to_regprocedure(helper) IS NULL
                 AND NOT EXISTS (SELECT 1 FROM unnest(pg_temp.rpcs()) x WHERE to_regprocedure(x) IS NOT NULL)
                 AND to_regprocedure('public._report_share_eligible(uuid)') IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261105100000')
                 AND (SELECT bool_and(has_function_privilege('authenticated', x, 'EXECUTE') AND NOT has_function_privilege('anon', x, 'EXECUTE'))
                        FROM unnest(pg_temp.amended()) x)
            THEN 'restored' ELSE 'not restored ' || md5(pg_temp.def('public.report_list_saved_views(text)')) END;
      RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
      ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
    END;
    r := r || jsonb_build_object('K17_rollback_restores', pg_temp.pass(s = 'restored', s));

    RETURN r;
  END $b$$f$;

  v_r := pg_temp.run();
  RAISE EXCEPTION 'P4144_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(v_r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'));
END
$drv$;
