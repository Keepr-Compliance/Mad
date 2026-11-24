-- BACKLOG-4263 sync 2.49, P9 (T-S) harness helpers. Loaded inside the one call (which ends in RAISE, so nothing persists).
-- Every id is made at run time (gen_random_uuid); every name, address and secret is invented ('@example.test').
CREATE TEMP TABLE t_out (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
CREATE TEMP TABLE t_fx (k text PRIMARY KEY, v uuid) ON COMMIT DROP;
CREATE TEMP TABLE t_txt (k text PRIMARY KEY, v text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.rec(k text, v jsonb) RETURNS void LANGUAGE sql AS $h$
  INSERT INTO pg_temp.t_out VALUES (k, v) ON CONFLICT (k) DO UPDATE SET v = excluded.v
$h$;
CREATE FUNCTION pg_temp.f(k text) RETURNS uuid LANGUAGE sql STABLE AS $h$ SELECT v FROM pg_temp.t_fx WHERE t_fx.k = f.k $h$;
CREATE FUNCTION pg_temp.s(k text) RETURNS text LANGUAGE sql STABLE AS $h$ SELECT v::text FROM pg_temp.t_fx WHERE t_fx.k = s.k $h$;
CREATE FUNCTION pg_temp.put(k text, v uuid) RETURNS uuid LANGUAGE sql AS $h$
  INSERT INTO pg_temp.t_fx VALUES (k, v) ON CONFLICT (k) DO UPDATE SET v = excluded.v RETURNING v
$h$;
CREATE FUNCTION pg_temp.tx(k text) RETURNS text LANGUAGE sql STABLE AS $h$ SELECT v FROM pg_temp.t_txt WHERE t_txt.k = tx.k $h$;
CREATE FUNCTION pg_temp.h(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT encode(sha256(convert_to(t, 'UTF8')), 'hex') $h$;
CREATE FUNCTION pg_temp.j(t text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $h$
BEGIN RETURN t::jsonb; EXCEPTION WHEN OTHERS THEN RETURN to_jsonb(t); END $h$;
CREATE FUNCTION pg_temp.pass(c boolean, detail text) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN coalesce(c, false) THEN 'PASS' ELSE 'FAIL: ' || coalesce(left(detail, 900), '-') END
$h$;
CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $h$
BEGIN
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
END $h$;
-- One SELECT as an API role with the user's claims (own subtransaction). Returns its single value as text, or
-- 'ERR <sqlstate> <message>'.
CREATE FUNCTION pg_temp.call_as(u uuid, q text, r text) RETURNS text LANGUAGE plpgsql AS $h$
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
    RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 200);
  END;
END $h$;
-- public.<fn>(args) as fixture user k (authenticated); args is a format() list of %L placeholders.
CREATE FUNCTION pg_temp.as_user(k text, fn text, args text, VARIADIC vals text[]) RETURNS jsonb LANGUAGE plpgsql AS $h$
BEGIN
  RETURN pg_temp.j(pg_temp.call_as(pg_temp.f(k), format('SELECT to_jsonb(public.' || quote_ident(fn) || '(' || args || '))', VARIADIC vals), 'authenticated'));
END $h$;

-- MCP fixtures: the portal secret sits in mcp_settings.portal_secret_prev_sha256 for this call only.
CREATE FUNCTION pg_temp.secret() RETURNS text LANGUAGE sql STABLE AS $h$ SELECT 'p4263t-portal-secret-' || pg_temp.s('RUN') $h$;
CREATE FUNCTION pg_temp.res() RETURNS text LANGUAGE sql IMMUTABLE AS $h$ SELECT 'https://p4263t-fixture.example.test/api/mcp' $h$;
CREATE FUNCTION pg_temp.dg(k text) RETURNS bytea LANGUAGE sql STABLE AS $h$ SELECT sha256(convert_to('p4263t-at-' || pg_temp.s('RUN') || k, 'UTF8')) $h$;
CREATE FUNCTION pg_temp.client() RETURNS text LANGUAGE sql STABLE AS $h$ SELECT 'kpr_c_' || substr(md5('p4263t-client-' || pg_temp.s('RUN')), 1, 22) $h$;
-- an active connection of user u approved on approval-page version nv, with an access token
CREATE FUNCTION pg_temp.conn(k text, u uuid, nv int) RETURNS uuid LANGUAGE plpgsql AS $h$
DECLARE v uuid := pg_temp.put(k, gen_random_uuid());
BEGIN
  INSERT INTO public.mcp_connections (id, user_id, client_id, provider, client_name, redirect_uri, resource, scope, notice_version, status, activated_at)
  VALUES (v, u, pg_temp.client(), 'anthropic', 'Fixture app ' || k, 'https://claude.ai/api/mcp/auth_callback', pg_temp.res(), 'mcp:read', nv, 'active', now());
  INSERT INTO public.mcp_tokens (token_sha256, connection_id, kind, pepper_version, expires_at)
  VALUES (sha256(pg_temp.dg(k)), v, 'access', (SELECT pepper_version FROM public.mcp_settings WHERE id), now() + interval '1 hour');
  RETURN v;
END $h$;
-- A tool call as the portal does it (anon role, portal secret, token digest of connection k). The fixture users' and
-- the connection's per-minute counters are cleared first, so repeated calls in one run are not rate limited. Returns
-- the answer text or 'ERR <sqlstate> <message>'.
CREATE FUNCTION pg_temp.tool(fn text, k text, extra text) RETURNS text LANGUAGE plpgsql AS $h$
BEGIN
  DELETE FROM public.mcp_rate_counters
   WHERE bucket IN ('call_conn:' || pg_temp.s(k), 'call_user:' || pg_temp.s('A'), 'call_user:' || pg_temp.s('B'));
  RETURN pg_temp.call_as(NULL, format('SELECT public.%I(%L, %L::bytea, %L%s)', fn, pg_temp.secret(), pg_temp.dg(k), pg_temp.res(),
                                       CASE WHEN extra = '' THEN '' ELSE ', ' || extra END), 'anon');
END $h$;
CREATE FUNCTION pg_temp.lst(k text, deal text, channel text, review text, lim int, cursor text) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.tool('mcp_list_deal_messages', k, format('%L, %L, %L, %L::integer, %L', deal, channel, review, lim, cursor)))
$h$;
CREATE FUNCTION pg_temp.getm(k text, msg text, part int) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.tool('mcp_get_message', k, format('%L, %L::integer', msg, part)))
$h$;
CREATE FUNCTION pg_temp.access(k text) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.tool('mcp_message_access', k, ''))
$h$;
-- reads and last_outcome are VOLATILE: a STABLE function reads with the snapshot of the statement that calls it, so in
-- an expression that also makes a tool call it would not see the rows that call wrote
CREATE FUNCTION pg_temp.reads(u text) RETURNS bigint LANGUAGE sql VOLATILE AS $h$
  SELECT count(*) FROM public.mcp_message_reads WHERE user_id = pg_temp.f(u)
