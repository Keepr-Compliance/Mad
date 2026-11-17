-- BACKLOG-4263 probes. Each returns PASS or FAIL: <detail>. Loaded after lib/fixtures.sql.

CREATE FUNCTION pg_temp.k_columns() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT '["deal_id","address","transaction_type","status","started_on","closed_on","mutual_acceptance_date","closing_deadline","listing_price","sale_price","earnest_money_amount","commission_offered_rate","commission_actual_rate","commission_gross_amount","saved_from","found_by","locked"]'::jsonb
$h$;

-- owner and confirmed: A sees exactly its confirmed deals, B exactly its own
CREATE FUNCTION pg_temp.p_iso() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE ta text := pg_temp.la('a1'); tb text := pg_temp.la('b1');
        wa uuid[] := (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[pg_temp.id('A1'), pg_temp.id('A2'), pg_temp.id('A6'), pg_temp.id('A7')]) x);
BEGIN
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.err(ta) = 'OK' AND pg_temp.aids(ta) = wa, 'A got ' || left(ta, 300)),
    pg_temp.pass(pg_temp.err(tb) = 'OK' AND pg_temp.aids(tb) = ARRAY[pg_temp.id('B1')], 'B got ' || left(tb, 300)),
    pg_temp.pass(NOT pg_temp.id('B1') = ANY (pg_temp.aids(ta)), 'B1 in A'));
END $h$;

CREATE FUNCTION pg_temp.p_unconfirmed() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE t text := pg_temp.la('a1');
BEGIN
  RETURN pg_temp.all_of(pg_temp.pass(pg_temp.err(t) = 'OK', left(t, 200)),
    pg_temp.pass(NOT pg_temp.id('A3') = ANY (pg_temp.aids(t)), 'pending detection returned'),
    pg_temp.pass(NOT pg_temp.id('A4') = ANY (pg_temp.aids(t)), 'rejected returned'));
END $h$;

-- a deal deleted with cloud_delete_deal has no row (hard delete at this ref); assertion only
CREATE FUNCTION pg_temp.p_removed() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE t text := pg_temp.la('a1');
BEGIN
  RETURN pg_temp.all_of(pg_temp.pass(pg_temp.err(t) = 'OK', left(t, 200)),
    pg_temp.pass(pg_temp.id('A5') IS NOT NULL AND NOT pg_temp.id('A5') = ANY (pg_temp.aids(t)), 'deleted deal returned'),
    pg_temp.pass(NOT EXISTS (SELECT 1 FROM public.cloud_deals WHERE id = pg_temp.id('A5')), 'deleted deal row still present'));
END $h$;

-- values: columns, numbers, dates, masking, saved_from, found_by, locked
CREATE FUNCTION pg_temp.p_values() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE t text := pg_temp.la('a1'); r jsonb := pg_temp.res_of(t); a1 jsonb := pg_temp.arow(t, pg_temp.id('A1'));
        a2 jsonb := pg_temp.arow(t, pg_temp.id('A2')); a7 jsonb := pg_temp.arow(t, pg_temp.id('A7'));
