-- harness-4c.sql: BACKLOG-4263 PR-4c observations of the removed-deal functions the desktop calls (cloud_delete_deal,
-- cloud_purge_deal_now, cloud_upsert_deal re-upload, cloud_todo_restore of a deal, cloud_list_removed,
-- cloud_list_install_rows, cloud_todo_pull), as ONE call that ends in RAISE (nothing persists).
-- Venue: the test project through ~/.claude/bin/kt-sql; afterwards: select extensions.pg_stat_statements_reset().
-- Helpers and fixtures: copied from supabase/tests/backlog-4263-pr4b/harness-4b.sql lines 2-157 and 170-226
-- (run id renamed). Only statuses, error codes, counts, booleans and relative numbers are recorded.
-- Venue: the test project through ~/.claude/bin/kt-sql; afterwards: select extensions.pg_stat_statements_reset().
-- Helpers: copied from supabase/tests/backlog-4263-pr4a/harness-4a.sql lines 7-159 (run id renamed).
-- BACKLOG-4263 PR-2 harness helpers. Loaded after the migration, inside the same transaction.
-- Every id, name and address is invented and derived from pr4c-harness (random per run, filled by harness.py).

CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $h$
  SELECT md5('p4263:pr4c-harness:' || n)::uuid
$h$;
CREATE FUNCTION pg_temp.h(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT encode(sha256(convert_to(t, 'UTF8')), 'hex')
$h$;
CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $h$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
END $h$;

-- Run one statement as an API role with the user's claims (own subtransaction). A SELECT returns its single
-- value as text; an error returns 'ERR <sqlstate> <message>'.
CREATE FUNCTION pg_temp.call_as(u uuid, q text, r text DEFAULT 'authenticated') RETURNS text LANGUAGE plpgsql AS $h$
DECLARE j jsonb; n bigint;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
    PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
    PERFORM set_config('request.jwt.claim.role', r, true);
    EXECUTE format('SET LOCAL ROLE %I', r);
    IF q ~* '^\s*(select|with)\M' THEN EXECUTE q INTO j; ELSE EXECUTE q; GET DIAGNOSTICS n = ROW_COUNT; j := to_jsonb('rows=' || n); END IF;
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.clear_claims();
    RETURN coalesce(j::text, 'null');
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.clear_claims();
    RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 200);
  END;
END $h$;
-- The same, as the database owner with the user's claims (how a SECURITY DEFINER wrapper reaches the core).
CREATE FUNCTION pg_temp.as_user(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $h$
DECLARE j jsonb;
BEGIN
  BEGIN
    IF u IS NULL THEN
      PERFORM pg_temp.clear_claims();
    ELSE
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', u::text, true);
      PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    END IF;
    EXECUTE q INTO j;
    PERFORM pg_temp.clear_claims();
    RETURN coalesce(j::text, 'null');
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.clear_claims();
    RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 200);
  END;
