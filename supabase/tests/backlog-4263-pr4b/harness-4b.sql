-- harness-4b.sql: BACKLOG-4263 PR-4b observations of cloud_todo_pull and the functions around it, as ONE call that ends in RAISE (nothing persists).
-- Venue: the test project through ~/.claude/bin/kt-sql; afterwards: select extensions.pg_stat_statements_reset().
-- Helpers: copied from supabase/tests/backlog-4263-pr4a/harness-4a.sql lines 7-159 (run id renamed).
-- BACKLOG-4263 PR-2 harness helpers. Loaded after the migration, inside the same transaction.
-- Every id, name and address is invented and derived from pr4b-harness (random per run, filled by harness.py).

CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $h$
  SELECT md5('p4263:pr4b-harness:' || n)::uuid
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

-- ============================================================================ BACKLOG-4263 PR-4b observations
-- What cloud_todo_pull (and the functions around it) answer, as the desktop puller will meet them.
-- Fixtures: two invented users (1 A, 2 B) on an invented team organization; deals through cloud_upsert_deal;
-- todos through cloud_todo_push and the core (AI-app actor). Only keys, JSON types, statuses, counts,
-- booleans and relative numbers are recorded. Ends in RAISE: nothing persists.
CREATE TEMP TABLE p4b_out (o serial, k text, v jsonb);
CREATE FUNCTION pg_temp.rec(k text, v jsonb) RETURNS void LANGUAGE sql AS $h$ INSERT INTO pg_temp.p4b_out (k, v) VALUES (k, v) $h$;
CREATE TEMP TABLE p4b_fx (k text PRIMARY KEY, v text);
CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql STABLE AS $h$ SELECT v::uuid FROM pg_temp.p4b_fx WHERE p4b_fx.k = id.k $h$;
CREATE FUNCTION pg_temp.put(k text, v text) RETURNS void LANGUAGE sql AS $h$
  INSERT INTO pg_temp.p4b_fx VALUES (k, v) ON CONFLICT (k) DO UPDATE SET v = excluded.v $h$;
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
        D1 uuid; D2 uuid; DBd uuid; i1 uuid; i2 uuid; i3 uuid; cl1 uuid; t0 timestamptz; t1 timestamptz; big jsonb; u uuid; npg int;
        pages jsonb := '[]'; aft bigint; lim int;
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.fx(n), 'p4263-' || substr(md5('pr4b-harness'), 1, 8) || '-' || n || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now() FROM generate_series(1, 2) n;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT pg_temp.fx(n), 'p4263-' || substr(md5('pr4b-harness'), 1, 8) || '-' || n || '@example.test', 'email', pg_temp.fx(n)::text, 'Fixture ' || n
    FROM generate_series(1, 2) n ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES (O, 'Fixture O', 'p4263-o-' || substr(md5('pr4b-harness'), 1, 8));
  INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status) VALUES
    (pg_temp.fx(201), O, A, 'agent', 'active'), (pg_temp.fx(202), O, B, 'agent', 'active');
  INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
  SELECT O, (SELECT id FROM public.plans WHERE tier = 'team' ORDER BY sort_order, name LIMIT 1), '{"cloud_autosave_assignable":{"enabled":true}}'::jsonb;
  SET LOCAL session_replication_role = origin;
  FOREACH u IN ARRAY ARRAY[A, B] LOOP
    PERFORM pg_temp.assign(O, u);
    PERFORM pg_temp.rec('on_' || CASE WHEN u = A THEN 'A' ELSE 'B' END, pg_temp.onoff(u, true) -> 'success');
  END LOOP;

  -- O1 an owner with nothing: full pull
  r := pg_temp.pull(A, IA, 0, 500);
  PERFORM pg_temp.rec('O1_empty_full_pull', pg_temp.shape(r) || jsonb_build_object('values', jsonb_build_object('head', r -> 'head', 'next_after', r -> 'next_after', 'horizon', r -> 'horizon', 'install_max_edit_seq', r -> 'install_max_edit_seq', 'resync', r -> 'resync_required')));
  PERFORM pg_temp.rec('O1b_horizon_required', pg_temp.pull(A, IA, 5, 500, NULL));
  PERFORM pg_temp.rec('O1c_after_above_head_with_horizon', pg_temp.page(pg_temp.pull(A, IA, 999999, 500, 0), 0));

  -- fixtures: A deals D1, D2 on install IA; B deal DB on IB
  r := pg_temp.deal(A, pg_temp.dp(IA, 'd1')); D1 := (r -> 'results' -> 0 ->> 'cloud_id')::uuid;
  r := pg_temp.deal(A, pg_temp.dp(IA, 'd2')); D2 := (r -> 'results' -> 0 ->> 'cloud_id')::uuid;
  r := pg_temp.deal(B, pg_temp.dp(IB, 'db')); DBd := (r -> 'results' -> 0 ->> 'cloud_id')::uuid;
  base := pg_temp.head(A);
  r := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(
         pg_temp.cc(D1, 'cl1', 'tpl-purchase', 'Purchase', 1), pg_temp.cc(D1, 'my1', 'keepr:my-items', 'My items', 2),
         pg_temp.ci(D1, 'cl1', 'i1', 'Inspection', 3), pg_temp.ci(D1, 'cl1', 'i2', 'Appraisal', 4, 'start'),
         pg_temp.ci(D1, 'my1', 'i3', 'Call lender', 5),
         pg_temp.cc(D2, 'cl2', 'tpl-sale', 'Sale', 1), pg_temp.ci(D2, 'cl2', 'i4', 'Disclosure', 6)));
  PERFORM pg_temp.rec('F_push_creates', (SELECT jsonb_agg(x ->> 'status') FROM jsonb_array_elements(r -> 'results') x));
  PERFORM pg_temp.rec('F_push_answer_shape', pg_temp.shape(r -> 'results' -> 2, 4));
  i1 := (r -> 'results' -> 2 ->> 'cloud_id')::uuid; i2 := (r -> 'results' -> 3 ->> 'cloud_id')::uuid; i3 := (r -> 'results' -> 4 ->> 'cloud_id')::uuid;
  cl1 := (r -> 'results' -> 0 ->> 'cloud_id')::uuid;
  -- an AI change on i2's note (later than the desktop's next edit) and a desktop edit made before it with the old base
  r := pg_temp.ai(A, jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'set', 'entity', 'item', 'id', i2, 'part', 'note', 'value', 'from ai')));
  PERFORM pg_temp.rec('F_ai_set', to_jsonb(pg_temp.st(r)));
  r := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(pg_temp.ds(D1, 'item', 'i2', 'note', '"from desk"', 1, 7, pg_temp.nowt('-1 hour'))));
  PERFORM pg_temp.rec('F_desk_stale', jsonb_build_object('status', pg_temp.st(r), 'conflict', r -> 'results' -> 0 -> 'conflict'));

  -- O2 full pull, one row a page (the order of entities; events)
  aft := 0; hz := NULL; lim := 1; npg := 0;
  LOOP
    r := pg_temp.pull(A, IA, aft, lim, hz);
    pages := pages || jsonb_build_array(pg_temp.page(r, base));
    npg := npg + 1;
    EXIT WHEN r ->> 'ok' IS DISTINCT FROM 'true' OR jsonb_array_length(r -> 'rows') < lim OR npg > 40;
    aft := (r ->> 'next_after')::bigint; hz := (r ->> 'horizon')::bigint;
  END LOOP;
  PERFORM pg_temp.rec('O2_full_pull_limit1', pages);
  r := pg_temp.pull(A, IA, 0, 500);
  PERFORM pg_temp.rec('O2b_full_pull_500', pg_temp.page(r, base));
  PERFORM pg_temp.rec('O2c_item_row_shape', pg_temp.shape(pg_temp.row_of(r, i1), 4));
  PERFORM pg_temp.rec('O2d_checklist_row_shape', pg_temp.shape(pg_temp.row_of(r, cl1), 4));
  PERFORM pg_temp.rec('O2e_deal_row_shape', pg_temp.shape(pg_temp.row_of(r, D1), 2));
  PERFORM pg_temp.rec('O2f_event_shape', pg_temp.shape((SELECT x FROM jsonb_array_elements(r -> 'rows') x WHERE x ->> 'entity' = 'event' LIMIT 1), 2));
  PERFORM pg_temp.rec('O2g_item_facts', jsonb_build_object(
    'local_id_is_desktop_id', pg_temp.row_of(r, i1) ->> 'local_id' = 'i1',
    'done_value', pg_temp.row_of(r, i1) -> 'parts' -> 'done' -> 'value',
    'note_by_is_ai', pg_temp.row_of(r, i2) -> 'parts' -> 'note' ->> 'by' LIKE 'ai_app:%',
    'title_by_is_this_install', pg_temp.row_of(r, i1) -> 'parts' -> 'title' ->> 'by' = 'desktop:' || IA::text,
    'title_edit_seq', pg_temp.row_of(r, i1) -> 'parts' -> 'title' -> 'edit_seq',
    'removed_value', pg_temp.row_of(r, i1) -> 'parts' -> 'removed' -> 'value',
    'checklist_id_is_cl1', pg_temp.row_of(r, i1) ->> 'cloud_checklist_id' = cl1::text,
    'event_about', (SELECT x -> 'about' FROM jsonb_array_elements(r -> 'rows') x WHERE x ->> 'entity' = 'event' LIMIT 1),
    'event_outcome', (SELECT x -> 'outcome' FROM jsonb_array_elements(r -> 'rows') x WHERE x ->> 'entity' = 'event' LIMIT 1),
    'event_cloud_id_is_i2', (SELECT x ->> 'cloud_id' = i2::text FROM jsonb_array_elements(r -> 'rows') x WHERE x ->> 'entity' = 'event' LIMIT 1),
    'event_loser_is_desk', (SELECT x -> 'loser_value' = '"from desk"' FROM jsonb_array_elements(r -> 'rows') x WHERE x ->> 'entity' = 'event' LIMIT 1),
    'event_winner_is_ai', (SELECT x -> 'winner_value' = '"from ai"' FROM jsonb_array_elements(r -> 'rows') x WHERE x ->> 'entity' = 'event' LIMIT 1),
    'event_by_kind', (SELECT split_part(x ->> 'by', ':', 1) FROM jsonb_array_elements(r -> 'rows') x WHERE x ->> 'entity' = 'event' LIMIT 1),
    'b_rows_absent', pg_temp.row_of(r, DBd) IS NULL,
    'ime_seq', r -> 'install_max_edit_seq'));
  a0 := (r ->> 'next_after')::bigint; hz := (r ->> 'horizon')::bigint;
  PERFORM pg_temp.rec('O2h_other_install_sees_nothing', pg_temp.page(pg_temp.pull(A, pg_temp.fx(399), 0, 500), base));

  -- O3 own push comes back on the next pull: same rev as the answer
  r := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(pg_temp.ds(D1, 'item', 'i1', 'done', '{"is_checked": true, "checked_at": "2026-11-17T04:05:08.266Z"}', 1, 9, pg_temp.nowt())));
  r2 := pg_temp.pull(A, IA, a0, 500, hz);
  PERFORM pg_temp.rec('O3_own_push_back', jsonb_build_object('push', pg_temp.st(r), 'answer_rev', r -> 'results' -> 0 -> 'parts' -> 'done' -> 'rev',
    'pulled_rev', pg_temp.row_of(r2, i1) -> 'parts' -> 'done' -> 'rev', 'pulled_by_this_install', pg_temp.row_of(r2, i1) -> 'parts' -> 'done' ->> 'by' = 'desktop:' || IA::text,
    'page', pg_temp.page(r2, base), 'ime', r2 -> 'install_max_edit_seq'));
  a0 := (r2 ->> 'next_after')::bigint; hz := (r2 ->> 'horizon')::bigint;

  -- O4 held_locked flag on a desktop set; history outcome
  r := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(pg_temp.ds(D1, 'item', 'i2', 'note', '"held"', 2, 10, pg_temp.nowt(), '{"held_locked": true}')));
  PERFORM pg_temp.rec('O4_held_locked', jsonb_build_object('status', pg_temp.st(r), 'hist', (SELECT jsonb_agg(h.outcome ORDER BY h.change_seq) FROM public.cloud_todo_history h WHERE h.entity_id = i2 AND h.part = 'note')));

  -- O5 removal, restore (item), removal and restore (checklist): what the incremental pull shows
  r := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'remove', 'entity', 'item', 'deal_id', D1, 'local_id', 'i3', 'edited_at', pg_temp.nowt())));
  PERFORM pg_temp.rec('O5a_remove_item', to_jsonb(pg_temp.st(r)));
  r := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(pg_temp.ds(D1, 'item', 'i3', 'note', '"edited while removed"', 1, 11, pg_temp.nowt())));
  PERFORM pg_temp.rec('O5b_set_on_removed', to_jsonb(pg_temp.st(r)));
  r := pg_temp.rpc(A, format('SELECT public.cloud_todo_restore(%L::uuid, %L, %L::uuid)', A, 'item', i3));
  PERFORM pg_temp.rec('O5c_restore_item', to_jsonb(pg_temp.st(r)));
  r2 := pg_temp.pull(A, IA, a0, 500, hz);
  PERFORM pg_temp.rec('O5d_pull_after_item_restore', pg_temp.page(r2, base) || jsonb_build_object('i3_removed_rev', pg_temp.row_of(r2, i3) -> 'parts' -> 'removed' -> 'rev',
    'i3_note_kept', pg_temp.row_of(r2, i3) -> 'parts' -> 'note' -> 'value' = '"edited while removed"'));
  a0 := (r2 ->> 'next_after')::bigint; hz := (r2 ->> 'horizon')::bigint;
  r := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'remove', 'entity', 'checklist', 'deal_id', D1, 'local_id', 'cl1', 'edited_at', pg_temp.nowt())));
  r2 := pg_temp.pull(A, IA, a0, 500, hz);
  PERFORM pg_temp.rec('O5e_checklist_removed_pull', jsonb_build_object('status', pg_temp.st(r), 'page', pg_temp.page(r2, base),
    'items_of_cl1_in_page', (SELECT count(*) FROM jsonb_array_elements(r2 -> 'rows') x WHERE x ->> 'cloud_checklist_id' = cl1::text)));
  a0 := (r2 ->> 'next_after')::bigint; hz := (r2 ->> 'horizon')::bigint;
  r := pg_temp.rpc(A, format('SELECT public.cloud_todo_restore(%L::uuid, %L, %L::uuid)', A, 'checklist', cl1));
  r2 := pg_temp.pull(A, IA, a0, 500, hz);
  PERFORM pg_temp.rec('O5f_checklist_restored_pull', jsonb_build_object('status', pg_temp.st(r), 'page', pg_temp.page(r2, base),
    'items_of_cl1_in_page', (SELECT count(*) FROM jsonb_array_elements(r2 -> 'rows') x WHERE x ->> 'cloud_checklist_id' = cl1::text)));
  a0 := (r2 ->> 'next_after')::bigint; hz := (r2 ->> 'horizon')::bigint;

  -- O6 W27 / mapped: a second My items create maps; then a set addressed by the alias local_id
  r := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(pg_temp.cc(D1, 'my2', 'keepr:my-items', 'My items', 9)));
  r2 := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(pg_temp.ds(D1, 'checklist', 'my2', 'order', '4', NULL, 12, pg_temp.nowt())));
  PERFORM pg_temp.rec('O6_mapped_then_set_by_alias', jsonb_build_object('create', pg_temp.st(r), 'set', pg_temp.st(r2)));
  -- an item create under the alias
  r := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(pg_temp.ci(D1, 'my2', 'i9', 'Under alias', 13)));
  PERFORM pg_temp.rec('O6b_item_under_alias', to_jsonb(pg_temp.st(r)));

  -- O7 a create answered final (rejected), then a set and a remove of that entity
  r := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(pg_temp.ci(D1, 'cl1', 'ibad', repeat('x', 400))));
  r2 := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(pg_temp.ds(D1, 'item', 'ibad', 'note', '"n"', NULL, 14, pg_temp.nowt()),
          jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'remove', 'entity', 'item', 'deal_id', D1, 'local_id', 'ibad', 'edited_at', pg_temp.nowt())));
  PERFORM pg_temp.rec('O7_final_create_then_ops', jsonb_build_object('create', pg_temp.st(r), 'reason', r -> 'results' -> 0 -> 'reason', 'set', pg_temp.st(r2, 0), 'remove', pg_temp.st(r2, 1)));

  -- O8 purge of a removed item (backdated 31 days): an old cursor resyncs; a full pull shows the purged row
  r := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'remove', 'entity', 'item', 'deal_id', D2, 'local_id', 'i4', 'edited_at', pg_temp.nowt())));
  r2 := pg_temp.pull(A, IA, 0, 500);
  a0 := (r2 ->> 'next_after')::bigint; hz := (r2 ->> 'horizon')::bigint;
  -- a cursor saved mid-way (before the removal's number) with the then horizon
  UPDATE public.cloud_deal_checklist_items SET removed_at = now() - interval '31 days', removed_eff_at = now() - interval '31 days' WHERE owner_user_id = A AND local_item_id = 'i4';
  r := pg_temp.as_user(NULL, 'SELECT public._cloud_todo_purge()')::jsonb;
  PERFORM pg_temp.rec('O8a_purge', pg_temp.shape(r));
  PERFORM pg_temp.rec('O8b_caught_up_cursor_after_purge', pg_temp.page(pg_temp.pull(A, IA, a0, 500, hz), base));
  PERFORM pg_temp.rec('O8c_early_cursor_after_purge', pg_temp.page(pg_temp.pull(A, IA, base + 1, 500, hz), base));
  r2 := pg_temp.pull(A, IA, 0, 500);
  PERFORM pg_temp.rec('O8d_full_pull_after_purge', jsonb_build_object('page', pg_temp.page(r2, base),
    'purged_item_shape', pg_temp.shape((SELECT x FROM jsonb_array_elements(r2 -> 'rows') x WHERE (x ->> 'purged')::boolean LIMIT 1), 2),
    'horizon_moved', (r2 ->> 'horizon')::bigint > hz));
  a0 := (r2 ->> 'next_after')::bigint; hz := (r2 ->> 'horizon')::bigint;

  -- O9 a soft-removed deal: the feed's deal row, list_install_rows, then purge now
  r := pg_temp.deldeal(A, D2);
  PERFORM pg_temp.rec('O9a_delete_deal', pg_temp.shape(r));
  r2 := pg_temp.pull(A, IA, a0, 500, hz);
  PERFORM pg_temp.rec('O9b_pull_after_deal_delete', pg_temp.page(r2, base));
  r := pg_temp.rpc(A, format('SELECT public.cloud_list_install_rows(%L::uuid, %L::uuid, %L, NULL, 1000)', A, IA, 'deal'));
  PERFORM pg_temp.rec('O9c_list_rows_deal', jsonb_build_object('shape', pg_temp.shape(r, 3), 'removed_flags', (SELECT jsonb_agg(x -> 'removed' ORDER BY x ->> 'local_id') FROM jsonb_array_elements(r -> 'rows') x)));
  a0 := (r2 ->> 'next_after')::bigint; hz := (r2 ->> 'horizon')::bigint;
  r := pg_temp.rpc(A, format('SELECT public.cloud_purge_deal_now(%L::uuid, %L::uuid)', A, D2));
  r2 := pg_temp.pull(A, IA, a0, 500, hz);
  PERFORM pg_temp.rec('O9d_purge_now_then_pull', jsonb_build_object('purge', r -> 'status', 'page', pg_temp.page(r2, base)));
  PERFORM pg_temp.rec('O9e_full_pull_after_purge_now', pg_temp.page(pg_temp.pull(A, IA, 0, 500), base));

  -- O10 install_removed register, status and reclaim with two owners
  r := pg_temp.delinst(A, IA);
  PERFORM pg_temp.rec('O10a_delete_install', pg_temp.shape(r));
  r := pg_temp.delinst(B, IB);
  PERFORM pg_temp.rec('O10b_status', jsonb_build_object(
    'A', pg_temp.rpc(A, format('SELECT public.cloud_install_status(%L::uuid, %L::uuid)', A, IA)),
    'B', pg_temp.rpc(B, format('SELECT public.cloud_install_status(%L::uuid, %L::uuid)', B, IB)),
    'push_A', pg_temp.push(A, IA, pg_temp.nowt(), '[]'::jsonb), 'pull_A', pg_temp.page(pg_temp.pull(A, IA, 0, 500), base),
    'upsert_A', pg_temp.deal(A, pg_temp.dp(IA, 'd1')) -> 'error'));
  r := pg_temp.rpc(A, format('SELECT public.cloud_reclaim_install(%L::uuid, %L::uuid)', A, IA));
  PERFORM pg_temp.rec('O10c_reclaim', jsonb_build_object('reclaim', r,
    'A_after', pg_temp.rpc(A, format('SELECT public.cloud_install_status(%L::uuid, %L::uuid)', A, IA)),
    'B_after', pg_temp.rpc(B, format('SELECT public.cloud_install_status(%L::uuid, %L::uuid)', B, IB)),
    'B_register_rows', (SELECT count(*) FROM public.cloud_removed_installs WHERE owner_user_id = B),
    'wrong_account', pg_temp.rpc(A, format('SELECT public.cloud_reclaim_install(%L::uuid, %L::uuid)', B, IB))));
  r := pg_temp.deal(A, pg_temp.dp(IA, 'd1'));
  r2 := pg_temp.pull(A, IA, 0, 500);
  PERFORM pg_temp.rec('O10d_reupload_after_reclaim', jsonb_build_object('upsert', r -> 'results' -> 0 -> 'status', 'same_id', r -> 'results' -> 0 ->> 'cloud_id' = D1::text,
    'page', pg_temp.page(r2, base), 'list_removed_flags', (SELECT jsonb_agg(x -> 'removed') FROM jsonb_array_elements(pg_temp.rpc(A, format('SELECT public.cloud_list_install_rows(%L::uuid, %L::uuid, %L, NULL, 1000)', A, IA, 'deal')) -> 'rows') x)));

  -- O11 case (g): one push of 200 creates, about 900 KB, timed
  r := pg_temp.push(A, IA, pg_temp.nowt(), jsonb_build_array(pg_temp.cc(D1, 'clg', 'tpl-g', 'Big', 30)));
  big := (SELECT jsonb_agg(jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_item', 'deal_id', D1, 'checklist_local_id', 'clg',
            'local_id', 'g' || g, 'title', 'Bulk ' || g, 'description', repeat('d', 600), 'note', repeat('n', 3900), 'is_required', false,
            'done', jsonb_build_object('is_checked', false, 'checked_at', NULL), 'sort_order', g, 'edit_seq', 100 + g, 'edited_at', pg_temp.nowt()))
          FROM generate_series(1, 200) g);
  t0 := clock_timestamp();
  r := pg_temp.push(A, IA, pg_temp.nowt(), big);
  t1 := clock_timestamp();
  PERFORM pg_temp.rec('O11_case_g', jsonb_build_object('ops', jsonb_array_length(big), 'bytes', octet_length(big::text),
    'ms', round(extract(epoch FROM t1 - t0) * 1000), 'ok', r -> 'ok', 'error', r -> 'error',
    'statuses', (SELECT jsonb_object_agg(s, c) FROM (SELECT x ->> 'status' s, count(*) c FROM jsonb_array_elements(r -> 'results') x GROUP BY 1) q)));
  t0 := clock_timestamp();
  r2 := pg_temp.pull(A, IA, 0, 500);
  t1 := clock_timestamp();
  PERFORM pg_temp.rec('O11b_pull_after_case_g', jsonb_build_object('n', jsonb_array_length(r2 -> 'rows'), 'ms', round(extract(epoch FROM t1 - t0) * 1000), 'bytes', octet_length(r2::text)));
  big := big || jsonb_build_array(big -> 0);
  PERFORM pg_temp.rec('O11c_201_ops', pg_temp.push(A, IA, pg_temp.nowt(), big) -> 'error');

  RAISE EXCEPTION 'P4B_RESULT %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.p4b_out);
END
$obs$;