BEGIN
  RETURN pg_temp.all_of(
    pg_temp.pass(r ->> 'kind' = 'keepr.list_all_deals' AND r -> 'v' = '1'::jsonb, left(t, 200)),
    pg_temp.pass(r -> 'columns' = pg_temp.k_columns(), r ->> 'columns'),
    pg_temp.pass(pg_temp.keys(r) = ARRAY['about', 'columns', 'kind', 'page', 'rows', 'v'], array_to_string(pg_temp.keys(r), ',')),
    pg_temp.pass(pg_temp.keys(r -> 'page') = ARRAY['next_cursor', 'returned'], (r -> 'page')::text),
    pg_temp.pass((SELECT bool_and(jsonb_array_length(x) = 17) FROM jsonb_array_elements(r -> 'rows') x), 'row length'),
    pg_temp.pass(a1 - 1 = jsonb_build_array(pg_temp.id('A1'), 'purchase', 'closed', '2026-01-05', '2026-03-15', '2026-02-01', '2026-03-14',
                   625000, 612000, 10000, 2.5, 2.75, 16830.5, 1, 'person', NULL) , 'A1 ' || a1::text),
    pg_temp.pass(a1 ->> 1 = '1847 Alder Ridge Ln Unit [number hidden by Keepr], Fernhollow, WA 98999', 'A1 address ' || (a1 ->> 1)),
    pg_temp.pass(a2 = jsonb_build_array(pg_temp.id('A2'), '52 Cobble Wren Ct, Larchmont Bay, WA 98998', 'sale', 'active', NULL, NULL, NULL, NULL,
                   NULL, NULL, 5000, NULL, NULL, NULL, 2, 'person', NULL), 'A2 ' || a2::text),
    pg_temp.pass(a7 -> 15 = '"keepr"'::jsonb AND a7 -> 16 = '"submitted"'::jsonb, 'A7 ' || a7::text),
    pg_temp.pass((r -> 'page' -> 'returned')::int = 4 AND r -> 'page' -> 'next_cursor' = 'null'::jsonb, (r -> 'page')::text));
END $h$;

-- address masking alone (the card number in A1's address)
CREATE FUNCTION pg_temp.p_mask() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE t text := pg_temp.la('a1'); a1 jsonb := pg_temp.arow(t, pg_temp.id('A1'));
BEGIN
  RETURN pg_temp.pass(a1 ->> 1 LIKE '%[number hidden by Keepr]%' AND a1::text NOT LIKE '%4111%', coalesce(a1::text, left(t, 200)));
END $h$;

CREATE FUNCTION pg_temp.p_filters() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE A1 uuid := pg_temp.id('A1'); A6 uuid := pg_temp.id('A6');
        ab uuid[] := (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[pg_temp.id('A1'), pg_temp.id('A6')]) x);
BEGIN
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.aids(pg_temp.la('a1', 'closed')) = ab, 'status closed'),
    pg_temp.pass(pg_temp.aids(pg_temp.la('a1', 'pending')) = ARRAY[pg_temp.id('A7')], 'status pending'),
    pg_temp.pass(pg_temp.aids(pg_temp.la('a1', NULL, '2026-01-01')) = ARRAY[A1], 'closed_from'),
    pg_temp.pass(pg_temp.aids(pg_temp.la('a1', NULL, NULL, '2025-12-31')) = ARRAY[A6], 'closed_to (UTC date)'),
    pg_temp.pass(pg_temp.aids(pg_temp.la('a1', NULL, '2026-03-15', '2026-03-15')) = ARRAY[A1], 'from = to, inclusive'),
    pg_temp.pass(pg_temp.aids(pg_temp.la('a1', NULL, '2026-03-16', '2026-12-31')) = ARRAY[]::uuid[]
                 AND pg_temp.err(pg_temp.la('a1', NULL, '2026-03-16', '2026-12-31')) = 'OK', 'empty range'),
    pg_temp.pass(pg_temp.aids(pg_temp.la('a1', 'closed', '2025-01-01', '2026-12-31')) = ab, 'status and range'));
END $h$;

