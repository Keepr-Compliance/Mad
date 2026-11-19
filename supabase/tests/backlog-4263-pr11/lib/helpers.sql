-- BACKLOG-4263 PR-11a harness: helpers. Every id, name and secret is invented and derived from 'pr11a-harness';
-- user ids are md5-derived. Rows of the reserved account and of any existing AI-app connection are never read or
-- written. Only counts, fixture keys, statuses, md5s and timings are recorded.

CREATE TEMP TABLE h_out (o serial, k text, v jsonb);
CREATE FUNCTION pg_temp.rec(k text, v jsonb) RETURNS void LANGUAGE sql AS $h$ INSERT INTO pg_temp.h_out (k, v) VALUES (k, v) $h$;
CREATE TEMP TABLE h_fx (k text PRIMARY KEY, v text);
CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql STABLE AS $h$ SELECT v::uuid FROM pg_temp.h_fx WHERE h_fx.k = id.k $h$;
CREATE FUNCTION pg_temp.fxv(k text) RETURNS text LANGUAGE sql STABLE AS $h$ SELECT v FROM pg_temp.h_fx WHERE h_fx.k = fxv.k $h$;
CREATE FUNCTION pg_temp.put(k text, v text) RETURNS void LANGUAGE sql AS $h$
  INSERT INTO pg_temp.h_fx VALUES (k, v) ON CONFLICT (k) DO UPDATE SET v = excluded.v $h$;
CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $h$ SELECT md5('p4263:pr11a-harness:' || n)::uuid $h$;
CREATE FUNCTION pg_temp.h(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT encode(sha256(convert_to(t, 'UTF8')), 'hex') $h$;
CREATE FUNCTION pg_temp.pass(c boolean, detail text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN coalesce(c, false) THEN 'PASS' ELSE 'FAIL: ' || coalesce(left(detail, 900), '-') END $h$;
CREATE FUNCTION pg_temp.all_of(VARIADIC r text[]) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN bool_and(x = 'PASS') THEN 'PASS'
              ELSE 'FAIL: ' || string_agg(CASE WHEN x <> 'PASS' THEN '#' || o || ' ' || x END, ' | ') END
    FROM unnest(r) WITH ORDINALITY t(x, o) $h$;
CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $h$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
END $h$;
-- one statement as an API role with the user's claims (own subtransaction); a SELECT returns its value as text,
-- an error returns 'ERR <sqlstate> <message>'
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
-- as the database owner with the user's claims (how a SECURITY DEFINER wrapper reaches the core)
CREATE FUNCTION pg_temp.as_user(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $h$
DECLARE j jsonb;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', u::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
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
CREATE FUNCTION pg_temp.nowt(off interval DEFAULT '0') RETURNS text LANGUAGE sql VOLATILE AS $h$
  SELECT to_char((clock_timestamp() + off) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $h$;

-- desktop calls (the shapes PR-4a's sender sends)
CREATE FUNCTION pg_temp.onoff(u uuid, en boolean) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.call_as(u, format('SELECT public.set_my_cloud_autosave(%L::uuid, %L::boolean, 1)', u, en))) $h$;
CREATE FUNCTION pg_temp.assign(org uuid, u uuid) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(NULL, format('SELECT public.assign_member_addon(%L::uuid, %L::uuid, %L, true, NULL::timestamptz)', org, u, 'cloud_autosave'), 'service_role') $h$;
CREATE FUNCTION pg_temp.dp(inst uuid, lid text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT jsonb_build_object('source_install_id', inst, 'local_id', lid, 'content_hash', pg_temp.h(lid),
                            'detection_status', 'confirmed', 'detection_source', 'manual', 'status', 'active',
                            'property_address', 'Fixture ' || lid || ' Way') $h$;
CREATE FUNCTION pg_temp.deal(u uuid, payload jsonb) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.call_as(u, format('SELECT public.cloud_upsert_deal(%L::uuid, %L::jsonb)', u, payload))) $h$;
CREATE FUNCTION pg_temp.push(u uuid, inst uuid, ops jsonb) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.call_as(u, format('SELECT public.cloud_todo_push(%L::uuid, %L::uuid, %L::text, %L::jsonb)', u, inst, pg_temp.nowt(), ops))) $h$;
CREATE FUNCTION pg_temp.pull(u uuid, inst uuid) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.call_as(u, format('SELECT public.cloud_todo_pull(%L::uuid, %L::uuid, 0::bigint, 500, NULL::bigint)', u, inst))) $h$;
CREATE FUNCTION pg_temp.restore(u uuid, id uuid) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.call_as(u, format('SELECT public.cloud_todo_restore(%L::uuid, %L, %L::uuid, NULL::uuid)', u, 'item', id))) $h$;
-- an AI-app change through the core, as a definer wrapper makes it, with a given ref
CREATE FUNCTION pg_temp.ai(u uuid, ops jsonb, ref text) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.as_user(u, format('SELECT public._cloud_todo_apply(%L::uuid, %L::jsonb, %L::jsonb)', u,
           jsonb_build_object('kind', 'ai_app', 'ref', ref, 'label', 'Claude'), ops))) $h$;
