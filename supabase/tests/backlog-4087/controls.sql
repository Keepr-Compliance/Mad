-- BACKLOG-4087 DB controls: report_saved_view_shares, the report_share_* RPCs, the amended
-- report_list_saved_views / report_save_view / report_delete_saved_view, grants, and the 3450
-- isolation control ported into this harness (P1/P2).
-- Venue: keepr-test ONLY (kt-sql refuses the production ref). ONE call, ONE transaction ending in RAISE,
-- so nothing persists. Run with compose.py --with-migration (the migration is applied TWICE in front),
-- or after 20261104200000 is applied.
-- Mutations are applied to the migration FILE by mutate.py, then this runs with --with-migration.
-- Fixtures (invented; ids are built at run time from fx(n), emails p4087-<n>@example.test; roles
-- picked BY NAME):
--   users  1 A Super Admin (owner)   2 B Support Supervisor (editor, holds 5 own pins)
--          3 C Support Supervisor (viewer)   4 D Super Admin (nothing shared with them)
--          5 E Support Agent (internal role WITHOUT analytics.view)   6 F authenticated, no internal role
--   views  21 V = A, pinned AND default (shared)   22 W = A, not shared   31-35 B pins   41 X = B, not shared
--          all on report key p4087; 99 = an id that matches nothing
-- Output: RAISE 'P4087_RESULT {total, pass, fail, reds, checks}'.