CREATE FUNCTION pg_temp.p_args() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE u text := pg_temp.id('A1')::text; bad text := ''; x text[];
BEGIN
  FOREACH x SLICE 1 IN ARRAY ARRAY[
      ARRAY['rejected', NULL, NULL, NULL], ARRAY[NULL, '2026-13-01', NULL, NULL], ARRAY[NULL, '2026-1-1', NULL, NULL],
      ARRAY[NULL, NULL, '20260101', NULL], ARRAY[NULL, '2026-03-02', '2026-03-01', NULL], ARRAY[NULL, NULL, NULL, 'garbage'],
      ARRAY[NULL, NULL, NULL, upper(u)], ARRAY[NULL, NULL, NULL, '{' || u || '}'], ARRAY[NULL, NULL, NULL, replace(u, '-', '')],
      ARRAY[NULL, NULL, NULL, '2026-11-01T00:00:08.000000Z|' || u], ARRAY[NULL, NULL, NULL, u || ' ']] LOOP
    IF pg_temp.err(pg_temp.la('a1', x[1], x[2], x[3], x[4])) <> 'invalid_input' THEN bad := bad || array_to_string(x, '/', '-') || '; '; END IF;
  END LOOP;
  RETURN pg_temp.all_of(pg_temp.pass(bad = '', 'accepted: ' || bad),
    pg_temp.pass(pg_temp.err(pg_temp.la('a1', 'closed', '2025-01-01', '2026-12-31', u)) = 'OK', 'valid arguments refused'),
    pg_temp.pass(pg_temp.nlog('list_all_deals', 'invalid_input') >= 11, 'invalid_input not logged'));
END $h$;

CREATE FUNCTION pg_temp.p_tokens() RETURNS text LANGUAGE plpgsql AS $h$
BEGIN
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.err(pg_temp.la('a1', NULL, NULL, NULL, NULL, 'wrong-secret')) = 'not_connected', 'wrong secret'),
    pg_temp.pass(pg_temp.err(pg_temp.la('a1', NULL, NULL, NULL, NULL, NULL)) = 'not_connected', 'no secret'),
    pg_temp.pass(pg_temp.err(pg_temp.la('ax')) = 'not_connected', 'expired token'),
    pg_temp.pass(pg_temp.err(pg_temp.la('zz')) = 'not_connected', 'unknown token'),
    pg_temp.pass(pg_temp.err(pg_temp.la('a1')) = 'OK', 'valid token refused'));
END $h$;

CREATE FUNCTION pg_temp.p_ent() RETURNS text LANGUAGE plpgsql AS $h$
BEGIN
  RETURN pg_temp.pass(pg_temp.err(pg_temp.la('d1')) = 'not_entitled' AND pg_temp.nlog('list_all_deals', 'not_entitled') >= 1, pg_temp.la('d1'));
END $h$;

-- every page bounded; at least one row; next_cursor on both stop reasons; maximal page; every deal once
CREATE FUNCTION pg_temp.p_bound() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE wf jsonb := pg_temp.walk('f1'); wg jsonb := pg_temp.walk('g1');
        f1 text := pg_temp.la('f1'); g1 text := pg_temp.la('g1'); nx text; nb int;
        fids uuid[]; gids uuid[];
BEGIN
  SELECT array_agg(x::uuid ORDER BY x::uuid) INTO fids FROM jsonb_array_elements_text(wf -> 'ids') x;
  SELECT array_agg(x::uuid ORDER BY x::uuid) INTO gids FROM jsonb_array_elements_text(wg -> 'ids') x;
  nx := pg_temp.la('f1', NULL, NULL, NULL, pg_temp.ncur(f1));
  nb := octet_length((pg_temp.res_of(nx) -> 'rows' -> 0)::text) + 2;
  RETURN pg_temp.all_of(
    pg_temp.pass(wf ->> 'err' = 'OK' AND wg ->> 'err' = 'OK', wf::text || wg::text),
    pg_temp.pass(fids = pg_temp.owned(pg_temp.fx(6)) AND cardinality(fids) = 420, 'F not every deal once: ' || coalesce(cardinality(fids), 0)),
    pg_temp.pass(gids = pg_temp.owned(pg_temp.fx(7)) AND cardinality(gids) = 600, 'G not every deal once: ' || coalesce(cardinality(gids), 0)),
    pg_temp.pass((wf ->> 'max_rows_bytes')::int <= 85000 AND (wg ->> 'max_rows_bytes')::int <= 85000, 'rows bytes ' || (wf ->> 'max_rows_bytes') || '/' || (wg ->> 'max_rows_bytes')),
    pg_temp.pass((wf ->> 'max_frame')::int <= 90000 AND (wg ->> 'max_frame')::int <= 90000, 'frame ' || (wf ->> 'max_frame')),
    pg_temp.pass((wf ->> 'min_rows')::int >= 1 AND (wg ->> 'min_rows')::int >= 1, 'empty page'),
    pg_temp.pass((wf ->> 'pages')::int = 2 AND (wg ->> 'pages')::int = 2, 'pages ' || (wf ->> 'pages') || '/' || (wg ->> 'pages')),
    -- F: the byte bound stops page 1 and the next row would not fit
    pg_temp.pass(pg_temp.ncur(f1) IS NOT NULL AND (pg_temp.res_of(f1) -> 'page' -> 'returned')::int < 500
                 AND pg_temp.rbytes(f1) + nb > 85000, 'F page 1 not maximal: ' || pg_temp.rbytes(f1) || '+' || nb),
    -- G: the 500-row bound stops page 1 under the byte bound
    pg_temp.pass(pg_temp.ncur(g1) IS NOT NULL AND (pg_temp.res_of(g1) -> 'page' -> 'returned')::int = 500 AND pg_temp.rbytes(g1) < 85000,
                 'G page 1 ' || (pg_temp.res_of(g1) -> 'page')::text || ' bytes ' || pg_temp.rbytes(g1)),
    pg_temp.pass(pg_temp.ncur(f1) = (pg_temp.res_of(f1) -> 'rows' -> -1 ->> 0), 'next_cursor is not the last row'));