CREATE FUNCTION pg_temp.st(res jsonb, n int DEFAULT 0) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(res -> 'results' -> n ->> 'status', 'ERROR:' || coalesce(res ->> 'error', res::text)) $h$;
CREATE FUNCTION pg_temp.cc(dl uuid, lid text, tpl text, name text, so int) RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  SELECT jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_checklist', 'deal_id', dl, 'local_id', lid, 'template_id', tpl,
    'template_name', name, 'sort_order', so, 'is_private', tpl = 'keepr:my-items', 'edited_at', pg_temp.nowt()) $h$;
CREATE FUNCTION pg_temp.ci(dl uuid, cl text, lid text, title text, so int, note text DEFAULT NULL) RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  SELECT jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_item', 'deal_id', dl, 'checklist_local_id', cl,
    'local_id', lid, 'title', title, 'is_required', false, 'done', jsonb_build_object('is_checked', false, 'checked_at', NULL),
    'sort_order', so, 'edit_seq', 1, 'edited_at', pg_temp.nowt(), 'note', note) $h$;
CREATE FUNCTION pg_temp.op_set(id uuid, part text, val jsonb, es bigint) RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  SELECT jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'set', 'entity', 'item', 'id', id, 'part', part,
           'base_rev', (SELECT CASE part WHEN 'done' THEN t.done_rev WHEN 'note' THEN t.note_rev WHEN 'title' THEN t.title_rev END
                          FROM public.cloud_deal_checklist_items t WHERE t.id = op_set.id),
           'edit_seq', es, 'edited_at', pg_temp.nowt(), 'value', val) $h$;
