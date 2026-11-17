-- BACKLOG-4263 PR-2 harness helpers. Loaded after the migration, inside the same transaction.
-- Every id, name and address is invented and derived from __RUN__ (random per run, filled by harness.py).

CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $h$
  SELECT md5('p4263:__RUN__:' || n)::uuid
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