END $h$;

-- the boundary, exactly: grow addresses of the first rows of F's page 1 until the rows count exactly 85000
-- bytes (the last row stays), then by one more byte (the last row moves to page 2)
CREATE FUNCTION pg_temp.p_boundary() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE t text := pg_temp.la('f1'); n int; slack int; k int := 0; d uuid; room int; add int; t2 text; t3 text; last uuid; r text;
BEGIN
  n := (pg_temp.res_of(t) -> 'page' -> 'returned')::int;
  last := (pg_temp.res_of(t) -> 'rows' -> (n - 1) ->> 0)::uuid;
  slack := 85000 - pg_temp.rbytes(t);
  WHILE slack > 0 LOOP
    d := (pg_temp.res_of(t) -> 'rows' -> k ->> 0)::uuid;
    SELECT least(slack, 290 - char_length(property_address)) INTO add FROM public.cloud_deals WHERE id = d;
    UPDATE public.cloud_deals SET property_address = property_address || repeat('x', add) WHERE id = d;
    slack := slack - add; k := k + 1;
  END LOOP;
  t2 := pg_temp.la('f1');
  d := (pg_temp.res_of(t) -> 'rows' -> 0 ->> 0)::uuid;
  UPDATE public.cloud_deals SET property_address = property_address || 'y' WHERE id = d;
  t3 := pg_temp.la('f1');
  r := pg_temp.all_of(
    pg_temp.pass(pg_temp.rbytes(t2) = 85000 AND (pg_temp.res_of(t2) -> 'page' -> 'returned')::int = n
                 AND pg_temp.ncur(t2) = last::text, 'at 85000: bytes ' || pg_temp.rbytes(t2) || ' returned ' || (pg_temp.res_of(t2) -> 'page')::text),
    pg_temp.pass((pg_temp.res_of(t3) -> 'page' -> 'returned')::int = n - 1 AND pg_temp.rbytes(t3) <= 85000
                 AND NOT last = ANY (pg_temp.aids(t3)) AND (pg_temp.aids(pg_temp.la('f1', NULL, NULL, NULL, pg_temp.ncur(t3))))[1] = last,
                 'at 85001: ' || (pg_temp.res_of(t3) -> 'page')::text || ' bytes ' || pg_temp.rbytes(t3)),
    pg_temp.pass(octet_length(pg_temp.res_of(t2)::text) <= 90000, 'frame at boundary ' || octet_length(pg_temp.res_of(t2)::text)));
  RETURN r;
END $h$;

