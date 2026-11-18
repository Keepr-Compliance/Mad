-- BACKLOG-4263 list_deals address match harness: controls. Each control returns 'PASS' or 'FAIL: <detail>' and is
-- run in its own subtransaction (pg_temp.iso), so nothing it writes (call log rows, counters) outlives it.
-- Markers between double at-signs are filled in by gen.py.

CREATE FUNCTION pg_temp.iso(fn text) RETURNS text LANGUAGE plpgsql AS $h$
DECLARE v text;
BEGIN
  BEGIN
    EXECUTE format('SELECT pg_temp.%I()', fn) INTO v;
    RAISE EXCEPTION USING ERRCODE = 'MX001';
  EXCEPTION
    WHEN SQLSTATE 'MX001' THEN NULL;
    WHEN OTHERS THEN v := 'FAIL: ERR ' || SQLSTATE || ' ' || left(SQLERRM, 300);
  END;
  RETURN v;
END $h$;

CREATE FUNCTION pg_temp.unrate() RETURNS void LANGUAGE sql AS $h$
  DELETE FROM public.mcp_rate_counters WHERE bucket IN ('call_conn:' || pg_temp.id('KA')::text, 'call_user:' || pg_temp.id('A')::text)
$h$;
-- one mcp_list_deals call as anon, with the claims PostgREST leaves for anon
CREATE FUNCTION pg_temp.ld(term text, st text DEFAULT NULL, lim int DEFAULT 50, cur text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE r jsonb; qs text := format('SELECT public.mcp_list_deals(%L, %L::bytea, %L, %L, %L, %L::integer, %L)', pg_temp.secret(), pg_temp.dgl(1), pg_temp.res(), st, term, lim, cur);
BEGIN
  PERFORM pg_temp.unrate();
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN
    EXECUTE qs INTO r;
  EXCEPTION WHEN OTHERS THEN r := jsonb_build_object('sqlerr', SQLSTATE, 'msg', left(SQLERRM, 200));
  END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.clear_claims();
  RETURN r;
END $h$;
-- number of deals of an ok answer; -1 for anything else (a refusal never counts as "found nothing")
CREATE FUNCTION pg_temp.n_ok(r jsonb) RETURNS int LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN r ->> 'ok' = 'true' AND jsonb_typeof(r -> 'result' -> 'deals') = 'array' THEN jsonb_array_length(r -> 'result' -> 'deals') ELSE -1 END
$h$;
CREATE FUNCTION pg_temp.ids(r jsonb) RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(array_agg((x ->> 'deal_id')::uuid ORDER BY o), '{}') FROM jsonb_array_elements(r -> 'result' -> 'deals') WITH ORDINALITY t(x, o)
$h$;
CREATE FUNCTION pg_temp.sids(r jsonb) RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN pg_temp.n_ok(r) < 0 THEN NULL ELSE (SELECT coalesce(array_agg(x ORDER BY x), '{}') FROM unnest(pg_temp.ids(r)) x) END
$h$;
CREATE FUNCTION pg_temp.keyset(VARIADIC k text[]) RETURNS uuid[] LANGUAGE sql STABLE AS $h$
  SELECT coalesce(array_agg(pg_temp.id(x) ORDER BY pg_temp.id(x)), '{}') FROM unnest(k) x
$h$;
CREATE FUNCTION pg_temp.names(a uuid[]) RETURNS text LANGUAGE sql STABLE AS $h$
  SELECT coalesce(string_agg(coalesce((SELECT f.k FROM pg_temp.pa_fx f WHERE f.v = x::text ORDER BY f.k LIMIT 1), '?'), ',' ORDER BY o), '-') FROM unnest(a) WITH ORDINALITY t(x, o)
$h$;
-- every live deal of A as answered (no term); A has fewer than 50
CREATE FUNCTION pg_temp.listing() RETURNS jsonb LANGUAGE sql AS $h$ SELECT pg_temp.ld(NULL, NULL, 50) -> 'result' -> 'deals' $h$;
-- ids of the deals whose answered address contains the term (not case sensitive; compared with strpos, not ILIKE)
CREATE FUNCTION pg_temp.shown(l jsonb, term text, st text DEFAULT NULL) RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(array_agg((x ->> 'deal_id')::uuid ORDER BY (x ->> 'deal_id')::uuid), '{}') FROM jsonb_array_elements(l) x
   WHERE strpos(lower(x ->> 'address'), lower(term)) > 0 AND (st IS NULL OR x ->> 'status' = st)
$h$;

-- the reviewer's probe: digits the answer hides cannot be confirmed by a search; visible text and the mask still find
CREATE FUNCTION pg_temp.c_mask() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE t text; r jsonb; out text[] := '{}'; l jsonb := pg_temp.listing();
BEGIN
  FOREACH t IN ARRAY ARRAY['4111', '1111 1111', '4111-1111-1', '4111-1112', '1111-1111-1111-1111', '987-65', '65-4321', '987-65-4', '4321', '41', '11', 'lot 4', 'unit 9'] LOOP
    r := pg_temp.ld(t);
    out := out || pg_temp.pass(pg_temp.n_ok(r) = 0, 'hidden ' || t || ' -> ' || pg_temp.n_ok(r) || ' ' || pg_temp.names(pg_temp.ids(r)));
  END LOOP;
  out := out || pg_temp.pass(pg_temp.sids(pg_temp.ld('Invented Rd')) = pg_temp.keyset('AC', 'AP'), 'Invented Rd ' || pg_temp.names(pg_temp.sids(pg_temp.ld('Invented Rd'))));
  out := out || pg_temp.pass(pg_temp.sids(pg_temp.ld('Fixture Ct')) = pg_temp.keyset('AS'), 'Fixture Ct');
  out := out || pg_temp.pass(pg_temp.sids(pg_temp.ld('unit')) = pg_temp.keyset('AS', 'AP'), 'unit ' || pg_temp.names(pg_temp.sids(pg_temp.ld('unit'))));
  out := out || pg_temp.pass(pg_temp.sids(pg_temp.ld('lot [')) = pg_temp.keyset('AC', 'AP'), 'lot [');
  r := pg_temp.ld('number hidden by keepr');
  out := out || pg_temp.pass(pg_temp.sids(r) = pg_temp.keyset('AC', 'AS', 'AP', 'AM') AND pg_temp.sids(r) = pg_temp.shown(l, '[number hidden by keepr]'),
                             'mask text ' || pg_temp.names(pg_temp.sids(r)) || ' shown ' || pg_temp.names(pg_temp.shown(l, '[number hidden by keepr]')));
  out := out || pg_temp.pass(pg_temp.ld('4') ->> 'error' = 'invalid_input', 'one character');
  out := out || pg_temp.pass(jsonb_array_length(l) = @@A_LIVE@@, 'listing ' || coalesce(jsonb_array_length(l)::text, 'null'));
  RETURN pg_temp.all_of(VARIADIC out);
END $h$;

-- for every term: the deals found are exactly the deals whose answered address contains the term
CREATE FUNCTION pg_temp.c_shown() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE t text; got uuid[]; want uuid[]; out text[] := '{}'; l jsonb := pg_temp.listing(); hits int := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY[@@TERMS@@] LOOP
    got := pg_temp.sids(pg_temp.ld(t));
    want := pg_temp.shown(l, t);
    hits := hits + cardinality(want);
    out := out || pg_temp.pass(got IS NOT DISTINCT FROM want, t || ': got ' || coalesce(pg_temp.names(got), 'refused') || ' want ' || pg_temp.names(want));
  END LOOP;
  out := out || pg_temp.pass(hits > 40 AND jsonb_array_length(l) = @@A_LIVE@@, 'hits ' || hits);
  RETURN pg_temp.all_of(VARIADIC out);
END $h$;

-- text after the 300-character cut is not searchable; text before it is
CREATE FUNCTION pg_temp.c_cut() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE l jsonb := pg_temp.listing(); a text;
BEGIN
  SELECT x ->> 'address' INTO a FROM jsonb_array_elements(l) x WHERE (x ->> 'deal_id')::uuid = pg_temp.id('ACUT');
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.sids(pg_temp.ld('midmarker')) = pg_temp.keyset('ACUT'), 'midmarker'),
    pg_temp.pass(pg_temp.n_ok(pg_temp.ld('tailmarker')) = 0, 'tailmarker ' || pg_temp.n_ok(pg_temp.ld('tailmarker'))),
    pg_temp.pass(pg_temp.n_ok(pg_temp.ld('end end')) = 0, 'end end'),
    pg_temp.pass(char_length(a) = 300 AND right(a, 1) = '…' AND strpos(a, 'tailmarker') = 0, 'shown ' || coalesce(char_length(a)::text, 'null')),
    pg_temp.pass((SELECT strpos(property_address, 'tailmarker') > 300 FROM public.cloud_deals WHERE id = pg_temp.id('ACUT')), 'fixture'));