CREATE FUNCTION pg_temp.op(kind text, id uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $h$
  SELECT jsonb_build_object('op_id', gen_random_uuid(), 'kind', kind, 'entity', 'item', 'id', id, 'edited_at', pg_temp.nowt()) $h$;
CREATE FUNCTION pg_temp.item_of(dl uuid, lid text) RETURNS uuid LANGUAGE sql STABLE AS $h$
  SELECT id FROM public.cloud_deal_checklist_items WHERE cloud_deal_id = dl AND local_item_id = lid $h$;
-- the app columns of one item, read through to_jsonb (works before and after the columns exist)
CREATE FUNCTION pg_temp.apps(id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $h$
  SELECT jsonb_build_object('done_app', x -> 'done_app', 'note_app', x -> 'note_app', 'done_rev', x -> 'done_rev', 'note_rev', x -> 'note_rev')
    FROM (SELECT to_jsonb(t) AS x FROM public.cloud_deal_checklist_items t WHERE t.id = apps.id) s $h$;
-- reads of mcp_connections in this transaction so far (sequential plus index scans)
CREATE FUNCTION pg_temp.scans() RETURNS bigint LANGUAGE sql VOLATILE AS $h$
  SELECT coalesce(s.seq_scan, 0) + coalesce(s.idx_scan, 0) FROM pg_catalog.pg_stat_xact_user_tables s
   WHERE s.relid = 'public.mcp_connections'::regclass $h$;

-- AI-app wrapper calls (as anon, with the claims PostgREST sets)
CREATE FUNCTION pg_temp.secret() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'p11a-fixture-portal-secret-' || md5('pr11a-harness') $h$;
CREATE FUNCTION pg_temp.res() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'https://p11a-fixture.example.test/api/mcp' $h$;
CREATE FUNCTION pg_temp.dg(n int) RETURNS bytea LANGUAGE sql IMMUTABLE AS $h$ SELECT sha256(convert_to('p11a-at-' || md5('pr11a-harness') || n, 'UTF8')) $h$;
CREATE FUNCTION pg_temp.dgl(n int) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT '\x' || encode(pg_temp.dg(n), 'hex') $h$;
CREATE FUNCTION pg_temp.client() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'kpr_c_' || substr(md5('pr11a-harness-client'), 1, 22) $h$;
CREATE FUNCTION pg_temp.conn(k text, u uuid, n int, provider text, cname text) RETURNS uuid LANGUAGE plpgsql AS $h$
DECLARE v uuid := md5('pr11a-harness-conn-' || k)::uuid;
BEGIN
  INSERT INTO public.mcp_connections (id, user_id, client_id, provider, client_name, redirect_uri, resource, scope, notice_version, status, activated_at)
  VALUES (v, u, pg_temp.client(), provider, cname,
          CASE provider WHEN 'anthropic' THEN 'https://claude.ai/api/mcp/auth_callback' ELSE 'https://chatgpt.com/connector_platform_oauth_redirect' END,
          pg_temp.res(), 'mcp:todos', 1, 'active', now());
  INSERT INTO public.mcp_tokens (token_sha256, connection_id, kind, pepper_version, expires_at) VALUES
    (sha256(pg_temp.dg(n)), v, 'access', (SELECT pepper_version FROM public.mcp_settings WHERE id), now() + interval '1 hour');
  PERFORM pg_temp.put(k, v::text);
  RETURN v;
END $h$;
CREATE FUNCTION pg_temp.mcp(q text) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN
    EXECUTE q INTO r;
  EXCEPTION WHEN OTHERS THEN r := jsonb_build_object('sqlerr', SQLSTATE, 'msg', left(SQLERRM, 200));
  END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.clear_claims();
  RETURN r;
END $h$;
CREATE FUNCTION pg_temp.upd(n int, item uuid, ch jsonb) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.mcp(format('SELECT public.mcp_update_todo(%L, %L::bytea, %L, %L, %L::jsonb, %L)', pg_temp.secret(), pg_temp.dgl(n), pg_temp.res(), item, ch, NULL)) $h$;
CREATE FUNCTION pg_temp.add(n int, dl uuid, title text, note text) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.mcp(format('SELECT public.mcp_add_todo(%L, %L::bytea, %L, %L, %L, %L, %L, %L)', pg_temp.secret(), pg_temp.dgl(n), pg_temp.res(), dl, title, note, NULL, NULL)) $h$;
CREATE FUNCTION pg_temp.unrate() RETURNS void LANGUAGE sql AS $h$
  DELETE FROM public.mcp_rate_counters WHERE bucket IN (
    SELECT 'call_conn:' || v FROM pg_temp.h_fx WHERE k LIKE 'K%'
    UNION ALL SELECT 'call_user:' || v FROM pg_temp.h_fx WHERE k IN ('A', 'B')
    UNION ALL SELECT 'todo_write_user:' || v FROM pg_temp.h_fx WHERE k IN ('A', 'B')) $h$;

-- snapshot calls as the signed-in agent: the answer or 'ERR <sqlstate> ...'
CREATE FUNCTION pg_temp.snap(u uuid, sid uuid, payload jsonb) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.call_as(u, format('SELECT public.snapshot_submission_checklists(%L::uuid, %L::jsonb)', sid, payload)) $h$;
-- the item rows of a submission as the old portal sees them plus every other column, without ids and times
CREATE FUNCTION pg_temp.items(sid uuid) RETURNS jsonb LANGUAGE sql STABLE AS $h$
  SELECT coalesce(jsonb_agg(to_jsonb(i) - 'id' - 'submission_id' - 'submission_checklist_id' - 'created_at'
                            ORDER BY i.title, i.sort_order), '[]'::jsonb)
    FROM public.submission_checklist_items i WHERE i.submission_id = sid $h$;