END $h$;
CREATE FUNCTION pg_temp.j(t text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $h$
BEGIN RETURN t::jsonb; EXCEPTION WHEN OTHERS THEN RETURN to_jsonb(t); END $h$;
CREATE FUNCTION pg_temp.pass(c boolean, detail text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN coalesce(c, false) THEN 'PASS' ELSE 'FAIL: ' || coalesce(left(detail, 700), '-') END
$h$;
CREATE FUNCTION pg_temp.all_of(VARIADIC r text[]) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN bool_and(x = 'PASS') THEN 'PASS'
              ELSE 'FAIL: ' || string_agg(CASE WHEN x <> 'PASS' THEN '#' || o || ' ' || x END, ' | ') END
    FROM unnest(r) WITH ORDINALITY t(x, o)
$h$;

-- desktop and old-path calls
CREATE FUNCTION pg_temp.onoff(u uuid, en boolean) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.call_as(u, format('SELECT public.set_my_cloud_autosave(%L::uuid, %L::boolean, 1)', u, en)))
$h$;
CREATE FUNCTION pg_temp.assign(org uuid, u uuid) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(NULL, format('SELECT public.assign_member_addon(%L::uuid, %L::uuid, %L, true, NULL::timestamptz)', org, u, 'cloud_autosave'), 'service_role')
$h$;
CREATE FUNCTION pg_temp.dp(inst uuid, lid text, extra jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT jsonb_build_object('source_install_id', inst, 'local_id', lid, 'content_hash', pg_temp.h(lid || extra::text),
                            'detection_status', 'confirmed', 'detection_source', 'manual', 'status', 'active',
                            'property_address', 'Fixture ' || lid || ' Way') || extra
$h$;
CREATE FUNCTION pg_temp.deal(u uuid, payload jsonb) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.call_as(u, format('SELECT public.cloud_upsert_deal(%L::uuid, %L::jsonb)', u, payload)))
$h$;
CREATE FUNCTION pg_temp.up(u uuid, fn text, inst uuid, deal uuid, rows jsonb) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.call_as(u, format('SELECT public.%I(%L::uuid, %L::uuid, %L::uuid, %L::jsonb)', fn, u, inst, deal, rows)))
$h$;
CREATE FUNCTION pg_temp.rw(lid text, extra jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT jsonb_build_object('local_id', lid, 'content_hash', pg_temp.h(lid || extra::text)) || extra
$h$;
CREATE FUNCTION pg_temp.deldeal(u uuid, d uuid) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.call_as(u, format('SELECT public.cloud_delete_deal(%L::uuid, %L::uuid)', u, d)))
$h$;
CREATE FUNCTION pg_temp.delinst(u uuid, i uuid) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.call_as(u, format('SELECT public.cloud_delete_install(%L::uuid, %L::uuid)', u, i)))
$h$;
CREATE FUNCTION pg_temp.push(u uuid, inst uuid, sent text, ops jsonb) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.call_as(u, format('SELECT public.cloud_todo_push(%L::uuid, %L::uuid, %L::text, %L::jsonb)', u, inst, sent, ops)))
$h$;
CREATE FUNCTION pg_temp.pull(u uuid, inst uuid, after bigint, lim int DEFAULT 500, horizon bigint DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.call_as(u, format('SELECT public.cloud_todo_pull(%L::uuid, %L::uuid, %L::bigint, %L::integer, %L::bigint)', u, inst, after, lim, horizon)))
$h$;
CREATE FUNCTION pg_temp.rpc(u uuid, q text) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.call_as(u, q))
$h$;
-- an AI-app change, through the core, as a definer wrapper would make it
CREATE FUNCTION pg_temp.ai(u uuid, ops jsonb, ref text DEFAULT 'conn-1') RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.as_user(u, format('SELECT public._cloud_todo_apply(%L::uuid, %L::jsonb, %L::jsonb)', u,
           jsonb_build_object('kind', 'ai_app', 'ref', ref, 'label', 'Claude'), ops)))
$h$;
CREATE FUNCTION pg_temp.r0(res jsonb, n int DEFAULT 0) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$ SELECT res -> 'results' -> n $h$;
CREATE FUNCTION pg_temp.st(res jsonb, n int DEFAULT 0) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(res -> 'results' -> n ->> 'status', 'ERROR:' || coalesce(res ->> 'error', res::text))
$h$;
CREATE FUNCTION pg_temp.nowt(off interval DEFAULT '0') RETURNS text LANGUAGE sql VOLATILE AS $h$
  SELECT to_char((clock_timestamp() + off) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$h$;
-- op builders (a new op_id each call)
CREATE FUNCTION pg_temp.op_set(id uuid, part text, val jsonb, base bigint DEFAULT NULL, es bigint DEFAULT NULL, edited text DEFAULT NULL) RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  SELECT jsonb_strip_nulls(jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'set', 'entity', 'item', 'id', id, 'part', part,
           'base_rev', base, 'edit_seq', es, 'edited_at', edited)) || jsonb_build_object('value', val)