-- a deal changed between pages (save time, status, address) is neither skipped nor repeated
CREATE FUNCTION pg_temp.p_cursor_stable() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE t1 text := pg_temp.la('f1'); t2 text; ids uuid[]; srt uuid[]; early uuid; late uuid;
BEGIN
  early := (pg_temp.res_of(t1) -> 'rows' -> 5 ->> 0)::uuid;
  late := (SELECT x FROM unnest(pg_temp.owned(pg_temp.fx(6))) x ORDER BY x DESC LIMIT 1);
  UPDATE public.cloud_deals SET last_synced_at = now() + interval '1 hour', status = 'active', property_address = 'Moved ' || property_address,
         updated_at = now() + interval '1 hour' WHERE id IN (early, late);
  t2 := pg_temp.la('f1', NULL, NULL, NULL, pg_temp.ncur(t1));
  ids := pg_temp.aids(t1) || pg_temp.aids(t2);
  SELECT array_agg(x ORDER BY x) INTO srt FROM unnest(ids) x;
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.ncur(t2) IS NULL, 'more than two pages: ' || (pg_temp.res_of(t2) -> 'page')::text),
    pg_temp.pass(srt = pg_temp.owned(pg_temp.fx(6)), 'skipped or repeated: ' || cardinality(ids) || ' rows, ' || (SELECT count(DISTINCT x) FROM unnest(ids) x) || ' distinct'));
END $h$;

-- read-only: a reader that writes to a real table through a VOLATILE function is refused (error), and
-- the write does not persist
CREATE FUNCTION pg_temp.p_ro() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE t text; src text;
BEGIN
  CREATE TABLE public.p4263_w (x int);
  CREATE FUNCTION public.p4263_write() RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS 'INSERT INTO public.p4263_w VALUES (1)';
  GRANT EXECUTE ON FUNCTION public.p4263_write() TO mcp_reader;
  SELECT pg_get_functiondef('public._mcp_r_list_all_deals(text,date,date,uuid)'::regprocedure) INTO src;
  src := replace(src, E'BEGIN\n  IF v_uid IS NULL THEN', E'BEGIN\n  PERFORM public.p4263_write();\n  IF v_uid IS NULL THEN');
  IF src NOT LIKE '%p4263_write%' THEN RETURN 'FAIL: reader variant not built'; END IF;
  EXECUTE 'GRANT CREATE ON SCHEMA public TO mcp_reader'; EXECUTE 'SET ROLE mcp_reader';
  EXECUTE src;
  EXECUTE 'RESET ROLE'; EXECUTE 'REVOKE CREATE ON SCHEMA public FROM mcp_reader';
  t := pg_temp.la('a1');
  RETURN pg_temp.all_of(pg_temp.pass(pg_temp.err(t) = 'error', 'reader write not refused: ' || left(t, 200)),
    pg_temp.pass((SELECT count(*) FROM public.p4263_w) = 0, 'write persisted'));
END $h$;