DO $drv$
DECLARE
  v_r jsonb;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
    SELECT ('00000000-0000-4087-8000-' || lpad(n::text, 12, '0'))::uuid
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

  EXECUTE $f$CREATE FUNCTION pg_temp.list(u uuid, k text DEFAULT 'p4087') RETURNS text LANGUAGE sql AS $b$
    SELECT pg_temp.call_as(u, format('SELECT public.report_list_saved_views(%L)', k))
  $b$$f$;

  -- ids (last 2 chars) in a list reply, sorted, or the error
  EXECUTE $f$CREATE FUNCTION pg_temp.ids(s text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN s LIKE 'ERR%' THEN s ELSE
      coalesce((SELECT string_agg(right(e->>'id', 2), ',' ORDER BY e->>'id') FROM jsonb_array_elements(s::jsonb) e), '-') END
  $b$$f$;

  -- one element of a list reply by id, or NULL
  EXECUTE $f$CREATE FUNCTION pg_temp.elem(s text, id uuid) RETURNS jsonb LANGUAGE sql AS $b$
    SELECT CASE WHEN s LIKE 'ERR%' THEN NULL ELSE
      (SELECT e FROM jsonb_array_elements(s::jsonb) e WHERE e->>'id' = id::text LIMIT 1) END
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.save(u uuid, name text, filters text, metric text, pinned boolean, id uuid) RETURNS text LANGUAGE sql AS $b$
    SELECT pg_temp.call_as(u, format('SELECT public.report_save_view(%L, %L, %L::jsonb, %L::jsonb, %L, %L::uuid)',
      'p4087', name, filters, metric, pinned, id))
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.pass(ok boolean, detail text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || left(coalesce(detail, 'null'), 220) END
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.def(sig text) RETURNS text LANGUAGE sql AS $b$
    SELECT pg_get_functiondef(sig::regprocedure)
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.acl(sig text) RETURNS text LANGUAGE sql AS $b$
    SELECT coalesce(proacl::text, 'null') || ' definer=' || prosecdef || ' cfg=' || coalesce(proconfig::text, 'null')
      FROM pg_proc WHERE oid = sig::regprocedure
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.sigs() RETURNS text[] LANGUAGE sql AS $b$
    SELECT ARRAY['public.report_list_saved_views(text)',
                 'public.report_save_view(text,text,jsonb,jsonb,boolean,uuid)',
                 'public.report_delete_saved_view(uuid)',
                 'public.report_set_default_view(text,uuid)',
                 'public.report_share_candidates(uuid)',
                 'public.report_share_list(uuid)',
                 'public.report_share_set(uuid,uuid,text)',
                 'public.report_share_remove(uuid,uuid)']
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    s text; s2 text; s3 text; n int; ok boolean; d0 text; a0 text; ej jsonb;
    uA uuid := pg_temp.fx(1); uB uuid := pg_temp.fx(2); uC uuid := pg_temp.fx(3);
    uD uuid := pg_temp.fx(4); uE uuid := pg_temp.fx(5); uF uuid := pg_temp.fx(6);
    V uuid := pg_temp.fx(21); W uuid := pg_temp.fx(22); XV uuid := pg_temp.fx(41); MISS uuid := pg_temp.fx(99);
    r_sa uuid := (SELECT id FROM public.admin_roles WHERE name = 'Super Admin');
    r_ss uuid := (SELECT id FROM public.admin_roles WHERE name = 'Support Supervisor');
    r_ag uuid := (SELECT id FROM public.admin_roles WHERE name = 'Support Agent');
    m1 text := '{"col":"rows","fn":"count"}';
    m2 text := '{"col":"runs","fn":"sum"}';
    NF text := 'ERR P0001 Saved view not found';
    eh text := 'public._report_share_eligible(uuid)';
    msgs text[];
  BEGIN
    -- ===== fixtures =====
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT pg_temp.fx(x), 'p4087-' || x || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM generate_series(1, 6) x;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    SELECT pg_temp.fx(x), 'p4087-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'P4087 user ' || x
      FROM generate_series(1, 6) x
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;
    INSERT INTO public.internal_roles (user_id, role_id) VALUES (uA, r_sa), (uB, r_ss), (uC, r_ss), (uD, r_sa), (uE, r_ag);

    INSERT INTO public.report_saved_views (id, user_id, report_key, name, filters, metric, pinned, is_default) VALUES
      (V, uA, 'p4087', 'A one', '{"q":"a"}', m1::jsonb, true, true),
      (W, uA, 'p4087', 'A two', '{}', m1::jsonb, false, false),
      (XV, uB, 'p4087', 'B unshared', '{}', m1::jsonb, false, false);
    INSERT INTO public.report_saved_views (id, user_id, report_key, name, filters, metric, pinned)
    SELECT pg_temp.fx(30 + g), uB, 'p4087', 'B pin ' || g, '{}', m1::jsonb, true FROM generate_series(1, 5) g;

    r := r || jsonb_build_object('K0_fixtures', pg_temp.pass(
      r_sa IS NOT NULL AND r_ss IS NOT NULL AND r_ag IS NOT NULL
      AND (SELECT count(*) FROM public.report_saved_views WHERE user_id IN (uA, uB)) = 8
      AND (SELECT count(*) FROM public.report_saved_views WHERE user_id = uB AND pinned) = 5
      AND (SELECT pinned AND is_default FROM public.report_saved_views WHERE id = V)
      AND NOT EXISTS (SELECT 1 FROM public.internal_roles WHERE user_id = uF)
      AND NOT EXISTS (SELECT 1 FROM public.report_saved_view_shares WHERE view_id IN (V, W, XV)),
      'fixture mismatch'));

    -- ===== K1: the owner shares through the RPC; the recipients list it =====
    s := pg_temp.call_as(uA, format('SELECT public.report_share_set(%L::uuid, %L::uuid, %L)', V, uB, 'editor'));
    s2 := pg_temp.call_as(uA, format('SELECT public.report_share_set(%L::uuid, %L::uuid, %L)', V, uC, 'viewer'));
    r := r || jsonb_build_object('K1a_owner_shares', pg_temp.pass(
      s NOT LIKE 'ERR%' AND s2 NOT LIKE 'ERR%'
      AND (SELECT string_agg(right(user_id::text, 1) || role || '/' || right(granted_by::text, 1), ',' ORDER BY user_id)
             FROM public.report_saved_view_shares WHERE view_id = V) = '2editor/1,3viewer/1',
      s || ' | ' || s2));
    s := pg_temp.list(uB); s2 := pg_temp.list(uC);
    r := r || jsonb_build_object('K1b_recipients_list_it', pg_temp.pass(
      pg_temp.ids(s) = '21,31,32,33,34,35,41' AND pg_temp.ids(s2) = '21'
      AND pg_temp.elem(s, V)->>'access' = 'editor' AND pg_temp.elem(s2, V)->>'access' = 'viewer'
      AND pg_temp.elem(s, V)->>'owner_name' = 'P4087 user 1'
      AND pg_temp.elem(s, XV)->>'access' = 'owner',
      'B=' || pg_temp.ids(s) || ' C=' || pg_temp.ids(s2) || ' ' || coalesce(pg_temp.elem(s, V)::text, 'noV')));

    -- ===== K2: mask. The owner's view is pinned AND default; the recipient sees both false =====
    ej := pg_temp.elem(pg_temp.list(uB), V);
    r := r || jsonb_build_object('K2_mask_pinned_and_default', pg_temp.pass(
      ej IS NOT NULL AND jsonb_typeof(ej->'pinned') = 'boolean' AND (ej->>'pinned')::boolean = false
      AND jsonb_typeof(ej->'is_default') = 'boolean' AND (ej->>'is_default')::boolean = false,
      coalesce(ej::text, 'V not listed for uB')));
    ej := pg_temp.elem(pg_temp.list(uA), V);
    r := r || jsonb_build_object('K2b_owner_flags_intact', pg_temp.pass(
      (ej->>'pinned')::boolean AND (ej->>'is_default')::boolean AND ej->>'access' = 'owner' AND NOT (ej ? 'owner_name'),
      coalesce(ej::text, 'V not listed for uA')));

    -- ===== K3: editor save. B holds 5 own pins and sends a new name, p_pinned=true, new filters + metric =====
    s := pg_temp.save(uB, 'hijack', '{"q":"b"}', m2, true, V);
    r := r || jsonb_build_object('K3_editor_save_filters_metric_only', pg_temp.pass(
      s NOT LIKE 'ERR%'
      AND (SELECT name = 'A one' AND pinned AND is_default AND user_id = uA AND filters->>'q' = 'b' AND metric->>'fn' = 'sum'
             FROM public.report_saved_views WHERE id = V)
      AND (SELECT count(*) FROM public.report_saved_views WHERE user_id = uB AND pinned) = 5,
      s || ' row=' || (SELECT name || '/' || pinned || '/' || is_default || '/' || filters::text || '/' || metric::text FROM public.report_saved_views WHERE id = V)));

    -- ===== K4: a viewer, and an internal user with no share, cannot save; same message as a missing id =====
    s := pg_temp.save(uC, 'x', '{"q":"v"}', m1, false, V);
    s2 := pg_temp.save(uD, 'x', '{"q":"d"}', m1, false, V);
    s3 := pg_temp.save(uC, 'x', '{}', m1, false, MISS);
    r := r || jsonb_build_object('K4_viewer_and_stranger_cannot_save', pg_temp.pass(
      s = NF AND s2 = NF AND s3 = NF
      AND (SELECT filters->>'q' = 'b' AND name = 'A one' FROM public.report_saved_views WHERE id = V)
      AND NOT EXISTS (SELECT 1 FROM public.report_saved_views WHERE id = MISS),
      s || ' | ' || s2 || ' | ' || s3));

    -- ===== K5: an editor (and a viewer) cannot re-share =====
    s := pg_temp.call_as(uB, format('SELECT public.report_share_set(%L::uuid, %L::uuid, %L)', V, uD, 'viewer'));
    s2 := pg_temp.call_as(uC, format('SELECT public.report_share_set(%L::uuid, %L::uuid, %L)', V, uD, 'editor'));
    s3 := pg_temp.call_as(uB, format('SELECT public.report_share_set(%L::uuid, %L::uuid, %L)', V, uC, 'editor'));
    r := r || jsonb_build_object('K5_editor_reshare_refused', pg_temp.pass(
      s = NF AND s2 = NF AND s3 = NF
      AND NOT EXISTS (SELECT 1 FROM public.report_saved_view_shares WHERE view_id = V AND user_id = uD)
      AND (SELECT role FROM public.report_saved_view_shares WHERE view_id = V AND user_id = uC) = 'viewer',
      s || ' | ' || s2 || ' | ' || s3));

    -- ===== K6: candidates. Owner only; eligible users only; never the caller; id + display name only =====
    s := pg_temp.call_as(uA, format('SELECT public.report_share_candidates(%L::uuid)', V));
    ok := s NOT LIKE 'ERR%';
    r := r || jsonb_build_object('K6a_candidates', pg_temp.pass(ok
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(s::jsonb) c WHERE c->>'user_id' = uB::text AND c->>'display_name' = 'P4087 user 2')
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(s::jsonb) c WHERE c->>'user_id' = uC::text)
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(s::jsonb) c WHERE c->>'user_id' = uD::text)
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s::jsonb) c WHERE c->>'user_id' IN (uA::text, uE::text, uF::text))
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s::jsonb) c, jsonb_object_keys(c) k WHERE k NOT IN ('user_id', 'display_name')),
      left(s, 200)));
    s := pg_temp.call_as(uB, format('SELECT public.report_share_candidates(%L::uuid)', V));
    s2 := pg_temp.call_as(uD, format('SELECT public.report_share_candidates(%L::uuid)', V));
    r := r || jsonb_build_object('K6b_candidates_owner_only', pg_temp.pass(s = NF AND s2 = NF, s || ' | ' || s2));

    -- ===== K7: share list. The owner sees every grantee; a grantee sees only their own row =====
    s := pg_temp.call_as(uA, format('SELECT public.report_share_list(%L::uuid)', V));
    s2 := pg_temp.call_as(uB, format('SELECT public.report_share_list(%L::uuid)', V));
    s3 := pg_temp.call_as(uD, format('SELECT public.report_share_list(%L::uuid)', V));
    r := r || jsonb_build_object('K7_share_list', pg_temp.pass(
      s NOT LIKE 'ERR%' AND s2 NOT LIKE 'ERR%'
      AND (SELECT string_agg(right(x->>'user_id', 1) || (x->>'role'), ',' ORDER BY x->>'user_id') FROM jsonb_array_elements(s::jsonb) x) = '2editor,3viewer'
      AND (SELECT string_agg(right(x->>'user_id', 1) || (x->>'role'), ',') FROM jsonb_array_elements(s2::jsonb) x) = '2editor'
      AND s3 = NF,
      left(s, 90) || ' | ' || left(s2, 90) || ' | ' || s3));

    -- ===== K8: direct table reads by a recipient =====
    s := pg_temp.call_as(uB, format('SELECT to_jsonb(count(*)) FROM public.report_saved_views WHERE id = %L', V));
    s2 := pg_temp.call_as(uB, 'SELECT to_jsonb(count(*)) FROM public.report_saved_view_shares');
    r := r || jsonb_build_object('K8_recipient_direct_select', pg_temp.pass(
      s = '0' AND s2 LIKE 'ERR 42501 permission denied%', s || ' | ' || s2));

    -- ===== K9: no role sees views not shared with it (Super Admin included) =====
    s := pg_temp.list(uD); s2 := pg_temp.list(uA);
    r := r || jsonb_build_object('K9_admin_sees_only_shared', pg_temp.pass(
      pg_temp.ids(s) = '-' AND pg_temp.ids(s2) = '21,22',
      'uD=' || pg_temp.ids(s) || ' uA=' || pg_temp.ids(s2)));

    -- ===== K10: one refusal message across every id-taking RPC =====
    msgs := ARRAY[
      pg_temp.save(uD, 'x', '{}', m1, false, V),
      pg_temp.save(uD, 'x', '{}', m1, false, MISS),
      pg_temp.call_as(uD, format('SELECT public.report_delete_saved_view(%L::uuid)', V)),
      pg_temp.call_as(uB, format('SELECT public.report_delete_saved_view(%L::uuid)', V)),
      pg_temp.call_as(uD, format('SELECT public.report_delete_saved_view(%L::uuid)', MISS)),
      pg_temp.call_as(uD, format('SELECT public.report_share_candidates(%L::uuid)', V)),
      pg_temp.call_as(uD, format('SELECT public.report_share_candidates(%L::uuid)', MISS)),
      pg_temp.call_as(uD, format('SELECT public.report_share_list(%L::uuid)', V)),
      pg_temp.call_as(uD, format('SELECT public.report_share_list(%L::uuid)', MISS)),
      pg_temp.call_as(uD, format('SELECT public.report_share_set(%L::uuid, %L::uuid, %L)', V, uC, 'viewer')),
      pg_temp.call_as(uD, format('SELECT public.report_share_set(%L::uuid, %L::uuid, %L)', MISS, uC, 'viewer')),
      pg_temp.call_as(uA, format('SELECT public.report_share_set(%L::uuid, %L::uuid, %L)', V, uE, 'viewer')),
      pg_temp.call_as(uA, format('SELECT public.report_share_set(%L::uuid, %L::uuid, %L)', V, uF, 'viewer')),
      pg_temp.call_as(uA, format('SELECT public.report_share_set(%L::uuid, %L::uuid, %L)', V, uA, 'viewer')),
      pg_temp.call_as(uD, format('SELECT public.report_share_remove(%L::uuid, %L::uuid)', V, uB)),
      pg_temp.call_as(uD, format('SELECT public.report_share_remove(%L::uuid, %L::uuid)', MISS, uB))];
    r := r || jsonb_build_object('K10_one_refusal_message', pg_temp.pass(
      (SELECT bool_and(x = NF) FROM unnest(msgs) x) AND cardinality(msgs) = 16
      AND NOT EXISTS (SELECT 1 FROM public.report_saved_view_shares WHERE view_id = V AND user_id IN (uA, uE, uF))
      AND EXISTS (SELECT 1 FROM public.report_saved_views WHERE id = V),
      (SELECT string_agg(DISTINCT x, ' | ') FROM unnest(msgs) x)));

    -- ===== K11: revoke = the grantee moves to an internal role WITHOUT analytics.view =====
    UPDATE public.internal_roles SET role_id = r_ag WHERE user_id = uB;
    s := pg_temp.list(uB);
    s2 := pg_temp.save(uB, 'x', '{"q":"z"}', m1, false, V);
    s3 := pg_temp.call_as(uB, format('SELECT public.report_share_list(%L::uuid)', V));
    ok := pg_temp.call_as(uA, format('SELECT public.report_share_candidates(%L::uuid)', V)) NOT LIKE '%' || uB::text || '%';
    r := r || jsonb_build_object('K11_grantee_loses_analytics_view', pg_temp.pass(
      s NOT LIKE 'ERR%' AND pg_temp.ids(s) = '31,32,33,34,35,41' AND s2 = NF AND s3 = NF AND ok
      AND (SELECT filters->>'q' FROM public.report_saved_views WHERE id = V) = 'b',
      'list=' || pg_temp.ids(s) || ' save=' || s2 || ' sl=' || s3 || ' cand_excl=' || ok));
    UPDATE public.internal_roles SET role_id = r_ss WHERE user_id = uB;

    -- ===== K12: owner-loss rule. An owner without eligibility makes the share inert =====
    UPDATE public.internal_roles SET role_id = r_ag WHERE user_id = uA;
    s := pg_temp.list(uB);
    s2 := pg_temp.save(uB, 'x', '{"q":"o1"}', m1, false, V);
    s3 := pg_temp.call_as(uB, format('SELECT public.report_share_list(%L::uuid)', V));
    ok := s NOT LIKE 'ERR%' AND pg_temp.ids(s) = '31,32,33,34,35,41' AND s2 = NF AND s3 = NF;
    UPDATE public.internal_roles SET role_id = r_sa WHERE user_id = uA;
    DELETE FROM public.internal_roles WHERE user_id = uA;
    s := pg_temp.list(uB);
    s2 := pg_temp.save(uB, 'x', '{"q":"o2"}', m1, false, V);
    r := r || jsonb_build_object('K12_owner_loses_eligibility', pg_temp.pass(
      ok AND s NOT LIKE 'ERR%' AND pg_temp.ids(s) = '31,32,33,34,35,41' AND s2 = NF
      AND (SELECT filters->>'q' FROM public.report_saved_views WHERE id = V) = 'b',
      'ok_role=' || ok || ' list=' || pg_temp.ids(s) || ' save=' || s2));
    INSERT INTO public.internal_roles (user_id, role_id) VALUES (uA, r_sa);
    r := r || jsonb_build_object('K12b_share_returns_with_owner', pg_temp.pass(
      pg_temp.elem(pg_temp.list(uB), V)->>'access' = 'editor', pg_temp.ids(pg_temp.list(uB))));

    -- ===== K13: callers without an internal role, and anon =====
    SELECT array_agg(pg_temp.call_as(NULL, format('SELECT to_jsonb(%s)', q), 'anon')) INTO msgs FROM unnest(ARRAY[
      format('public.report_list_saved_views(%L)', 'p4087'),
      format('public.report_save_view(%L, %L, %L::jsonb, %L::jsonb, false, NULL::uuid)', 'p4087', 'x', '{}', m1),
      format('public.report_delete_saved_view(%L::uuid)', V),
      format('public.report_share_candidates(%L::uuid)', V),
      format('public.report_share_list(%L::uuid)', V),
      format('public.report_share_set(%L::uuid, %L::uuid, %L)', V, uD, 'viewer'),
      format('public.report_share_remove(%L::uuid, %L::uuid)', V, uB),
      format('public._report_share_eligible(%L::uuid)', uA)]) q;
    s := pg_temp.call_as(uF, format('SELECT public.report_share_set(%L::uuid, %L::uuid, %L)', V, uD, 'viewer'));
    s2 := pg_temp.list(uF);
    s3 := pg_temp.call_as(uB, format('SELECT to_jsonb(public._report_share_eligible(%L::uuid))', uA));
    r := r || jsonb_build_object('K13_anon_and_non_internal_refused', pg_temp.pass(
      (SELECT bool_and(x LIKE 'ERR 42501 permission denied%') FROM unnest(msgs) x) AND cardinality(msgs) = 8
      AND s LIKE 'ERR 42501 Access denied%' AND s2 LIKE 'ERR % Access denied%'
      AND s3 LIKE 'ERR 42501 permission denied%',
      (SELECT string_agg(DISTINCT left(x, 40), ' | ') FROM unnest(msgs) x) || ' uF=' || s || ' F_list=' || s2 || ' helper=' || s3));

    -- ===== K14: catalog. Grants, SECURITY DEFINER, search_path; helper private; table closed =====
    SELECT count(*) INTO n FROM unnest(pg_temp.sigs()) sig JOIN pg_proc p ON p.oid = sig::regprocedure
     WHERE NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
       AND p.prosecdef AND p.proconfig = ARRAY['search_path=public'];
    r := r || jsonb_build_object('K14_catalog', pg_temp.pass(
      n = 8
      AND (SELECT prosecdef AND proconfig = ARRAY['search_path=public']
                  AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
                  AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                  AND NOT EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0)
             FROM pg_proc WHERE oid = eh::regprocedure)
      AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated']) g, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) pv
                       WHERE has_table_privilege(g, 'public.report_saved_view_shares', pv))
      AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                       WHERE table_schema = 'public' AND table_name = 'report_saved_view_shares' AND grantee = 'PUBLIC')
      AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.report_saved_view_shares'::regclass)
      AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'report_saved_view_shares')
      AND NOT has_table_privilege('authenticated', 'public.report_saved_views', 'TRUNCATE')
      AND NOT has_table_privilege('anon', 'public.report_saved_views', 'TRUNCATE'),
      n || ' of 8 functions compliant; helper ' || pg_temp.acl(eh)));

    -- ===== K15: remove. The owner removes any grantee; a grantee only themself; removal of the view is owner only =====
    s := pg_temp.call_as(uB, format('SELECT public.report_share_remove(%L::uuid, %L::uuid)', V, uC));
    s2 := pg_temp.call_as(uC, format('SELECT public.report_share_remove(%L::uuid, %L::uuid)', V, uC));
    s3 := pg_temp.call_as(uA, format('SELECT public.report_share_remove(%L::uuid, %L::uuid)', V, uB));
    r := r || jsonb_build_object('K15_share_remove', pg_temp.pass(
      s = NF AND s2 NOT LIKE 'ERR%' AND s3 NOT LIKE 'ERR%'
      AND NOT EXISTS (SELECT 1 FROM public.report_saved_view_shares WHERE view_id = V)
      AND pg_temp.ids(pg_temp.list(uB)) = '31,32,33,34,35,41' AND pg_temp.ids(pg_temp.list(uC)) = '-',
      s || ' | ' || s2 || ' | ' || s3));
    -- removing a view takes its shares with it
    PERFORM pg_temp.call_as(uA, format('SELECT public.report_share_set(%L::uuid, %L::uuid, %L)', W, uC, 'viewer'));
    n := (SELECT count(*) FROM public.report_saved_view_shares WHERE view_id = W);
    s := pg_temp.call_as(uA, format('SELECT public.report_delete_saved_view(%L::uuid)', W));
    r := r || jsonb_build_object('K15b_view_removal_cascades', pg_temp.pass(
      n = 1 AND s NOT LIKE 'ERR%' AND NOT EXISTS (SELECT 1 FROM public.report_saved_view_shares WHERE view_id = W),
      n || ' ' || s));

    -- ===== P1 (3450 control-1, ported): a second internal user neither sees nor removes the owner's view =====
    s := pg_temp.call_as(uA, format('SELECT public.report_save_view(%L, %L, %L::jsonb, %L::jsonb, true, NULL::uuid)',
      'control-1', 'CONTROL 1 owner view', '{"outcomes":["error"]}', m1));
    ok := s NOT LIKE 'ERR%';
    IF ok THEN
      s2 := pg_temp.ids(pg_temp.list(uD, 'control-1'));
      s3 := pg_temp.call_as(uD, format('SELECT public.report_delete_saved_view(%L::uuid)', (s::jsonb->>'id')));
      r := r || jsonb_build_object('P1_3450_isolation', pg_temp.pass(
        pg_temp.ids(pg_temp.list(uA, 'control-1')) = right(s::jsonb->>'id', 2) AND s2 = '-' AND s3 = NF
        AND EXISTS (SELECT 1 FROM public.report_saved_views WHERE id = (s::jsonb->>'id')::uuid),
        'other=' || s2 || ' remove=' || s3));
    ELSE
      r := r || jsonb_build_object('P1_3450_isolation', 'FAIL owner save: ' || s);
    END IF;

    -- ===== K16: re-applying the migration changes nothing =====
    d0 := (SELECT string_agg(md5(pg_temp.def(x)), ',') FROM unnest(pg_temp.sigs() || eh) x);
    a0 := (SELECT string_agg(pg_temp.acl(x), ',') FROM unnest(pg_temp.sigs() || eh) x);
    BEGIN
      EXECUTE $mg$__MIGRATION__$mg$;
      s := CASE WHEN (SELECT string_agg(md5(pg_temp.def(x)), ',') FROM unnest(pg_temp.sigs() || eh) x) = d0
                 AND (SELECT string_agg(pg_temp.acl(x), ',') FROM unnest(pg_temp.sigs() || eh) x) = a0
            THEN 'same' ELSE 'changed' END;
      RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
      ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
    END;
    r := r || jsonb_build_object('K16_reapply_idempotent', pg_temp.pass(s = 'same', s));

    -- ===== K17: the rollback restores the 4084 shape exactly =====
    BEGIN
      EXECUTE $rb$__ROLLBACK__$rb$;
      s := CASE WHEN md5(pg_temp.def('public.report_list_saved_views(text)')) = '08fc7184eda9c1fefd92ac1ec21c7a2e'
                 AND md5(pg_temp.def('public.report_save_view(text,text,jsonb,jsonb,boolean,uuid)')) = '8be16a2221ec9395f20e4a267c054c43'
                 AND md5(pg_temp.def('public.report_delete_saved_view(uuid)')) = '764b06c5ab3b4b26839fc3c7e5587679'
                 AND to_regclass('public.report_saved_view_shares') IS NULL
                 AND to_regprocedure('public.report_share_set(uuid,uuid,text)') IS NULL
                 AND to_regprocedure('public.report_share_list(uuid)') IS NULL
                 AND to_regprocedure('public.report_share_candidates(uuid)') IS NULL
                 AND to_regprocedure('public.report_share_remove(uuid,uuid)') IS NULL
                 AND to_regprocedure(eh) IS NULL
                 AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261104200000')
                 AND has_function_privilege('authenticated', 'public.report_list_saved_views(text)', 'EXECUTE')
                 AND NOT has_function_privilege('anon', 'public.report_list_saved_views(text)', 'EXECUTE')
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
  RAISE EXCEPTION 'P4087_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(v_r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'));
END
$drv$;