$h$;
CREATE FUNCTION pg_temp.op(kind text, ent text, id uuid, edited text DEFAULT NULL) RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  SELECT jsonb_strip_nulls(jsonb_build_object('op_id', gen_random_uuid(), 'kind', kind, 'entity', ent, 'id', id, 'edited_at', edited))
$h$;
CREATE FUNCTION pg_temp.it(id uuid) RETURNS public.cloud_deal_checklist_items LANGUAGE sql STABLE AS $h$
  SELECT * FROM public.cloud_deal_checklist_items WHERE id = it.id
$h$;
CREATE FUNCTION pg_temp.hist_n(id uuid, kind text DEFAULT NULL) RETURNS bigint LANGUAGE sql STABLE AS $h$
  SELECT count(*) FROM public.cloud_todo_history h WHERE h.entity_id = hist_n.id AND (hist_n.kind IS NULL OR h.kind = hist_n.kind)
$h$;
CREATE FUNCTION pg_temp.head(u uuid) RETURNS bigint LANGUAGE sql STABLE AS $h$
  SELECT coalesce((SELECT last_seq FROM public.cloud_todo_feed_head WHERE owner_user_id = u), 0)
$h$;
-- every row of a pull loop from `after` (page size lim), carrying the horizon as the desktop must:
-- {ids:[...], seqs:[...], pages:n, resync:bool}
CREATE FUNCTION pg_temp.pull_all(u uuid, inst uuid, after bigint, lim int, horizon bigint DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE r jsonb; a bigint := after; hz bigint := horizon; ids jsonb := '[]'; seqs jsonb := '[]'; n int := 0; rs boolean := false;
BEGIN
  LOOP
    r := pg_temp.pull(u, inst, a, lim, hz);
    IF r ->> 'ok' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('error', r); END IF;
    n := n + 1; rs := rs OR (r ->> 'resync_required')::boolean;
    ids := ids || coalesce((SELECT jsonb_agg(x ->> 'cloud_id') FROM jsonb_array_elements(r -> 'rows') x), '[]');
    seqs := seqs || coalesce((SELECT jsonb_agg((x ->> 'change_seq')::bigint) FROM jsonb_array_elements(r -> 'rows') x), '[]');
    EXIT WHEN jsonb_array_length(r -> 'rows') < lim OR n > 200;
    a := (r ->> 'next_after')::bigint; hz := (r ->> 'horizon')::bigint;
  END LOOP;
  RETURN jsonb_build_object('ids', ids, 'seqs', seqs, 'pages', n, 'resync', rs, 'last', r);
END $h$;

-- the owner's current horizon marker (what a caught-up desktop holds)
CREATE FUNCTION pg_temp.hz(u uuid) RETURNS bigint LANGUAGE sql STABLE AS $h$
  SELECT coalesce((SELECT forgotten_at FROM public.cloud_todo_feed_head WHERE owner_user_id = u), 0)
$h$;

CREATE TEMP TABLE p4c_out (o serial, k text, v jsonb);
CREATE FUNCTION pg_temp.rec(k text, v jsonb) RETURNS void LANGUAGE sql AS $h$ INSERT INTO pg_temp.p4c_out (k, v) VALUES (k, v) $h$;
CREATE TEMP TABLE p4c_fx (k text PRIMARY KEY, v text);
CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql STABLE AS $h$ SELECT v::uuid FROM pg_temp.p4c_fx WHERE p4c_fx.k = id.k $h$;
CREATE FUNCTION pg_temp.put(k text, v text) RETURNS void LANGUAGE sql AS $h$
  INSERT INTO pg_temp.p4c_fx VALUES (k, v) ON CONFLICT (k) DO UPDATE SET v = excluded.v $h$;
-- the shape of a JSON value: object -> {key: shape}, array -> [shape of first], scalar -> its type
CREATE FUNCTION pg_temp.shape(j jsonb, depth int DEFAULT 3) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $h$
DECLARE r jsonb := '{}'; k text;
BEGIN
  IF j IS NULL THEN RETURN to_jsonb('sql-null'::text); END IF;
  IF jsonb_typeof(j) = 'object' AND depth > 0 THEN
    FOR k IN SELECT jsonb_object_keys(j) LOOP r := r || jsonb_build_object(k, pg_temp.shape(j -> k, depth - 1)); END LOOP;
    RETURN r;
  END IF;
  IF jsonb_typeof(j) = 'array' AND depth > 0 THEN
    RETURN CASE WHEN jsonb_array_length(j) = 0 THEN '[]'::jsonb ELSE jsonb_build_array(pg_temp.shape(j -> 0, depth - 1)) END;
  END IF;
  RETURN to_jsonb(jsonb_typeof(j));
END $h$;
-- a page without contents: per row entity, change_seq relative to `base`, purged, removed flags
CREATE FUNCTION pg_temp.page(r jsonb, base bigint) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT jsonb_build_object('ok', r -> 'ok', 'error', r -> 'error', 'n', jsonb_array_length(coalesce(r -> 'rows', '[]')),
    'head', (r ->> 'head')::bigint - base, 'next_after', (r ->> 'next_after')::bigint - base,
    'horizon_type', jsonb_typeof(r -> 'horizon'), 'horizon_zero', (r ->> 'horizon') = '0',
    'install_max_edit_seq', r -> 'install_max_edit_seq', 'resync', r -> 'resync_required',
    'rows', coalesce((SELECT jsonb_agg(jsonb_build_object('e', x ->> 'entity', 'seq', (x ->> 'change_seq')::bigint - base,
              'purged', x -> 'purged', 'removed', CASE WHEN x ->> 'entity' = 'deal' THEN x -> 'removed_at' <> 'null'::jsonb
                                                     ELSE x -> 'parts' -> 'removed' -> 'value' -> 'removed_at' <> 'null'::jsonb END,
              'outcome', x -> 'outcome')) FROM jsonb_array_elements(r -> 'rows') x), '[]'))
$h$;
CREATE FUNCTION pg_temp.row_of(r jsonb, cid uuid) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT x FROM jsonb_array_elements(r -> 'rows') x WHERE x ->> 'cloud_id' = cid::text AND x ->> 'entity' <> 'event' LIMIT 1 $h$;
CREATE FUNCTION pg_temp.cc(dl uuid, lid text, tpl text, name text, so int) RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  SELECT jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_checklist', 'deal_id', dl, 'local_id', lid, 'template_id', tpl,
    'template_name', name, 'sort_order', so, 'is_private', tpl = 'keepr:my-items', 'edited_at', pg_temp.nowt()) $h$;