$h$;
CREATE FUNCTION pg_temp.last_outcome(k text) RETURNS text LANGUAGE sql VOLATILE AS $h$
  SELECT outcome FROM public.mcp_call_log WHERE connection_id = pg_temp.f(k) ORDER BY id DESC LIMIT 1
$h$;
-- message ids of every page of list_deal_messages on one deal, walked with the cursor (at most 200 pages)
CREATE FUNCTION pg_temp.walk(k text, deal text, lim int) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE r jsonb; c text; ids jsonb := '[]'; n int := 0; maxb int := 0;
BEGIN
  LOOP
    r := pg_temp.lst(k, deal, NULL, NULL, lim, c);
    IF r ->> 'ok' IS DISTINCT FROM 'true' THEN
      RETURN jsonb_build_object('error', r, 'pages', n);
    END IF;
    maxb := greatest(maxb, octet_length(r::text));
    ids := ids || coalesce((SELECT jsonb_agg(e -> 'message_id') FROM jsonb_array_elements(r -> 'result' -> 'messages') e), '[]');
    n := n + 1;
    c := r -> 'result' -> 'page' ->> 'next_cursor';
    EXIT WHEN c IS NULL OR n >= 200;
  END LOOP;
  RETURN jsonb_build_object('ids', ids, 'pages', n, 'max_bytes', maxb);
END $h$;
-- every part of get_message, joined; checks each answer's size
CREATE FUNCTION pg_temp.all_parts(k text, msg text) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE r jsonb; body text := ''; p int := 1; parts int; maxb int := 0; bad jsonb := '[]';
BEGIN
  LOOP
    r := pg_temp.getm(k, msg, p);
    IF r ->> 'ok' IS DISTINCT FROM 'true' THEN
      RETURN jsonb_build_object('error', r, 'part', p);
    END IF;
    maxb := greatest(maxb, octet_length(r::text));
    IF octet_length((r -> 'result')::text) > 90000 THEN bad := bad || to_jsonb(p); END IF;
    body := body || coalesce(r -> 'result' -> 'message' ->> 'body_text', '');
    parts := (r -> 'result' -> 'message' ->> 'parts')::int;
    IF (r -> 'result' -> 'message' ->> 'part')::int IS DISTINCT FROM p THEN
      RETURN jsonb_build_object('error', 'part number', 'part', p);
    END IF;
    EXIT WHEN p >= parts OR p >= 1000;
    p := p + 1;
  END LOOP;
  RETURN jsonb_build_object('parts', parts, 'max_bytes', maxb, 'over_cap', bad, 'body_md5', md5(body),
                            'after_last', pg_temp.getm(k, msg, parts + 1));
END $h$;
-- mutants: a reader is replaced as its owner (mcp_reader), as the migration creates it
CREATE FUNCTION pg_temp.as_reader(q text) RETURNS void LANGUAGE plpgsql AS $h$
BEGIN
  GRANT CREATE ON SCHEMA public TO mcp_reader;
  SET LOCAL ROLE mcp_reader;
  EXECUTE q;
  RESET ROLE;
  REVOKE CREATE ON SCHEMA public FROM mcp_reader;
END $h$;