END $h$;

-- %, _ and \ are literal; not case sensitive
CREATE FUNCTION pg_temp.c_terms() RETURNS text LANGUAGE plpgsql AS $h$
BEGIN
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.sids(pg_temp.ld('50%')) = pg_temp.keyset('APC'), '50%'),
    pg_temp.pass(pg_temp.sids(pg_temp.ld('0%')) = pg_temp.keyset('APC'), '0%'),
    pg_temp.pass(pg_temp.sids(pg_temp.ld('a_b')) = pg_temp.keyset('AUS'), 'a_b ' || pg_temp.names(pg_temp.sids(pg_temp.ld('a_b')))),
    pg_temp.pass(pg_temp.sids(pg_temp.ld('_b')) = pg_temp.keyset('AUS'), '_b'),
    pg_temp.pass(pg_temp.sids(pg_temp.ld('axb')) = pg_temp.keyset('AXB'), 'axb'),
    pg_temp.pass(pg_temp.sids(pg_temp.ld('k\s')) = pg_temp.keyset('ABS'), 'k\s'),
    pg_temp.pass(pg_temp.n_ok(pg_temp.ld('%%')) = 0, '%% ' || pg_temp.n_ok(pg_temp.ld('%%'))),
    pg_temp.pass(pg_temp.n_ok(pg_temp.ld('__')) = 0, '__ ' || pg_temp.n_ok(pg_temp.ld('__'))),
    pg_temp.pass(pg_temp.sids(pg_temp.ld('mixed case')) = pg_temp.keyset('ACS'), 'mixed case'),
    pg_temp.pass(pg_temp.sids(pg_temp.ld('MIXED CASE')) = pg_temp.keyset('ACS'), 'MIXED CASE'),
    pg_temp.pass(pg_temp.sids(pg_temp.ld('zerowidth')) = pg_temp.keyset('AZ'), 'zerowidth'));