CREATE FUNCTION pg_temp.p_grants() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE rd regprocedure := 'public._mcp_r_list_all_deals(text,date,date,uuid)'; tl regprocedure := 'public.mcp_list_all_deals(text,bytea,text,text,text,text,text)';
        bad text := '';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid IN (rd, tl) AND a.grantee = 0) THEN bad := bad || 'PUBLIC '; END IF;
  IF has_function_privilege('anon', rd, 'EXECUTE') THEN bad := bad || 'reader:anon '; END IF;
  IF has_function_privilege('authenticated', rd, 'EXECUTE') THEN bad := bad || 'reader:authenticated '; END IF;
  IF has_function_privilege('service_role', rd, 'EXECUTE') THEN bad := bad || 'reader:service_role '; END IF;
  IF NOT has_function_privilege('anon', tl, 'EXECUTE') THEN bad := bad || 'tool:not_anon '; END IF;
  IF has_function_privilege('authenticated', tl, 'EXECUTE') THEN bad := bad || 'tool:authenticated '; END IF;
  IF has_function_privilege('service_role', tl, 'EXECUTE') THEN bad := bad || 'tool:service_role '; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = rd AND a.privilege_type = 'EXECUTE' AND a.grantee NOT IN (p.proowner, 'postgres'::regrole)) THEN bad := bad || 'reader:extra '; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = tl AND a.privilege_type = 'EXECUTE' AND a.grantee NOT IN (p.proowner, 'anon'::regrole)) THEN bad := bad || 'tool:extra '; END IF;
  IF (SELECT p.proowner <> 'mcp_reader'::regrole OR p.provolatile <> 's' OR NOT p.prosecdef OR NOT p.proconfig @> ARRAY['search_path=""'] FROM pg_proc p WHERE p.oid = rd) THEN bad := bad || 'reader:kind '; END IF;
  IF (SELECT p.proowner <> 'postgres'::regrole OR p.provolatile <> 'v' OR NOT p.prosecdef OR NOT p.proconfig @> ARRAY['search_path=""'] FROM pg_proc p WHERE p.oid = tl) THEN bad := bad || 'tool:kind '; END IF;
  IF has_schema_privilege('mcp_reader', 'public', 'CREATE') THEN bad := bad || 'schema_create '; END IF;
  IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'mcp_reader') THEN bad := bad || 'bypassrls '; END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_' AND has_function_privilege('anon', p.oid, 'EXECUTE')) <> 10 THEN bad := bad || 'anon_count '; END IF;
  RETURN pg_temp.pass(bad = '', bad);
END $h$;

-- one call: one log row naming the tool, finished, rows counted; both rate counters up by exactly one
CREATE FUNCTION pg_temp.p_log() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE n0 bigint := (SELECT count(*) FROM public.mcp_call_log); t text := pg_temp.la('a1'); l public.mcp_call_log%ROWTYPE;
BEGIN
  SELECT * INTO l FROM public.mcp_call_log ORDER BY id DESC LIMIT 1;
  RETURN pg_temp.all_of(pg_temp.pass(pg_temp.err(t) = 'OK', left(t, 200)),
    pg_temp.pass((SELECT count(*) FROM public.mcp_call_log) = n0 + 1, 'log rows +' || ((SELECT count(*) FROM public.mcp_call_log) - n0)),
    pg_temp.pass(l.tool = 'list_all_deals' AND l.outcome = 'ok' AND l.rows_returned = 4 AND l.ended_at IS NOT NULL
                 AND l.user_id = pg_temp.fx(1) AND l.connection_id = pg_temp.id('CONN_A1') AND l.event = 'call',
                 coalesce(l.tool, '-') || '/' || l.outcome || '/' || coalesce(l.rows_returned::text, '-')));
END $h$;

CREATE FUNCTION pg_temp.cnt(b text) RETURNS integer LANGUAGE sql AS $h$
  SELECT coalesce((SELECT c.count FROM public.mcp_rate_counters c WHERE c.bucket = b AND c.window_start = public._mcp_window(interval '1 minute')), 0)
$h$;
CREATE FUNCTION pg_temp.p_rate() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE cb text := 'call_conn:' || pg_temp.id('CONN_A1'); ub text := 'call_user:' || pg_temp.fx(1); c1 int; u1 int; x text; t text; outs text := ''; i int;
BEGIN
  t := pg_temp.la('a1');  -- clears the counters first, then one call
  c1 := pg_temp.cnt(cb); u1 := pg_temp.cnt(ub);
  FOR i IN 2 .. 31 LOOP
    x := pg_temp.err(pg_temp.la_raw('a1'));
    outs := outs || CASE WHEN x = 'OK' THEN '.' ELSE x || '@' || i || ' ' END;
  END LOOP;
  RETURN pg_temp.all_of(pg_temp.pass(c1 = 1 AND u1 = 1, 'after one call conn=' || c1 || ' user=' || u1),
    pg_temp.pass(outs = repeat('.', 29) || 'rate_limited@31 ', outs));
END $h$;