-- desktop rows, in the shape the desktop's projection sends (jcsProjection-4243.test.ts:47) and cloud_upsert_messages
-- reads (20261123100000 cloud_upsert_messages): participants {from: string, to: [string], cc: [string]}
CREATE FUNCTION pg_temp.mrow(lid text, kind text, subject text, body text, people jsonb, sent text, recv text,
                             match_reason text, hidden boolean, thread text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT jsonb_build_object('local_id', lid, 'local_link_id', 'cm-' || lid, 'content_hash', pg_temp.h('m:' || lid || coalesce(body, '')),
    'channel_kind', kind, 'channel', CASE WHEN kind = 'text' THEN 'imessage' ELSE 'email' END, 'direction', 'inbound',
    'subject', subject, 'body_text', body, 'participants', people, 'thread_key', thread, 'sent_at', sent, 'received_at', recv,
    'link_source', 'auto', 'link_confidence', CASE WHEN match_reason = 'address_missing' THEN 0.5 ELSE 1 END,
    'match_reason', match_reason, 'linked_at', NULL, 'link_origin', 'link', 'hidden_from_export', hidden, 'source_updated_at', NULL)
$h$;
CREATE FUNCTION pg_temp.frow(lid text, msg text, name text, mime text, reason text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT jsonb_build_object('local_id', lid, 'content_hash', pg_temp.h('f:' || lid), 'filename', name, 'mime_type', mime,
    'size_bytes', 60000000, 'not_saved_reason', reason, 'message_local_id', msg, 'message_channel_kind', CASE WHEN msg IS NULL THEN NULL ELSE 'email' END)
$h$;
CREATE FUNCTION pg_temp.msgs(u text, inst text, deal text, rows jsonb) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE r jsonb := pg_temp.as_user(u, 'cloud_upsert_messages', '%L::uuid, %L::uuid, %L::uuid, %L::jsonb', pg_temp.s(u), pg_temp.s(inst), pg_temp.s(deal), rows::text);
BEGIN
  IF r ->> 'ok' IS DISTINCT FROM 'true' OR EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'results') e WHERE e ->> 'status' <> 'applied') THEN
    RAISE EXCEPTION 'FIXTURE messages on % failed: %', deal, left(r::text, 400);
  END IF;
  PERFORM pg_temp.put(e ->> 'local_id', (e ->> 'cloud_id')::uuid) FROM jsonb_array_elements(r -> 'results') e;
  RETURN r;
END $h$;
CREATE FUNCTION pg_temp.files(u text, inst text, deal text, rows jsonb) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE r jsonb := pg_temp.as_user(u, 'cloud_upsert_files', '%L::uuid, %L::uuid, %L::uuid, %L::jsonb', pg_temp.s(u), pg_temp.s(inst), pg_temp.s(deal), rows::text);
BEGIN
  IF r ->> 'ok' IS DISTINCT FROM 'true' OR EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'results') e WHERE e ->> 'status' <> 'applied') THEN
    RAISE EXCEPTION 'FIXTURE files on % failed: %', deal, left(r::text, 400);
  END IF;
  PERFORM pg_temp.put(e ->> 'local_id', (e ->> 'cloud_id')::uuid) FROM jsonb_array_elements(r -> 'results') e;
  RETURN r;
END $h$;
CREATE FUNCTION pg_temp.deal(u text, inst text, k text, status text) RETURNS uuid LANGUAGE plpgsql AS $h$
DECLARE r jsonb := pg_temp.as_user(u, 'cloud_upsert_deal', '%L::uuid, %L::jsonb', pg_temp.s(u),
          jsonb_build_object('source_install_id', pg_temp.s(inst), 'local_id', 'p4263t-' || k, 'content_hash', pg_temp.h('d:' || k),
                             'property_address', 'Fixture ' || k || ' Street', 'status', status)::text);
BEGIN
  IF r -> 'results' -> 0 ->> 'status' IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'FIXTURE deal % failed: %', k, left(r::text, 400); END IF;
  RETURN pg_temp.put(k, (r -> 'results' -> 0 ->> 'cloud_id')::uuid);
END $h$;
CREATE FUNCTION pg_temp.tomb(u text, inst text, kind text, ids uuid[]) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.as_user(u, 'cloud_tombstone', '%L::uuid, %L::uuid, %L, %L::uuid[]', pg_temp.s(u), pg_temp.s(inst), kind, ids::text)
$h$;
CREATE FUNCTION pg_temp.claim(u text, inst text, rep boolean) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.as_user(u, 'cloud_claim_install', '%L::uuid, %L::uuid, %L::boolean', pg_temp.s(u), pg_temp.s(inst), rep::text)
$h$;
CREATE FUNCTION pg_temp.ids(VARIADIC ks text[]) RETURNS jsonb LANGUAGE sql STABLE AS $h$
  SELECT coalesce(jsonb_agg(to_jsonb(pg_temp.s(k)) ORDER BY pg_temp.s(k)), '[]') FROM unnest(ks) k
$h$;
CREATE FUNCTION pg_temp.sorted(a jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(jsonb_agg(e ORDER BY e #>> '{}'), '[]') FROM jsonb_array_elements(a) e
$h$;