END $h$;

-- status filter with a term, and paging through a term
CREATE FUNCTION pg_temp.c_filters() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE l jsonb := pg_temp.listing(); r jsonb; cur text; walk uuid[] := '{}'; pages int := 0; allids uuid[]; st text; out text[] := '{}';
BEGIN
  FOREACH st IN ARRAY ARRAY['active', 'pending', 'closed'] LOOP
    out := out || pg_temp.pass(pg_temp.sids(pg_temp.ld('fixture', st)) = pg_temp.shown(l, 'fixture', st), 'status ' || st);
  END LOOP;
  out := out || pg_temp.pass(pg_temp.sids(pg_temp.ld('Invented Rd', 'closed')) = pg_temp.keyset('AP'), 'Invented Rd closed');
  allids := pg_temp.ids(pg_temp.ld('fixture', NULL, 50));
  LOOP
    r := pg_temp.ld('fixture', NULL, 2, cur);
    EXIT WHEN pg_temp.n_ok(r) < 0 OR pages > 30;
    walk := walk || pg_temp.ids(r);
    pages := pages + 1;
    cur := r -> 'result' -> 'page' ->> 'next_cursor';
    EXIT WHEN cur IS NULL;
  END LOOP;
  out := out || pg_temp.pass(walk = allids AND pages = (cardinality(allids) + 1) / 2 AND cardinality(allids) > 10
                              AND (SELECT count(DISTINCT x) FROM unnest(walk) x) = cardinality(walk),
                             'walk ' || cardinality(walk) || ' pages ' || pages || ' allids ' || cardinality(allids));
  RETURN pg_temp.all_of(VARIADIC out);