CREATE FUNCTION pg_temp.ci(dl uuid, cl text, lid text, title text, es bigint DEFAULT NULL, note text DEFAULT NULL) RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  SELECT jsonb_strip_nulls(jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_item', 'deal_id', dl, 'checklist_local_id', cl,
    'local_id', lid, 'title', title, 'is_required', false, 'done', jsonb_build_object('is_checked', false, 'checked_at', NULL),
    'sort_order', 0, 'edit_seq', es, 'edited_at', pg_temp.nowt())) || jsonb_build_object('note', note) $h$;
CREATE FUNCTION pg_temp.ds(dl uuid, ent text, lid text, part text, val jsonb, base bigint, es bigint, edited text, extra jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  SELECT jsonb_strip_nulls(jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'set', 'entity', ent, 'deal_id', dl, 'local_id', lid,
    'part', part, 'base_rev', base, 'edit_seq', es, 'edited_at', edited)) || jsonb_build_object('value', val) || extra $h$;

DO $obs$
DECLARE A uuid := pg_temp.fx(1); B uuid := pg_temp.fx(2); O uuid := pg_temp.fx(101);
        IA uuid := pg_temp.fx(301); IB uuid := pg_temp.fx(303); r jsonb; r2 jsonb; p jsonb; base bigint; a0 bigint; hz bigint;
        D1 uuid; D2 uuid; D3 uuid; D4 uuid; DBd uuid; i1 uuid; i2 uuid; i3 uuid; cl1 uuid; t0 timestamptz; t1 timestamptz; big jsonb; u uuid; npg int;
        pages jsonb := '[]'; aft bigint; lim int;
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(n), 'p4263-' || substr(md5('pr4c-harness'), 1, 8) || '-' || n || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now() FROM generate_series(1, 2) n;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(n), 'p4263-' || substr(md5('pr4c-harness'), 1, 8) || '-' || n || '@example.test', 'email', pg_temp.fx(n)::text, 'Fixture ' || n
    FROM generate_series(1, 2) n ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES (O, 'Fixture O', 'p4263-o-' || substr(md5('pr4c-harness'), 1, 8));
  INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status) VALUES
    (pg_temp.fx(201), O, A, 'agent', 'active'), (pg_temp.fx(202), O, B, 'agent', 'active');
  INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
  SELECT O, (SELECT id FROM public.plans WHERE tier = 'team' ORDER BY sort_order, name LIMIT 1), '{"cloud_autosave_assignable":{"enabled":true}}'::jsonb;
  SET LOCAL session_replication_role = origin;
  FOREACH u IN ARRAY ARRAY[A, B] LOOP
    PERFORM pg_temp.assign(O, u);
    PERFORM pg_temp.rec('on_' || CASE WHEN u = A THEN 'A' ELSE 'B' END, pg_temp.onoff(u, true) -> 'success');
  END LOOP;

  -- fixtures: A deals D1 (removed, then purged), D2 (live), D3 (removed, re-uploaded), D4 (removed, restored online)
  r := pg_temp.deal(A, pg_temp.dp(IA, 'd1')); D1 := (r -> 'results' -> 0 ->> 'cloud_id')::uuid;
  r := pg_temp.deal(A, pg_temp.dp(IA, 'd2')); D2 := (r -> 'results' -> 0 ->> 'cloud_id')::uuid;
  r := pg_temp.deal(A, pg_temp.dp(IA, 'd3')); D3 := (r -> 'results' -> 0 ->> 'cloud_id')::uuid;
  r := pg_temp.deal(A, pg_temp.dp(IA, 'd4')); D4 := (r -> 'results' -> 0 ->> 'cloud_id')::uuid;
  r := pg_temp.deal(B, pg_temp.dp(IB, 'db')); DBd := (r -> 'results' -> 0 ->> 'cloud_id')::uuid;
  r := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(
         pg_temp.cc(D1, 'cl1', 'tpl-purchase', 'Purchase', 1), pg_temp.ci(D1, 'cl1', 'i1', 'Inspection', 3),
         pg_temp.cc(D3, 'cl3', 'tpl-purchase', 'Purchase', 1), pg_temp.ci(D3, 'cl3', 'i3', 'Appraisal', 4),
         pg_temp.cc(D4, 'cl4', 'tpl-purchase', 'Purchase', 1), pg_temp.ci(D4, 'cl4', 'i4', 'Disclosure', 5)));
  PERFORM pg_temp.rec('F_push_creates', (SELECT jsonb_agg(x ->> 'status') FROM jsonb_array_elements(r -> 'results') x));
  i1 := (r -> 'results' -> 1 ->> 'cloud_id')::uuid;
  base := pg_temp.head(A);

  -- Q1 cloud_delete_deal (the desktop's removal): its answer, and a second call on the removed deal
  r := pg_temp.deldeal(A, D1);
  PERFORM pg_temp.rec('Q1_delete', jsonb_build_object('ok', r -> 'ok', 'restorable', r -> 'restorable', 'keys', (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(r) k)));
  PERFORM pg_temp.rec('Q1b_delete_again', jsonb_build_object('ok', pg_temp.deldeal(A, D1) -> 'ok'));
  PERFORM pg_temp.rec('Q1c_list_removed', jsonb_build_object('has_D1', (SELECT count(*) FROM jsonb_array_elements(pg_temp.rpc(A, format('SELECT public.cloud_list_removed(%L::uuid)', A)) -> 'deals') x WHERE x ->> 'deal_id' = D1::text),
    'deal_keys', (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.rpc(A, format('SELECT public.cloud_list_removed(%L::uuid)', A)) -> 'deals' -> 0) k)));
  PERFORM pg_temp.rec('Q1d_install_rows_removed_flag', (SELECT jsonb_agg(jsonb_build_object('d1', x ->> 'cloud_id' = D1::text, 'removed', x -> 'removed'))
    FROM jsonb_array_elements(pg_temp.rpc(A, format('SELECT public.cloud_list_install_rows(%L::uuid, %L::uuid, %L, NULL, 1000)', A, IA, 'deal')) -> 'rows') x WHERE x ->> 'cloud_id' IN (D1::text, D2::text)));

  -- Q2 cloud_purge_deal_now: the answers
  PERFORM pg_temp.rec('Q2a_live_deal', pg_temp.rpc(A, format('SELECT public.cloud_purge_deal_now(%L::uuid, %L::uuid)', A, D2)));
  PERFORM pg_temp.rec('Q2b_wrong_account', pg_temp.rpc(A, format('SELECT public.cloud_purge_deal_now(%L::uuid, %L::uuid)', B, D1)));
  PERFORM pg_temp.rec('Q2c_null_id', pg_temp.rpc(A, format('SELECT public.cloud_purge_deal_now(%L::uuid, NULL::uuid)', A)));
  PERFORM pg_temp.rec('Q2d_other_owner', pg_temp.rpc(B, format('SELECT public.cloud_purge_deal_now(%L::uuid, %L::uuid)', B, D1)));
  PERFORM pg_temp.rec('Q2e_anon', to_jsonb(left(pg_temp.call_as(NULL, format('SELECT public.cloud_purge_deal_now(%L::uuid, %L::uuid)', A, D1), 'anon'), 9)));
  PERFORM pg_temp.rec('Q2f_d1_still_there', jsonb_build_object('deal', (SELECT count(*) FROM public.cloud_deals WHERE id = D1),
    'items', (SELECT count(*) FROM public.cloud_deal_checklist_items WHERE cloud_deal_id = D1)));
  a0 := pg_temp.head(A);
  r := pg_temp.rpc(A, format('SELECT public.cloud_purge_deal_now(%L::uuid, %L::uuid)', A, D1));
  PERFORM pg_temp.rec('Q2g_purged', r);
  PERFORM pg_temp.rec('Q2h_after_purge', jsonb_build_object('deal', (SELECT count(*) FROM public.cloud_deals WHERE id = D1),
    'checklists', (SELECT count(*) FROM public.cloud_deal_checklists WHERE cloud_deal_id = D1),
    'items', (SELECT count(*) FROM public.cloud_deal_checklist_items WHERE cloud_deal_id = D1),
    'history', (SELECT count(*) FROM public.cloud_todo_history WHERE cloud_deal_id = D1),
    'head_moved', pg_temp.head(A) > a0, 'horizon_moved', pg_temp.hz(A) > 0,
    'list_removed_has_D1', (SELECT count(*) FROM jsonb_array_elements(pg_temp.rpc(A, format('SELECT public.cloud_list_removed(%L::uuid)', A)) -> 'deals') x WHERE x ->> 'deal_id' = D1::text)));
  PERFORM pg_temp.rec('Q2i_purge_again', pg_temp.rpc(A, format('SELECT public.cloud_purge_deal_now(%L::uuid, %L::uuid)', A, D1)));
  PERFORM pg_temp.rec('Q2j_delete_after_purge', jsonb_build_object('ok', pg_temp.deldeal(A, D1) -> 'ok', 'error', pg_temp.deldeal(A, D1) -> 'error'));
  -- a pull from before the purge, with the horizon a caught-up desktop held then
  r := pg_temp.pull(A, IA, base, 500, 0);
  PERFORM pg_temp.rec('Q2k_pull_after_purge', jsonb_build_object('resync', r -> 'resync_required', 'page', pg_temp.page(r, base)));
  -- Q3 the same local id uploaded again after the purge: a NEW online deal
  r := pg_temp.deal(A, pg_temp.dp(IA, 'd1'));
  PERFORM pg_temp.rec('Q3_reupload_after_purge', jsonb_build_object('status', r -> 'results' -> 0 -> 'status', 'restored', r -> 'results' -> 0 -> 'restored',
    'same_id', r -> 'results' -> 0 ->> 'cloud_id' = D1::text));

  -- Q4 a removed deal uploaded again by its install (the desktop restore): same id, un-removed, children renumbered
  PERFORM pg_temp.deldeal(A, D3);
  a0 := pg_temp.head(A);
  r := pg_temp.deal(A, pg_temp.dp(IA, 'd3'));
  PERFORM pg_temp.rec('Q4_reupload_removed', jsonb_build_object('status', r -> 'results' -> 0 -> 'status', 'restored', r -> 'results' -> 0 -> 'restored',
    'same_id', r -> 'results' -> 0 ->> 'cloud_id' = D3::text));
  r := pg_temp.pull(A, IA, a0, 500, pg_temp.hz(A));
  PERFORM pg_temp.rec('Q4b_pull_after_reupload', pg_temp.page(r, a0));
  PERFORM pg_temp.rec('Q4c_purge_now_after_reupload', pg_temp.rpc(A, format('SELECT public.cloud_purge_deal_now(%L::uuid, %L::uuid)', A, D3)));

  -- Q5 a removed deal restored online (cloud_todo_restore, entity deal): the pull's deal row, then purge_now refuses
  PERFORM pg_temp.deldeal(A, D4);
  a0 := pg_temp.head(A);
  r := pg_temp.rpc(A, format('SELECT public.cloud_todo_restore(%L::uuid, %L, %L::uuid)', A, 'deal', D4));
  PERFORM pg_temp.rec('Q5_restore_online', jsonb_build_object('status', r -> 'results' -> 0 -> 'status', 'renumbered', r -> 'results' -> 0 -> 'renumbered'));
  r := pg_temp.pull(A, IA, a0, 500, pg_temp.hz(A));
  PERFORM pg_temp.rec('Q5b_pull_after_restore_online', jsonb_build_object('page', pg_temp.page(r, a0),
    'deal_row_keys', (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_array_elements(r -> 'rows') x, jsonb_object_keys(x) k WHERE x ->> 'entity' = 'deal'),
    'deal_local_id', (SELECT x ->> 'local_id' FROM jsonb_array_elements(r -> 'rows') x WHERE x ->> 'entity' = 'deal')));
  PERFORM pg_temp.rec('Q5c_purge_now_restored', pg_temp.rpc(A, format('SELECT public.cloud_purge_deal_now(%L::uuid, %L::uuid)', A, D4)));

  -- C41 not callable by an AI app: EXECUTE grants, and no mcp_ function names it
  PERFORM pg_temp.rec('C41_grants', jsonb_build_object(
    'anon', has_function_privilege('anon', 'public.cloud_purge_deal_now(uuid, uuid)', 'EXECUTE'),
    'authenticated', has_function_privilege('authenticated', 'public.cloud_purge_deal_now(uuid, uuid)', 'EXECUTE'),
    'mcp_functions_naming_it', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname ~ '^_?mcp' AND p.prosrc LIKE '%cloud_purge_deal_now%'),
    'mcp_functions_total', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname ~ '^_?mcp')));

  RAISE EXCEPTION 'P4C_RESULT %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.p4c_out);
END
$obs$;