END $h$;

-- the apply post-check, run again against the snapshot taken before the apply
CREATE FUNCTION pg_temp.c_catalog() RETURNS text LANGUAGE plpgsql AS $h$
BEGIN
  EXECUTE @@POSTCHECK@@;
  RETURN 'PASS';
EXCEPTION WHEN OTHERS THEN RETURN 'FAIL: ' || left(SQLERRM, 700);
END $h$;

-- ================================================================ the body before this migration, under a temporary name
-- one reader call as the database owner with the user's claims (how the wrapper reaches the reader)
CREATE FUNCTION pg_temp.rd(fn text, u uuid, st text, q text, lim int, ts timestamptz, id uuid) RETURNS text LANGUAGE sql AS $h$
  SELECT pg_temp.as_user(u, format('SELECT public.%I(%L, %L, %L::integer, %L::timestamptz, %L::uuid)', fn, st, q, lim, ts, id))
$h$;
-- runs pg_temp.<fn>() while public._mcp_r_list_deals_x4263old (owner mcp_reader, the old body) exists; undone after
CREATE FUNCTION pg_temp.with_old(fn text) RETURNS text LANGUAGE plpgsql AS $h$
DECLARE v text; ok boolean := false;
BEGIN
  BEGIN
    EXECUTE 'GRANT CREATE ON SCHEMA public TO mcp_reader';
    EXECUTE 'SET ROLE mcp_reader';
    EXECUTE @@OLDCOPY@@;
    EXECUTE 'RESET ROLE';
    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM mcp_reader';
    SELECT md5(p.prosrc) = '@@OLD_MD5@@' AND p.proowner = 'mcp_reader'::regrole::oid AND p.prosecdef AND p.provolatile = 's'
      INTO ok FROM pg_proc p WHERE p.oid = to_regprocedure('public._mcp_r_list_deals_x4263old(text,text,integer,timestamptz,uuid)');
    EXECUTE format('SELECT pg_temp.%I()', fn) INTO v;
    RAISE EXCEPTION USING ERRCODE = 'MX003';
  EXCEPTION
    WHEN SQLSTATE 'MX003' THEN NULL;
    WHEN OTHERS THEN v := 'FAIL: ERR ' || SQLSTATE || ' ' || left(SQLERRM, 300);
  END;
  RETURN CASE WHEN ok THEN v ELSE 'FAIL: old copy not installed; ' || coalesce(v, '') END;
END $h$;

-- on deals the answer shows unchanged, the new body answers exactly what the old body answered, page by page
CREATE FUNCTION pg_temp.c_equal() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE ub uuid := pg_temp.id('B'); st text; q text; lim int; a text; b text; ts timestamptz; id uuid; cur text;
        n_cmp int := 0; n_diff int := 0; n_cur int := 0; n_rows int := 0; first_d text; pg int;
BEGIN
  FOREACH st IN ARRAY ARRAY[NULL, 'active', 'pending', 'closed'] LOOP
    FOREACH q IN ARRAY ARRAY[NULL, 'fixture', 'FIXTURE', 'elm', '98', 'st,', '5 ', '%', '_', '\', '10%', 'under_score', 'back\slash', 'zz none', 'springfield 98', 'lane lane'] LOOP
      FOREACH lim IN ARRAY ARRAY[1, 2, 3, 50] LOOP
        ts := NULL; id := NULL; pg := 0;
        LOOP
          a := pg_temp.rd('_mcp_r_list_deals', ub, st, q, lim, ts, id);
          b := pg_temp.rd('_mcp_r_list_deals_x4263old', ub, st, q, lim, ts, id);
          n_cmp := n_cmp + 1; pg := pg + 1;
          IF a IS DISTINCT FROM b OR a LIKE 'ERR%' THEN
            n_diff := n_diff + 1;
            first_d := coalesce(first_d, format('%s|%s|%s page %s: %s <> %s', st, q, lim, pg, left(a, 150), left(b, 150)));
            EXIT;
          END IF;
          n_rows := n_rows + jsonb_array_length(a::jsonb -> 'deals');
          cur := a::jsonb -> 'page' ->> 'next_cursor';
          EXIT WHEN cur IS NULL OR pg > 20;
          n_cur := n_cur + 1;
          ts := split_part(cur, '|', 1)::timestamptz; id := split_part(cur, '|', 2)::uuid;
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;
  RETURN pg_temp.pass(n_diff = 0 AND n_cmp >= 256 AND n_cur > 30 AND n_rows > 100,
                      format('compared %s pages, %s differ, %s via cursor, %s rows; first_d: %s', n_cmp, n_diff, n_cur, n_rows, coalesce(first_d, '-')))
         || ' [' || n_cmp || ' pages, ' || n_cur || ' via cursor, ' || n_rows || ' rows]';
END $h$;

-- report: for A's deals, every term on which the old and the new body answer differently (not a pass/fail)
CREATE FUNCTION pg_temp.diff_a() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE A uuid := pg_temp.id('A'); t text; o jsonb; n jsonb; out jsonb := '{}'; same int := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY[@@TERMS@@] LOOP
    o := pg_temp.rd('_mcp_r_list_deals_x4263old', A, NULL, t, 50, NULL, NULL)::jsonb;
    n := pg_temp.rd('_mcp_r_list_deals', A, NULL, t, 50, NULL, NULL)::jsonb;
    IF o IS DISTINCT FROM n THEN
      out := out || jsonb_build_object(t, jsonb_build_object(
        'old', pg_temp.names((SELECT coalesce(array_agg((x ->> 'deal_id')::uuid), '{}') FROM jsonb_array_elements(o -> 'deals') x)),
        'new', pg_temp.names((SELECT coalesce(array_agg((x ->> 'deal_id')::uuid), '{}') FROM jsonb_array_elements(n -> 'deals') x))));
    ELSE
      same := same + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('same', same, 'differ', out)::text;
END $h$;

-- timing at 1,000 deals for one owner: the old body and the new body, interleaved, first round discarded
CREATE FUNCTION pg_temp.timing() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE P uuid := pg_temp.id('P'); IP uuid := pg_temp.id('IP'); rep int; t text; f text; t0 timestamptz; ms numeric;
        m jsonb := '{}'; k text; out jsonb := '{}'; arr numeric[]; worst text := repeat('1203 ', 68); w50 numeric;
        a text; b text; fns text[];
BEGIN
  BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.cloud_deals (id, owner_user_id, source_install_id, local_transaction_id, content_hash, detection_status, detection_source,
                                  status, property_address, is_confirmed, last_synced_at)
  SELECT gen_random_uuid(), P, IP, 'pa-t-' || n, encode(sha256(convert_to('pa-t-' || n, 'UTF8')), 'hex'), 'confirmed', 'manual',
         (ARRAY['active', 'pending', 'closed'])[1 + n % 3],
         (100 + n) || ' Fixture ' || initcap(substr(md5('pa-t-' || n), 1, 6)) || ' Street, Springfield, ST 9' || lpad((n % 10000)::text, 4, '0')
           || CASE WHEN n % 10 = 0 THEN ' ref 4111 1111 1111 1111' ELSE '' END,
         true, now() - ((n / 3) * interval '1 second')
    FROM generate_series(1, 1000) n;
  SET LOCAL session_replication_role = origin;
  out := out || jsonb_build_object('rows_by', 'insert');
  EXCEPTION WHEN OTHERS THEN
    SET LOCAL session_replication_role = origin;
    out := out || jsonb_build_object('rows_by', 'cloud_upsert_deal', 'insert_error', left(SQLSTATE || ' ' || SQLERRM, 200));
    FOR rep IN 1 .. 1000 LOOP
      PERFORM pg_temp.deal(P, pg_temp.dp(IP, 'pa-t-' || rep, jsonb_build_object('status', (ARRAY['active', 'pending', 'closed'])[1 + rep % 3],
        'property_address', (100 + rep) || ' Fixture ' || initcap(substr(md5('pa-t-' || rep), 1, 6)) || ' Street, Springfield, ST 9' || lpad(rep::text, 4, '0')
          || CASE WHEN rep % 10 = 0 THEN ' ref 4111 1111 1111 1111' ELSE '' END)));
    END LOOP;
  END;
  out := out || jsonb_build_object('deals', (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = P AND is_confirmed AND removed_at IS NULL));
  FOR rep IN 1 .. 6 LOOP
    FOREACH t IN ARRAY ARRAY['(none)', 'zz-none-zz', 'fixture'] LOOP
      fns := CASE WHEN rep % 2 = 0 THEN ARRAY['_mcp_r_list_deals_x4263old', '_mcp_r_list_deals'] ELSE ARRAY['_mcp_r_list_deals', '_mcp_r_list_deals_x4263old'] END;
      FOREACH f IN ARRAY fns LOOP
        t0 := clock_timestamp();
        a := pg_temp.rd(f, P, NULL, nullif(t, '(none)'), 20, NULL, NULL);
        ms := round(extract(epoch FROM clock_timestamp() - t0) * 1000, 1);
        IF a LIKE 'ERR%' THEN out := out || jsonb_build_object('error_' || f, left(a, 200)); END IF;
        IF rep > 1 THEN
          k := CASE f WHEN '_mcp_r_list_deals' THEN 'new' ELSE 'old' END || ' ' || t;
          m := jsonb_set(m, ARRAY[k], coalesce(m -> k, '[]') || to_jsonb(ms));
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  FOR k IN SELECT jsonb_object_keys(m) LOOP
    SELECT array_agg(x::numeric ORDER BY x::numeric) INTO arr FROM jsonb_array_elements_text(m -> k) x;
    out := out || jsonb_build_object(k, jsonb_build_object('median_ms', arr[3], 'max_ms', arr[5]));
  END LOOP;
  FOREACH t IN ARRAY ARRAY['(none)', 'zz-none-zz', 'fixture'] LOOP
    a := pg_temp.rd('_mcp_r_list_deals', P, NULL, nullif(t, '(none)'), 20, NULL, NULL);
    b := pg_temp.rd('_mcp_r_list_deals_x4263old', P, NULL, nullif(t, '(none)'), 20, NULL, NULL);
    out := out || jsonb_build_object('old_equals_new ' || t, a = b);
  END LOOP;
  out := out || jsonb_build_object('fixture_20_rows', (SELECT jsonb_array_length(pg_temp.rd('_mcp_r_list_deals', P, NULL, 'fixture', 20, NULL, NULL)::jsonb -> 'deals')));
  -- worst case: every address 340 characters of digit groups (the masking loop's most work)
  t0 := clock_timestamp();
  PERFORM count(public._mcp_clean(worst || n, 300)) FROM generate_series(1, 50) n;
  w50 := round(extract(epoch FROM clock_timestamp() - t0) * 1000, 1);
  out := out || jsonb_build_object('worst_50_cleans_ms', w50, 'worst_projected_1000_ms', w50 * 20);
  IF w50 * 20 < 8000 THEN
    UPDATE public.cloud_deals SET property_address = worst || right(md5(id::text), 3) WHERE owner_user_id = P;
    FOREACH f IN ARRAY ARRAY['_mcp_r_list_deals_x4263old', '_mcp_r_list_deals'] LOOP
      t0 := clock_timestamp();
      a := pg_temp.rd(f, P, NULL, 'zz-none-zz', 20, NULL, NULL);
      out := out || jsonb_build_object('worst ' || CASE f WHEN '_mcp_r_list_deals' THEN 'new' ELSE 'old' END || ' zz-none-zz ms',
                                       round(extract(epoch FROM clock_timestamp() - t0) * 1000, 1), 'worst_err_' || f, a LIKE 'ERR%');
    END LOOP;
  END IF;
  RETURN out::text;
END $h$;
