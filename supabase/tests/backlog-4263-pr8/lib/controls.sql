-- BACKLOG-4263 PR-8 harness: controls, loaded AFTER the migration. Each control is a function returning 'PASS' or
-- 'FAIL: ...'; pg_temp.iso runs one and rolls it back, so controls never see each other's writes. Wrapper calls run
-- as the anon role with the claims PostgREST sets (shape 1 unless a control says otherwise).

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

CREATE FUNCTION pg_temp.sw(on_ boolean) RETURNS void LANGUAGE sql AS $h$ UPDATE public.mcp_write_settings SET writes_enabled = on_ WHERE id $h$;
CREATE FUNCTION pg_temp.unrate() RETURNS void LANGUAGE sql AS $h$
  DELETE FROM public.mcp_rate_counters WHERE bucket IN (
    SELECT 'call_conn:' || v FROM pg_temp.p8_fx WHERE k IN ('KA', 'KB', 'KC')
    UNION ALL SELECT 'call_user:' || v FROM pg_temp.p8_fx WHERE k IN ('A', 'B', 'C')
    UNION ALL SELECT 'find_people_user:' || v FROM pg_temp.p8_fx WHERE k IN ('A', 'B', 'C'))
$h$;
CREATE FUNCTION pg_temp.day_count(u uuid) RETURNS integer LANGUAGE sql STABLE AS $h$
  SELECT coalesce((SELECT count FROM public.mcp_rate_counters WHERE bucket = 'find_people_user:' || u::text AND window_start = public._mcp_window(interval '1 day')), 0)
$h$;

-- claims as PostgREST might leave them: 1 = request.jwt.claims only; 2 = all three; 3 = none
CREATE FUNCTION pg_temp.shape(s int) RETURNS void LANGUAGE plpgsql AS $h$
BEGIN
  PERFORM set_config('request.jwt.claims', CASE WHEN s IN (1, 2) THEN '{"role":"anon"}' ELSE '' END, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', CASE WHEN s = 2 THEN 'anon' ELSE '' END, true);
END $h$;
CREATE FUNCTION pg_temp.claims_now() RETURNS jsonb LANGUAGE sql STABLE AS $h$
  SELECT jsonb_build_object('claims', coalesce(current_setting('request.jwt.claims', true), ''),
    'sub', coalesce(current_setting('request.jwt.claim.sub', true), ''), 'role', coalesce(current_setting('request.jwt.claim.role', true), ''),
    'auth_role', auth.role(), 'auth_uid', auth.uid(), 'read_only', current_setting('transaction_read_only'))
$h$;
-- one wrapper call as anon: {res, before, after}
CREATE FUNCTION pg_temp.wp(q text, s int DEFAULT 1) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE r jsonb; b jsonb; a jsonb;
BEGIN
  PERFORM pg_temp.shape(s);
  EXECUTE 'SET LOCAL ROLE anon';
  b := pg_temp.claims_now();
  BEGIN
    EXECUTE q INTO r;
  EXCEPTION WHEN OTHERS THEN r := jsonb_build_object('sqlerr', SQLSTATE, 'msg', left(SQLERRM, 200));
  END;
  a := pg_temp.claims_now();
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.clear_claims();
  RETURN jsonb_build_object('res', r, 'before', b, 'after', a);
END $h$;
CREATE FUNCTION pg_temp.w(q text) RETURNS jsonb LANGUAGE sql AS $h$ SELECT pg_temp.wp(q, 1) -> 'res' $h$;
-- 'ok' or 'E:<error>' or 'X:<anything else>'
CREATE FUNCTION pg_temp.ws(r jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT CASE WHEN r ->> 'ok' = 'true' AND r ? 'result' THEN 'ok' ELSE coalesce('E:' || (r ->> 'error'), 'X:' || coalesce(left(r::text, 300), 'null')) END
$h$;
CREATE FUNCTION pg_temp.q_fp(n int, name text DEFAULT NULL, role text DEFAULT NULL, deal text DEFAULT NULL, email text DEFAULT NULL,
                             phone text DEFAULT NULL, cur text DEFAULT NULL, sec text DEFAULT NULL) RETURNS text LANGUAGE sql STABLE AS $h$
  SELECT format('SELECT public.mcp_find_people(%L, %L::bytea, %L, %L, %L, %L, %L, %L, %L)', coalesce(sec, pg_temp.secret()), pg_temp.dgl(n), pg_temp.res(),
                name, role, deal, email, phone, cur)
$h$;
CREATE FUNCTION pg_temp.q_td(n int, st text DEFAULT NULL, ds text DEFAULT NULL, dfrom text DEFAULT NULL, dto text DEFAULT NULL,
                             nodue boolean DEFAULT NULL, req boolean DEFAULT NULL, cur text DEFAULT NULL, sec text DEFAULT NULL) RETURNS text LANGUAGE sql STABLE AS $h$
  SELECT format('SELECT public.mcp_list_todos(%L, %L::bytea, %L, %L, %L, %L, %L, %L::boolean, %L::boolean, %L)', coalesce(sec, pg_temp.secret()), pg_temp.dgl(n), pg_temp.res(),
                st, ds, dfrom, dto, nodue, req, cur)
$h$;
CREATE FUNCTION pg_temp.q_gd(n int, dl uuid) RETURNS text LANGUAGE sql STABLE AS $h$
  SELECT format('SELECT public.mcp_get_deal(%L, %L::bytea, %L, %L)', pg_temp.secret(), pg_temp.dgl(n), pg_temp.res(), dl)
$h$;
-- person ids of a find_people answer, and of a list_todos answer
CREATE FUNCTION pg_temp.pids(r jsonb) RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(array_agg((x ->> 'person_id')::uuid ORDER BY o), '{}') FROM jsonb_array_elements(r -> 'result' -> 'people') WITH ORDINALITY t(x, o)
$h$;
CREATE FUNCTION pg_temp.tids(r jsonb) RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(array_agg((x ->> 0)::uuid ORDER BY o), '{}') FROM jsonb_array_elements(r -> 'result' -> 'rows') WITH ORDINALITY t(x, o)
$h$;
CREATE FUNCTION pg_temp.ids(VARIADIC ks text[]) RETURNS uuid[] LANGUAGE sql STABLE AS $h$
  SELECT array_agg(pg_temp.id(k) ORDER BY pg_temp.id(k)) FROM unnest(ks) k
$h$;
CREATE FUNCTION pg_temp.sorted(a uuid[]) RETURNS uuid[] LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(array_agg(x ORDER BY x), '{}') FROM unnest(a) x
$h$;
CREATE FUNCTION pg_temp.person(r jsonb, pid uuid) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT x FROM jsonb_array_elements(r -> 'result' -> 'people') x WHERE x ->> 'person_id' = pid::text
$h$;
CREATE FUNCTION pg_temp.logs(conn uuid) RETURNS jsonb LANGUAGE sql STABLE AS $h$
  SELECT coalesce(jsonb_agg(jsonb_build_object('tool', l.tool, 'outcome', l.outcome, 'rows', l.rows_returned) ORDER BY l.id), '[]')
    FROM public.mcp_call_log l WHERE l.connection_id = conn
$h$;
-- every person id of owner B (none may reach A)
CREATE FUNCTION pg_temp.b_people() RETURNS uuid[] LANGUAGE sql STABLE AS $h$
  SELECT array_agg(id) FROM public.cloud_deal_parties WHERE owner_user_id = pg_temp.id('B')
$h$;
-- list_todos reader directly (as the owner's claims): one page after (key, id)
CREATE FUNCTION pg_temp.rtd(u uuid, st text, k date, i uuid) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT pg_temp.j(pg_temp.as_user(u, format('SELECT public._mcp_r_list_todos(%L, NULL, NULL, NULL, NULL, NULL, %L::date, %L::uuid)', st, k, i)))
$h$;
-- every row of list_todos, paging the reader to the end (at most 20 pages)
CREATE FUNCTION pg_temp.walk_td(u uuid, st text) RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE p jsonb; rows jsonb := '[]'; cur text; n int := 0; k date; i uuid;
BEGIN
  LOOP
    p := pg_temp.rtd(u, st, k, i);
    n := n + 1;
    rows := rows || coalesce(p -> 'rows', '[]');
    cur := p -> 'page' ->> 'next_cursor';
    EXIT WHEN cur IS NULL OR n >= 20;
    k := CASE WHEN split_part(cur, '|', 1) = 'none' THEN DATE '9999-12-31' ELSE split_part(cur, '|', 1)::date END;
    i := split_part(cur, '|', 2)::uuid;
  END LOOP;
  RETURN jsonb_build_object('rows', rows, 'pages', n);
END $h$;
-- the items get_deal_checklists returns for every deal of the owner (frame v2 while the switch is on): id -> parts
CREATE FUNCTION pg_temp.cl_items(u uuid, only_open boolean, deals uuid[]) RETURNS jsonb LANGUAGE sql AS $h$
  SELECT coalesce(jsonb_object_agg(x ->> 'item_id', jsonb_build_object('title', x -> 'title', 'required', x -> 'required', 'done', x -> 'done',
                                   'done_at', x -> 'done_at', 'due_date', x -> 'due_date')), '{}')
    FROM unnest(deals) dl,
         LATERAL (SELECT pg_temp.j(pg_temp.as_user(u, format('SELECT public._mcp_r_deal_checklists(%L::uuid, %L::boolean, NULL::uuid)', dl, only_open))) AS r) q,
         jsonb_array_elements(coalesce(q.r -> 'checklists', '[]')) c, jsonb_array_elements(c -> 'items') x
$h$;
CREATE FUNCTION pg_temp.td_items(rows jsonb, deals uuid[]) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(jsonb_object_agg(x ->> 0, jsonb_build_object('title', x -> 1, 'required', x -> 2, 'done', x -> 3, 'done_at', x -> 4, 'due_date', x -> 5)), '{}')
    FROM jsonb_array_elements(rows) x WHERE (x ->> 11)::uuid = ANY (deals)
$h$;

-- ================================================================ find_people
-- answer by name: only A's live people on confirmed, live deals; every field as get_deal shows it
CREATE FUNCTION pg_temp.c_fp_basic() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE r jsonb; g jsonb; pat jsonb; gp jsonb;
BEGIN
  PERFORM pg_temp.unrate();
  r := pg_temp.w(pg_temp.q_fp(1, name => 'pat fixture'));
  g := pg_temp.w(pg_temp.q_gd(1, pg_temp.id('DA1')));
  pat := pg_temp.person(r, pg_temp.id('p_pat'));
  SELECT x INTO gp FROM jsonb_array_elements(g -> 'result' -> 'people') x WHERE x ->> 'person_id' = pg_temp.id('p_pat')::text;
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.ws(r) = 'ok', 'status ' || pg_temp.ws(r)),
    pg_temp.pass(pg_temp.sorted(pg_temp.pids(r)) = pg_temp.ids('p_pat', 'p_pat2', 'p_pat7'), 'ids ' || pg_temp.pids(r)::text),
    pg_temp.pass(r -> 'result' ->> 'kind' = 'keepr.find_people' AND (r -> 'result' -> 'v')::int = 1, 'kind'),
    pg_temp.pass((pat - 'contact_ref' - 'deal_id' - 'address' - 'deal_status' - 'saved_from') = gp, 'person differs from get_deal ' || left(pat::text, 300)),
    pg_temp.pass(pat ->> 'deal_id' = g -> 'result' -> 'deal' ->> 'deal_id' AND pat -> 'address' = g -> 'result' -> 'deal' -> 'address'
                 AND pat -> 'deal_status' = g -> 'result' -> 'deal' -> 'status' AND pat -> 'saved_from' = g -> 'result' -> 'deal' -> 'saved_from', 'deal fields'),
    pg_temp.pass(pg_temp.person(r, pg_temp.id('p_pat2')) ->> 'deal_status' = 'closed', 'closed deal status'),
    pg_temp.pass(r -> 'result' -> 'page' = '{"returned":3,"next_cursor":null}'::jsonb, 'page ' || (r -> 'result' -> 'page')::text),
    pg_temp.pass(pg_temp.logs(pg_temp.id('KA')) @> '[{"tool":"find_people","outcome":"ok","rows":3}]', 'log ' || pg_temp.logs(pg_temp.id('KA'))::text));
END $c$;

-- every person on a deal, found by deal_id, is exactly the person get_deal shows (C1 field parity)
CREATE FUNCTION pg_temp.c_fp_parity() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE dk text; r jsonb; g jsonb; bad text[] := '{}'; n int := 0; x jsonb; y jsonb;
BEGIN
  FOREACH dk IN ARRAY ARRAY['DA1', 'DA2', 'DA7', 'DA9'] LOOP
    PERFORM pg_temp.unrate();
    r := pg_temp.j(pg_temp.as_user(pg_temp.id('A'), format('SELECT public._mcp_r_find_people(NULL, NULL, %L::uuid, NULL, NULL, NULL)', pg_temp.id(dk))));
    g := pg_temp.j(pg_temp.as_user(pg_temp.id('A'), format('SELECT public._mcp_r_get_deal(%L::uuid)', pg_temp.id(dk))));
    FOR y IN SELECT e FROM jsonb_array_elements(g -> 'people') e LOOP
      SELECT e INTO x FROM jsonb_array_elements(r -> 'people') e WHERE e ->> 'person_id' = y ->> 'person_id';
      IF dk = 'DA9' AND x IS NULL THEN CONTINUE; END IF;   -- DA9: the page holds fewer rows (byte cap); compared for those returned
      n := n + 1;
      IF x IS NULL OR (x - 'contact_ref' - 'deal_id' - 'address' - 'deal_status' - 'saved_from') <> y
         OR x -> 'deal_id' <> g -> 'deal' -> 'deal_id' OR x -> 'address' <> g -> 'deal' -> 'address'
         OR x -> 'deal_status' <> g -> 'deal' -> 'status' OR x -> 'saved_from' IS DISTINCT FROM g -> 'deal' -> 'saved_from' THEN
        bad := bad || (dk || ' ' || (y ->> 'person_id'));
      END IF;
      x := NULL;
    END LOOP;
    IF dk <> 'DA9' AND jsonb_array_length(r -> 'people') <> jsonb_array_length(g -> 'people') THEN bad := bad || (dk || ' count'); END IF;
  END LOOP;
  PERFORM pg_temp.rec('obs_parity_people', to_jsonb(n));
  RETURN pg_temp.pass(cardinality(bad) = 0 AND n >= 10, array_to_string(bad, ', ') || ' n=' || n);
END $c$;

-- owner B: no B person reaches A by any criterion; B's deal id is not_found
CREATE FUNCTION pg_temp.c_fp_isolation() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb; r5 jsonb; rb jsonb; bp uuid[] := pg_temp.b_people();
BEGIN
  PERFORM pg_temp.unrate();
  r1 := pg_temp.w(pg_temp.q_fp(1, name => 'pat fixture'));
  r2 := pg_temp.w(pg_temp.q_fp(1, email => 'pat.lender@example.test'));
  r3 := pg_temp.w(pg_temp.q_fp(1, phone => '+12125550101'));
  r4 := pg_temp.w(pg_temp.q_fp(1, role => 'client'));
  r5 := pg_temp.w(pg_temp.q_fp(1, deal => pg_temp.id('DB1')::text));
  rb := pg_temp.w(pg_temp.q_fp(2, name => 'pat fixture'));
  RETURN pg_temp.all_of(
    pg_temp.pass(cardinality(bp) = 2, 'B fixture'),
    pg_temp.pass(pg_temp.ws(r1) = 'ok' AND NOT (pg_temp.pids(r1) && bp), 'name ' || pg_temp.pids(r1)::text),
    pg_temp.pass(pg_temp.ws(r2) = 'ok' AND NOT (pg_temp.pids(r2) && bp) AND cardinality(pg_temp.pids(r2)) = 3, 'email ' || pg_temp.pids(r2)::text),
    pg_temp.pass(pg_temp.ws(r3) = 'ok' AND NOT (pg_temp.pids(r3) && bp) AND cardinality(pg_temp.pids(r3)) = 2, 'phone ' || pg_temp.pids(r3)::text),
    pg_temp.pass(pg_temp.ws(r4) = 'ok' AND pg_temp.pids(r4) = ARRAY[pg_temp.id('p_wh')], 'role ' || pg_temp.pids(r4)::text),
    pg_temp.pass(r5 = '{"ok":false,"error":"not_found"}'::jsonb, 'B deal ' || r5::text),
    pg_temp.pass(pg_temp.ws(rb) = 'ok' AND pg_temp.pids(rb) = ARRAY[pg_temp.id('p_patb')], 'B sees own ' || pg_temp.pids(rb)::text));
END $c$;

-- the same refusal for another owner's deal, an unconfirmed deal, a removed deal and an id that does not exist
CREATE FUNCTION pg_temp.c_fp_not_found() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE a jsonb; b jsonb; c jsonb; d jsonb; nf jsonb := '{"ok":false,"error":"not_found"}';
BEGIN
  PERFORM pg_temp.unrate();
  a := pg_temp.w(pg_temp.q_fp(1, deal => pg_temp.id('DB1')::text));
  b := pg_temp.w(pg_temp.q_fp(1, deal => pg_temp.id('DA4')::text));
  c := pg_temp.w(pg_temp.q_fp(1, deal => upper(pg_temp.id('DA5')::text)));
  d := pg_temp.w(pg_temp.q_fp(1, deal => md5('p8-none')::uuid::text));
  RETURN pg_temp.all_of(pg_temp.pass(a = nf, 'B ' || a::text), pg_temp.pass(b = nf, 'unconfirmed ' || b::text),
                        pg_temp.pass(c = nf, 'removed ' || c::text), pg_temp.pass(d = nf, 'none ' || d::text),
                        pg_temp.pass(pg_temp.logs(pg_temp.id('KA')) @> '[{"tool":"find_people","outcome":"not_found","rows":null}]', 'log'));
END $c$;

-- only people on confirmed, live deals; a removed person never
CREATE FUNCTION pg_temp.c_fp_scope() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE r1 jsonb; r2 jsonb; out_ uuid[] := pg_temp.ids('p_pat4', 'p_pat5', 'p_rm');
BEGIN
  PERFORM pg_temp.unrate();
  r1 := pg_temp.w(pg_temp.q_fp(1, role => 'lender'));
  r2 := pg_temp.w(pg_temp.q_fp(1, deal => pg_temp.id('DA1')::text));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.sorted(pg_temp.pids(r1)) = pg_temp.ids('p_pat', 'p_pat2', 'p_pat7'), 'role ' || pg_temp.pids(r1)::text),
    pg_temp.pass(pg_temp.ws(r2) = 'ok' AND NOT (pg_temp.pids(r2) && out_) AND cardinality(pg_temp.pids(r2)) = 7, 'deal ' || pg_temp.pids(r2)::text));
END $c$;

-- name matching runs on the text the answer shows (masked numbers never match); % and _ are plain characters
CREATE FUNCTION pg_temp.c_fp_clean() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE a jsonb; b jsonb; c jsonb; d jsonb; e jsonb; f jsonb; g jsonb; h jsonb;
BEGIN
  PERFORM pg_temp.unrate();
  a := pg_temp.w(pg_temp.q_fp(1, name => '4111 1111'));
  b := pg_temp.w(pg_temp.q_fp(1, name => '41111111'));
  c := pg_temp.w(pg_temp.q_fp(1, name => 'card'));
  d := pg_temp.w(pg_temp.q_fp(1, name => 'hidden by keepr'));
  e := pg_temp.w(pg_temp.q_fp(1, name => '%_'));
  f := pg_temp.w(pg_temp.q_fp(1, name => 'a_'));
  g := pg_temp.w(pg_temp.q_fp(1, name => '0%'));
  h := pg_temp.w(pg_temp.q_fp(1, name => 'withheld'));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.ws(a) = 'ok' AND cardinality(pg_temp.pids(a)) = 0, 'digits with space ' || pg_temp.pids(a)::text),
    pg_temp.pass(pg_temp.ws(b) = 'ok' AND cardinality(pg_temp.pids(b)) = 0, 'digits ' || pg_temp.pids(b)::text),
    pg_temp.pass(pg_temp.pids(c) = ARRAY[pg_temp.id('p_card')] AND pg_temp.person(c, pg_temp.id('p_card')) ->> 'company' = 'Card [number hidden by Keepr] Ltd', 'card ' || left(c::text, 300)),
    pg_temp.pass(pg_temp.pids(d) = ARRAY[pg_temp.id('p_card')], 'shown text ' || pg_temp.pids(d)::text),
    pg_temp.pass(pg_temp.pids(e) = ARRAY[pg_temp.id('p_pct')], 'percent underscore ' || pg_temp.pids(e)::text),
    pg_temp.pass(pg_temp.ws(f) = 'ok' AND cardinality(pg_temp.pids(f)) = 0, 'a_ ' || pg_temp.pids(f)::text),
    pg_temp.pass(pg_temp.pids(g) = ARRAY[pg_temp.id('p_pct')], '0% ' || pg_temp.pids(g)::text),
    pg_temp.pass(pg_temp.ws(h) = 'ok' AND cardinality(pg_temp.pids(h)) = 0, 'notes not searched ' || pg_temp.pids(h)::text));
END $c$;

-- a withheld person: found by role or deal only, nothing beyond get_deal, contact_ref null, notes cleaned
CREATE FUNCTION pg_temp.c_fp_withheld() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE r jsonb; p jsonb;
BEGIN
  PERFORM pg_temp.unrate();
  r := pg_temp.w(pg_temp.q_fp(1, role => 'CLIENT '));
  p := pg_temp.person(r, pg_temp.id('p_wh'));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.pids(r) = ARRAY[pg_temp.id('p_wh')], 'ids ' || pg_temp.pids(r)::text),
    pg_temp.pass(p -> 'details_withheld' = 'true' AND p -> 'name' = 'null' AND p -> 'company' = 'null' AND p -> 'emails' = '[]' AND p -> 'phones' = '[]', 'fields ' || p::text),
    pg_temp.pass(p -> 'contact_ref' = 'null'::jsonb, 'contact_ref ' || coalesce(p ->> 'contact_ref', 'null')),
    pg_temp.pass(p ->> 'notes' = 'Withheld note [number hidden by Keepr]', 'notes ' || coalesce(p ->> 'notes', 'null')));
END $c$;

-- email: the whole address after trimming, case-insensitive, among the 10 shown; never a part
CREATE FUNCTION pg_temp.c_fp_email() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE a jsonb; b jsonb; c jsonb; d jsonb; e jsonb; f jsonb; g jsonb; h jsonb;
BEGIN
  PERFORM pg_temp.unrate();
  a := pg_temp.w(pg_temp.q_fp(1, email => '  PAT.lender@example.TEST '));
  b := pg_temp.w(pg_temp.q_fp(1, email => 'pat.lender@example'));
  c := pg_temp.w(pg_temp.q_fp(1, email => 'at.lender@example.test'));
  d := pg_temp.w(pg_temp.q_fp(1, email => 'eleventh@example.test'));
  e := pg_temp.w(pg_temp.q_fp(1, email => 'scalar@example.test'));
  f := pg_temp.w(pg_temp.q_fp(1, email => 'm3@example.test'));
  g := pg_temp.w(pg_temp.q_fp(1, email => 'sam@example.test'));
  h := pg_temp.w(pg_temp.q_fp(1, email => 'm1@example.test'));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.sorted(pg_temp.pids(a)) = pg_temp.ids('p_pat', 'p_pat2', 'p_pat7'), 'case and spaces ' || pg_temp.pids(a)::text),
    pg_temp.pass(pg_temp.ws(b) = 'ok' AND cardinality(pg_temp.pids(b)) = 0, 'prefix ' || pg_temp.pids(b)::text),
    pg_temp.pass(pg_temp.ws(c) = 'ok' AND cardinality(pg_temp.pids(c)) = 0, 'suffix ' || pg_temp.pids(c)::text),
    pg_temp.pass(pg_temp.ws(d) = 'ok' AND cardinality(pg_temp.pids(d)) = 0, '11th ' || pg_temp.pids(d)::text),
    pg_temp.pass(pg_temp.ws(e) = 'ok' AND cardinality(pg_temp.pids(e)) = 0, 'not an object ' || pg_temp.pids(e)::text),
    pg_temp.pass(pg_temp.pids(f) = ARRAY[pg_temp.id('p_many')], 'third ' || pg_temp.pids(f)::text),
    pg_temp.pass(pg_temp.pids(g) = ARRAY[pg_temp.id('p_sam')], 'sam ' || pg_temp.pids(g)::text),
    pg_temp.pass(pg_temp.ws(h) = 'ok' AND cardinality(pg_temp.pids(h)) = 0, 'absent ' || pg_temp.pids(h)::text));
END $c$;

-- phone: the full number (digits of e164); 10 digits also read as +1; never trailing digits
CREATE FUNCTION pg_temp.c_fp_phone() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE a jsonb; b jsonb; c jsonb; d jsonb; e jsonb; f jsonb; g jsonb;
BEGIN
  PERFORM pg_temp.unrate();
  a := pg_temp.w(pg_temp.q_fp(1, phone => '+1 (212) 555-0101'));
  b := pg_temp.w(pg_temp.q_fp(1, phone => '2125550101'));
  c := pg_temp.w(pg_temp.q_fp(1, phone => '12125550101'));
  d := pg_temp.w(pg_temp.q_fp(1, phone => '+44 7700 900123'));
  e := pg_temp.w(pg_temp.q_fp(1, phone => '7700900123'));
  f := pg_temp.w(pg_temp.q_fp(1, phone => '+12125550199'));
  g := pg_temp.w(pg_temp.q_fp(1, phone => '+12125550110'));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.sorted(pg_temp.pids(a)) = pg_temp.ids('p_pat', 'p_pat2'), 'formatted ' || pg_temp.pids(a)::text),
    pg_temp.pass(pg_temp.sorted(pg_temp.pids(b)) = pg_temp.ids('p_pat', 'p_pat2'), '10 digits ' || pg_temp.pids(b)::text),
    pg_temp.pass(pg_temp.sorted(pg_temp.pids(c)) = pg_temp.ids('p_pat', 'p_pat2'), '11 digits ' || pg_temp.pids(c)::text),
    pg_temp.pass(pg_temp.pids(d) = ARRAY[pg_temp.id('p_sam')], 'uk ' || pg_temp.pids(d)::text),
    pg_temp.pass(pg_temp.ws(e) = 'ok' AND cardinality(pg_temp.pids(e)) = 0, 'trailing 10 of uk ' || pg_temp.pids(e)::text),
    pg_temp.pass(pg_temp.ws(f) = 'ok' AND cardinality(pg_temp.pids(f)) = 0, '11th ' || pg_temp.pids(f)::text),
    pg_temp.pass(pg_temp.pids(g) = ARRAY[pg_temp.id('p_many')], 'tenth ' || pg_temp.pids(g)::text));
END $c$;

-- role: equal to role, role_category or specific_role, case-insensitive; never a part
CREATE FUNCTION pg_temp.c_fp_role() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE a jsonb; b jsonb; c jsonb; d jsonb;
BEGIN
  PERFORM pg_temp.unrate();
  a := pg_temp.w(pg_temp.q_fp(1, role => 'LENDING'));
  b := pg_temp.w(pg_temp.q_fp(1, role => 'lend'));
  c := pg_temp.w(pg_temp.q_fp(1, role => 'inspection'));
  d := pg_temp.w(pg_temp.q_fp(1, role => 'lender', name => 'nobody'));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.sorted(pg_temp.pids(a)) = pg_temp.ids('p_pat', 'p_pat2', 'p_pat7'), 'category ' || pg_temp.pids(a)::text),
    pg_temp.pass(pg_temp.ws(b) = 'ok' AND cardinality(pg_temp.pids(b)) = 0, 'part ' || pg_temp.pids(b)::text),
    pg_temp.pass(pg_temp.sorted(pg_temp.pids(c)) = pg_temp.ids('p_card', 'p_many'), 'inspection ' || pg_temp.pids(c)::text),
    pg_temp.pass(pg_temp.ws(d) = 'ok' AND cardinality(pg_temp.pids(d)) = 0, 'all criteria must match ' || pg_temp.pids(d)::text));
END $c$;

-- contact_ref: the smallest id of the same contact on the same computer among live people on confirmed, live deals,
-- whatever the filter; the own id without a contact id; another computer is another contact; null when withheld
CREATE FUNCTION pg_temp.c_fp_ref() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE a jsonb; b jsonb; c jsonb; d jsonb; e jsonb; refs text[];
BEGIN
  PERFORM pg_temp.unrate();
  a := pg_temp.w(pg_temp.q_fp(1, name => 'pat fixture'));
  b := pg_temp.w(pg_temp.q_fp(1, deal => pg_temp.id('DA2')::text));
  c := pg_temp.w(pg_temp.q_fp(1, deal => pg_temp.id('DA1')::text));
  d := pg_temp.j(pg_temp.as_user(pg_temp.id('A'), format('SELECT public._mcp_r_find_people(NULL, NULL, %L::uuid, NULL, NULL, NULL)', pg_temp.id('DA8'))));
  SELECT array_agg(DISTINCT x ->> 'contact_ref') INTO refs FROM jsonb_array_elements(d -> 'people') x;
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.person(a, pg_temp.id('p_pat')) ->> 'contact_ref' = pg_temp.small(10)::text, 'pat ' || coalesce(pg_temp.person(a, pg_temp.id('p_pat')) ->> 'contact_ref', 'null')),
    pg_temp.pass(pg_temp.person(a, pg_temp.id('p_pat2')) ->> 'contact_ref' = pg_temp.small(10)::text, 'pat2 by name'),
    pg_temp.pass(pg_temp.person(b, pg_temp.id('p_pat2')) ->> 'contact_ref' = pg_temp.small(10)::text, 'pat2 by deal ' || coalesce(pg_temp.person(b, pg_temp.id('p_pat2')) ->> 'contact_ref', 'null')),
    pg_temp.pass(pg_temp.person(a, pg_temp.id('p_pat7')) ->> 'contact_ref' = pg_temp.id('p_pat7')::text, 'other computer'),
    pg_temp.pass(pg_temp.person(c, pg_temp.id('p_pct')) ->> 'contact_ref' = pg_temp.id('p_pct')::text
                 AND pg_temp.person(c, pg_temp.id('p_nul2')) ->> 'contact_ref' = pg_temp.id('p_nul2')::text, 'no contact id'),
    pg_temp.pass(pg_temp.person(c, pg_temp.id('p_wh')) -> 'contact_ref' = 'null'::jsonb, 'withheld'),
    pg_temp.pass(cardinality(refs) = 100, 'DA8 page refs ' || cardinality(refs)));
END $c$;

-- input rules: each refused before any read, logged invalid_input, and not counted against the day cap
CREATE FUNCTION pg_temp.c_fp_input() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE q text; bad text[] := '{}'; r jsonb; n int := 0; d0 int; ok1 jsonb; ok2 jsonb;
BEGIN
  PERFORM pg_temp.unrate();
  d0 := pg_temp.day_count(pg_temp.id('A'));
  FOREACH q IN ARRAY ARRAY[
      pg_temp.q_fp(1, name => 'a'), pg_temp.q_fp(1, name => '   '), pg_temp.q_fp(1, name => ' a '), pg_temp.q_fp(1, name => ''),
      pg_temp.q_fp(1, name => repeat('x', 101)), pg_temp.q_fp(1, name => E'a​'),
      pg_temp.q_fp(1, role => 'x'), pg_temp.q_fp(1, role => repeat('r', 41)),
      pg_temp.q_fp(1, email => 'example.test'), pg_temp.q_fp(1, email => 'a@b@c'), pg_temp.q_fp(1, email => 'a b@c'),
      pg_temp.q_fp(1, email => repeat('a', 320) || '@b'),
      pg_temp.q_fp(1, phone => '212555010'), pg_temp.q_fp(1, phone => '1234567890123456'), pg_temp.q_fp(1, phone => '212-abc-0101x'),
      pg_temp.q_fp(1, phone => repeat(' ', 30) || '2125550101' || repeat(' ', 10)),
      pg_temp.q_fp(1, deal => 'nope'), pg_temp.q_fp(1, cur => 'nope', name => 'pat'), pg_temp.q_fp(1, cur => upper(md5('x')::uuid::text), name => 'pat'),
      pg_temp.q_fp(1)] LOOP
    PERFORM pg_temp.unrate_minute();
    r := pg_temp.w(q); n := n + 1;
    IF r IS DISTINCT FROM '{"ok":false,"error":"invalid_input"}'::jsonb THEN bad := bad || (left(q, 160) || ' -> ' || coalesce(r::text, 'null')); END IF;
  END LOOP;
  ok1 := pg_temp.w(pg_temp.q_fp(1, name => 'ab'));
  ok2 := pg_temp.w(pg_temp.q_fp(1, name => ' pat fixture ', deal => upper(pg_temp.id('DA1')::text)));
  RETURN pg_temp.all_of(
    pg_temp.pass(cardinality(bad) = 0 AND n = 20, array_to_string(bad, ' || ') || ' n=' || n),
    pg_temp.pass(pg_temp.day_count(pg_temp.id('A')) - d0 = 2, 'day counter moved by ' || (pg_temp.day_count(pg_temp.id('A')) - d0)),
    pg_temp.pass(pg_temp.ws(ok1) = 'ok', 'two characters ' || pg_temp.ws(ok1)),
    pg_temp.pass(pg_temp.pids(ok2) = ARRAY[pg_temp.id('p_pat')], 'trimmed name, upper-case deal id ' || pg_temp.pids(ok2)::text),
    pg_temp.pass((SELECT count(*) FROM public.mcp_call_log WHERE connection_id = pg_temp.id('KA') AND tool = 'find_people' AND outcome = 'invalid_input') = 20, 'logged'));
END $c$;

-- the day cap: 1000 calls per user per UTC day; call 1001 is refused and counted; refused calls keep counting
CREATE FUNCTION pg_temp.c_fp_day() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); r1 jsonb; r2 jsonb; r3 jsonb; c1 int; c2 int; c3 int; f jsonb; f1 int;
BEGIN
  PERFORM pg_temp.unrate();
  f := pg_temp.w(pg_temp.q_fp(1, name => 'pat'));
  f1 := pg_temp.day_count(A);
  INSERT INTO public.mcp_rate_counters (bucket, window_start, count) VALUES ('find_people_user:' || A::text, public._mcp_window(interval '1 day'), 999)
  ON CONFLICT (bucket, window_start) DO UPDATE SET count = 999;
  PERFORM pg_temp.unrate_minute();
  r1 := pg_temp.w(pg_temp.q_fp(1, name => 'pat')); c1 := pg_temp.day_count(A);
  r2 := pg_temp.w(pg_temp.q_fp(1, name => 'pat')); c2 := pg_temp.day_count(A);
  r3 := pg_temp.w(pg_temp.q_fp(1, name => 'pat')); c3 := pg_temp.day_count(A);
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.ws(f) = 'ok' AND f1 = 1, 'first call counted ' || f1),
    pg_temp.pass(pg_temp.ws(r1) = 'ok' AND c1 = 1000, 'call 1000 ' || pg_temp.ws(r1) || ' ' || c1),
    pg_temp.pass(r2 = '{"ok":false,"error":"day_limit"}'::jsonb AND c2 = 1001, 'call 1001 ' || coalesce(r2::text, 'null') || ' ' || c2),
    pg_temp.pass(r3 = '{"ok":false,"error":"day_limit"}'::jsonb AND c3 = 1002, 'call 1002 ' || coalesce(r3::text, 'null') || ' ' || c3),
    pg_temp.pass(pg_temp.logs(pg_temp.id('KA')) @> '[{"tool":"find_people","outcome":"rate_limited","rows":0}]'
                 AND (SELECT count(*) FROM public.mcp_call_log WHERE connection_id = pg_temp.id('KA') AND outcome = 'rate_limited') = 2, 'log ' || pg_temp.logs(pg_temp.id('KA'))::text),
    pg_temp.pass(pg_temp.ws(pg_temp.w(pg_temp.q_td(1))) = 'ok', 'list_todos is not capped by it'));
END $c$;
CREATE FUNCTION pg_temp.unrate_minute() RETURNS void LANGUAGE sql AS $h$
  DELETE FROM public.mcp_rate_counters WHERE bucket IN (
    SELECT 'call_conn:' || v FROM pg_temp.p8_fx WHERE k IN ('KA', 'KB', 'KC')
    UNION ALL SELECT 'call_user:' || v FROM pg_temp.p8_fx WHERE k IN ('A', 'B', 'C'))
$h$;

-- pages: at most 100 people; next_cursor walks every person once, in person_id order
CREATE FUNCTION pg_temp.c_fp_page() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE p1 jsonb; p2 jsonb; all_ uuid[];
BEGIN
  PERFORM pg_temp.unrate();
  p1 := pg_temp.w(pg_temp.q_fp(1, role => 'transaction_coordinator', deal => pg_temp.id('DA8')::text));
  p2 := pg_temp.w(pg_temp.q_fp(1, role => 'transaction_coordinator', deal => pg_temp.id('DA8')::text, cur => p1 -> 'result' -> 'page' ->> 'next_cursor'));
  all_ := pg_temp.pids(p1) || pg_temp.pids(p2);
  RETURN pg_temp.all_of(
    pg_temp.pass(cardinality(pg_temp.pids(p1)) = 100 AND (p1 -> 'result' -> 'page' ->> 'returned')::int = 100, 'page 1 ' || cardinality(pg_temp.pids(p1))),
    pg_temp.pass(p1 -> 'result' -> 'page' ->> 'next_cursor' = (pg_temp.pids(p1))[100]::text, 'cursor = last id'),
    pg_temp.pass(cardinality(pg_temp.pids(p2)) = 30 AND p2 -> 'result' -> 'page' -> 'next_cursor' = 'null'::jsonb, 'page 2 ' || cardinality(pg_temp.pids(p2))),
    pg_temp.pass((SELECT count(DISTINCT x) FROM unnest(all_) x) = 130 AND all_ = pg_temp.sorted(all_), 'each once, in order'),
    pg_temp.pass(octet_length(p1::text) < 90000, 'page bytes ' || octet_length(p1::text)));
END $c$;

-- the longest rows: the first always fits, the page stops at 60000 bytes, the frame stays under 90000
CREATE FUNCTION pg_temp.c_fp_rowmax() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE r jsonb; rows int; one int;
BEGIN
  PERFORM pg_temp.unrate();
  r := pg_temp.w(pg_temp.q_fp(1, deal => pg_temp.id('DA9')::text));
  rows := jsonb_array_length(r -> 'result' -> 'people');
  SELECT max(octet_length(x::text)) INTO one FROM jsonb_array_elements(r -> 'result' -> 'people') x;
  PERFORM pg_temp.rec('obs_fp_rowmax', jsonb_build_object('rows', rows, 'row_bytes', one, 'frame_bytes', octet_length((r -> 'result')::text)));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.ws(r) = 'ok', 'status ' || pg_temp.ws(r)),
    pg_temp.pass(rows BETWEEN 1 AND 2 AND r -> 'result' -> 'page' ->> 'next_cursor' IS NOT NULL, 'rows ' || rows),
    pg_temp.pass(octet_length((r -> 'result')::text) < 90000 AND one > 20000, 'bytes ' || octet_length((r -> 'result')::text) || ' row ' || one));
END $c$;

-- not entitled
CREATE FUNCTION pg_temp.c_fp_entitled() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE r jsonb; t jsonb;
BEGIN
  PERFORM pg_temp.unrate();
  r := pg_temp.w(pg_temp.q_fp(3, name => 'pat'));
  t := pg_temp.w(pg_temp.q_td(3));
  RETURN pg_temp.all_of(pg_temp.pass(r = '{"ok":false,"error":"not_entitled"}'::jsonb, 'fp ' || coalesce(r::text, 'null')),
                        pg_temp.pass(t = '{"ok":false,"error":"not_entitled"}'::jsonb, 'td ' || coalesce(t::text, 'null')));
END $c$;

-- the portal secret is checked first: a wrong secret writes no log row and no counter
CREATE FUNCTION pg_temp.c_secret() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE l0 bigint := (SELECT count(*) FROM public.mcp_call_log); c0 bigint := (SELECT count(*) FROM public.mcp_rate_counters); a jsonb; b jsonb; d jsonb;
BEGIN
  a := pg_temp.w(pg_temp.q_fp(1, name => 'pat', sec => 'wrong-secret'));
  b := pg_temp.w(pg_temp.q_td(1, sec => 'wrong-secret'));
  d := pg_temp.w(format('SELECT public.mcp_find_people(NULL, %L::bytea, %L, %L, NULL, NULL, NULL, NULL, NULL)', pg_temp.dgl(1), pg_temp.res(), 'pat'));
  RETURN pg_temp.all_of(
    pg_temp.pass(a = '{"ok":false,"error":"not_connected"}'::jsonb, 'fp ' || coalesce(a::text, 'null')),
    pg_temp.pass(b = '{"ok":false,"error":"not_connected"}'::jsonb, 'td ' || coalesce(b::text, 'null')),
    pg_temp.pass(d = '{"ok":false,"error":"not_connected"}'::jsonb, 'null secret ' || coalesce(d::text, 'null')),
    pg_temp.pass((SELECT count(*) FROM public.mcp_call_log) = l0 AND (SELECT count(*) FROM public.mcp_rate_counters) = c0, 'nothing written'));
END $c$;

-- ================================================================ list_todos
-- parity with get_deal_checklists: the same todos with the same values on every deal it can show; the 31st list too
CREATE FUNCTION pg_temp.c_td_parity() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); deals uuid[]; wa jsonb; wo jsonb; ca jsonb; co jsonb; ta jsonb; tok jsonb; dt jsonb;
BEGIN
  PERFORM pg_temp.sw(true);
  deals := ARRAY[pg_temp.id('DA1'), pg_temp.id('DA2'), pg_temp.id('DA3'), pg_temp.id('DA4'), pg_temp.id('DA5'), pg_temp.id('DP'), pg_temp.id('DW'), pg_temp.id('DA7')];
  wa := pg_temp.walk_td(A, 'all');
  wo := pg_temp.walk_td(A, 'open');
  ca := pg_temp.cl_items(A, false, deals);
  co := pg_temp.cl_items(A, true, deals);
  ta := pg_temp.td_items(wa -> 'rows', deals);
  tok := pg_temp.td_items(wo -> 'rows', deals);
  dt := pg_temp.cl_items(A, false, ARRAY[pg_temp.id('DT')]);
  PERFORM pg_temp.rec('obs_td_parity', jsonb_build_object('all', (SELECT count(*) FROM jsonb_object_keys(ca)), 'open', (SELECT count(*) FROM jsonb_object_keys(co)),
                      'pages_all', wa -> 'pages', 'rows_all', jsonb_array_length(wa -> 'rows')));
  RETURN pg_temp.all_of(
    pg_temp.pass(ta = ca, 'all differs: only in list_todos ' || (SELECT coalesce(string_agg(k, ','), '-') FROM jsonb_object_keys(ta) k WHERE NOT ca ? k)
                 || ' only in checklists ' || (SELECT coalesce(string_agg(k, ','), '-') FROM jsonb_object_keys(ca) k WHERE NOT ta ? k)),
    pg_temp.pass(tok = co, 'open differs'),
    pg_temp.pass((SELECT count(*) FROM jsonb_object_keys(ca)) >= 130 AND ca ? pg_temp.id('t7')::text AND co ? pg_temp.id('t7')::text
                 AND ca ? pg_temp.id('l1')::text AND ca ? pg_temp.id('m1')::text AND NOT ca ? pg_temp.id('t4')::text AND NOT ca ? pg_temp.id('o1')::text
                 AND NOT ca ? pg_temp.id('n1')::text AND NOT ca ? pg_temp.id('r5')::text AND NOT co ? pg_temp.id('t5')::text, 'fixture classes'),
    pg_temp.pass(EXISTS (SELECT 1 FROM jsonb_array_elements(wa -> 'rows') x WHERE x ->> 0 = pg_temp.id('kt31')::text) AND NOT dt ? pg_temp.id('kt31')::text
                 AND (SELECT count(*) FROM jsonb_array_elements(wa -> 'rows') x WHERE (x ->> 11)::uuid = pg_temp.id('DT')) = 31, '31st list'));
END $c$;

-- the columns as built: due dates shown while the write switch is off; has_note, my_items, private, locked, saved_from
CREATE FUNCTION pg_temp.c_td_columns() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE r jsonb; t1 jsonb; m1 jsonb; l1 jsonb; c1 jsonb;
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(false);
  r := pg_temp.w(pg_temp.q_td(1, st => 'all'));
  SELECT x INTO t1 FROM jsonb_array_elements(r -> 'result' -> 'rows') x WHERE x ->> 0 = pg_temp.id('t1')::text;
  SELECT x INTO m1 FROM jsonb_array_elements(r -> 'result' -> 'rows') x WHERE x ->> 0 = pg_temp.id('m1')::text;
  SELECT x INTO l1 FROM jsonb_array_elements(r -> 'result' -> 'rows') x WHERE x ->> 0 = pg_temp.id('l1')::text;
  SELECT x INTO c1 FROM jsonb_array_elements(r -> 'result' -> 'rows') x WHERE x ->> 0 = pg_temp.id('c1')::text;
  RETURN pg_temp.all_of(
    pg_temp.pass(public._mcp_writes_on() IS FALSE AND pg_temp.ws(r) = 'ok', 'switch off'),
    pg_temp.pass(r -> 'result' -> 'columns' = '["item_id","title","required","done","done_at","due_date","has_note","checklist_id","checklist_name","my_items","private","deal_id","address","deal_status","locked","saved_from"]'::jsonb, 'columns'),
    pg_temp.pass(t1 ->> 5 = '2026-12-05' AND t1 -> 2 = 'true' AND t1 -> 6 = 'false' AND t1 -> 9 = 'false' AND t1 -> 10 = 'false' AND t1 ->> 8 = 'Purchase', 't1 ' || coalesce(t1::text, 'null')),
    pg_temp.pass(m1 -> 5 = 'null' AND m1 -> 6 = 'true' AND m1 -> 9 = 'true' AND m1 -> 10 = 'true', 'm1 ' || coalesce(m1::text, 'null')),
    pg_temp.pass(l1 ->> 14 = 'submitted' AND jsonb_typeof(l1 -> 15) = 'number', 'l1 ' || coalesce(l1::text, 'null')),
    pg_temp.pass(c1 ->> 13 = 'closed', 'c1 ' || coalesce(c1::text, 'null')),
    pg_temp.pass(pg_temp.logs(pg_temp.id('KA')) @> '[{"tool":"list_todos","outcome":"ok"}]', 'log'));
END $c$;

-- filters and the refusals of the arguments
CREATE FUNCTION pg_temp.c_td_filters() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE dflt jsonb; dn jsonb; rq jsonb; cl jsonb; rg jsonb; nd jsonb; wd jsonb; q text; bad text[] := '{}'; r jsonb; n int := 0; ok1 jsonb;
BEGIN
  PERFORM pg_temp.unrate();
  dflt := pg_temp.w(pg_temp.q_td(1));
  dn := pg_temp.w(pg_temp.q_td(1, st => 'done'));
  rq := pg_temp.w(pg_temp.q_td(1, st => 'all', req => true));
  cl := pg_temp.w(pg_temp.q_td(1, st => 'all', ds => 'closed'));
  rg := pg_temp.w(pg_temp.q_td(1, st => 'all', dfrom => '2026-12-01', dto => '2026-12-05'));
  nd := pg_temp.w(pg_temp.q_td(1, st => 'all', nodue => true));
  PERFORM pg_temp.unrate();
  wd := pg_temp.w(pg_temp.q_td(1, st => 'all', nodue => false));
  ok1 := pg_temp.w(pg_temp.q_td(1, cur => 'none|' || md5('x')::uuid::text));
  FOREACH q IN ARRAY ARRAY[
      pg_temp.q_td(1, st => 'x'), pg_temp.q_td(1, ds => 'rejected'), pg_temp.q_td(1, dfrom => '2026-02-30'), pg_temp.q_td(1, dfrom => '2026-1-1'),
      pg_temp.q_td(1, dfrom => '1999-12-31'), pg_temp.q_td(1, dto => '2101-01-01'), pg_temp.q_td(1, dfrom => '2026-12-05', dto => '2026-12-01'),
      pg_temp.q_td(1, dfrom => '2026-12-01', nodue => true), pg_temp.q_td(1, cur => '9999-12-31|' || md5('x')::uuid::text),
      pg_temp.q_td(1, cur => '2026-12-05|nope'), pg_temp.q_td(1, cur => md5('x')::uuid::text), pg_temp.q_td(1, cur => '1999-12-31|' || md5('x')::uuid::text)] LOOP
    PERFORM pg_temp.unrate();
    r := pg_temp.w(q); n := n + 1;
    IF r IS DISTINCT FROM '{"ok":false,"error":"invalid_input"}'::jsonb THEN bad := bad || (left(q, 200) || ' -> ' || coalesce(r::text, 'null')); END IF;
  END LOOP;
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.ws(dflt) = 'ok' AND jsonb_array_length(dflt -> 'result' -> 'rows') > 0 AND (SELECT bool_and(x -> 3 IS DISTINCT FROM 'true'::jsonb) FROM jsonb_array_elements(dflt -> 'result' -> 'rows') x), 'default open'),
    pg_temp.pass(pg_temp.tids(dn) = ARRAY[pg_temp.id('t5')], 'done ' || pg_temp.tids(dn)::text),
    pg_temp.pass((SELECT bool_and(x -> 2 = 'true') FROM jsonb_array_elements(rq -> 'result' -> 'rows') x) AND pg_temp.id('t1') = ANY (pg_temp.tids(rq))
                 AND pg_temp.id('t6') = ANY (pg_temp.tids(rq)), 'required'),
    pg_temp.pass(pg_temp.tids(cl) = ARRAY[pg_temp.id('c1')], 'closed deals ' || pg_temp.tids(cl)::text),
    pg_temp.pass(pg_temp.sorted(pg_temp.tids(rg)) = pg_temp.ids('t1', 't2', 'm2', 'l1'), 'range inclusive ' || pg_temp.tids(rg)::text),
    pg_temp.pass(jsonb_array_length(nd -> 'result' -> 'rows') > 0 AND (SELECT bool_and(x -> 5 = 'null') FROM jsonb_array_elements(nd -> 'result' -> 'rows') x), 'without due date'),
    pg_temp.pass(jsonb_array_length(wd -> 'result' -> 'rows') > 0 AND (SELECT bool_and(x -> 5 <> 'null') FROM jsonb_array_elements(wd -> 'result' -> 'rows') x), 'with a due date'),
    pg_temp.pass(pg_temp.ws(ok1) = 'ok', 'none cursor ' || pg_temp.ws(ok1)),
    pg_temp.pass(cardinality(bad) = 0 AND n = 12, array_to_string(bad, ' || ') || ' n=' || n));
END $c$;

-- pages: every todo once, in (due date, todos without one last, id) order; the cursor crosses from dated to undated
CREATE FUNCTION pg_temp.c_td_page() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE A uuid := pg_temp.id('A'); p jsonb; rows jsonb := '[]'; cur text; n int := 0; maxb int := 0; lastd jsonb; nxt jsonb; ordered boolean; total bigint;
BEGIN
  LOOP
    PERFORM pg_temp.unrate();
    p := pg_temp.w(pg_temp.q_td(1, st => 'all', cur => cur));
    n := n + 1;
    EXIT WHEN pg_temp.ws(p) <> 'ok';
    maxb := greatest(maxb, octet_length((p -> 'result')::text));
    rows := rows || (p -> 'result' -> 'rows');
    cur := p -> 'result' -> 'page' ->> 'next_cursor';
    EXIT WHEN cur IS NULL OR n >= 20;
  END LOOP;
  SELECT bool_and(coalesce(prev_k, DATE '0001-01-01') < k OR (prev_k = k AND prev_i < i)) INTO ordered FROM (
    SELECT k, i, lag(k) OVER (ORDER BY o) AS prev_k, lag(i) OVER (ORDER BY o) AS prev_i FROM (
      SELECT coalesce((x ->> 5)::date, DATE '9999-12-31') AS k, (x ->> 0)::uuid AS i, o FROM jsonb_array_elements(rows) WITH ORDINALITY t(x, o)) a) b;
  SELECT count(*) INTO total FROM public.cloud_deal_checklist_items t JOIN public.cloud_deal_checklists c ON c.id = t.cloud_checklist_id
    JOIN public.cloud_deals d ON d.id = t.cloud_deal_id
   WHERE t.owner_user_id = A AND t.removed_at IS NULL AND c.removed_at IS NULL AND d.is_confirmed AND d.removed_at IS NULL;
  SELECT x INTO lastd FROM jsonb_array_elements(rows) WITH ORDINALITY t(x, o) WHERE x -> 5 <> 'null' ORDER BY o DESC LIMIT 1;
  nxt := pg_temp.rtd(A, 'all', (lastd ->> 5)::date, (lastd ->> 0)::uuid);
  PERFORM pg_temp.rec('obs_td_page', jsonb_build_object('pages', n, 'rows', jsonb_array_length(rows), 'max_frame_bytes', maxb, 'total', total));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.ws(p) = 'ok' AND n >= 3, 'pages ' || n || ' ' || pg_temp.ws(p)),
    pg_temp.pass(jsonb_array_length(rows) = total AND (SELECT count(DISTINCT x ->> 0) FROM jsonb_array_elements(rows) x) = total, 'rows ' || jsonb_array_length(rows) || ' of ' || total),
    pg_temp.pass(ordered, 'order'),
    pg_temp.pass(maxb < 90000, 'bytes ' || maxb),
    pg_temp.pass(nxt -> 'rows' -> 0 -> 5 = 'null'::jsonb AND (SELECT min((x ->> 0)::uuid) FROM jsonb_array_elements(rows) x WHERE x -> 5 = 'null') = (nxt -> 'rows' -> 0 ->> 0)::uuid,
                 'after the last dated todo comes the first undated one'));
END $c$;

-- the longest todo row fits; a page stays under 90000 bytes
CREATE FUNCTION pg_temp.c_td_rowmax() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE r jsonb; w jsonb;
BEGIN
  PERFORM pg_temp.unrate();
  r := pg_temp.w(pg_temp.q_td(1, st => 'all', dfrom => '2026-12-31', dto => '2026-12-31'));
  SELECT x INTO w FROM jsonb_array_elements(r -> 'result' -> 'rows') x WHERE x ->> 0 = pg_temp.id('w1')::text;
  PERFORM pg_temp.rec('obs_td_rowmax', jsonb_build_object('row_bytes', octet_length(w::text)));
  RETURN pg_temp.all_of(pg_temp.pass(w IS NOT NULL AND octet_length(w::text) BETWEEN 2000 AND 10000, 'row ' || coalesce(octet_length(w::text), -1)),
                        pg_temp.pass(char_length(w ->> 1) = 300 AND w ->> 8 LIKE '%…' AND char_length(w ->> 8) = 200 AND w ->> 12 LIKE '%…' AND char_length(w ->> 12) = 300, 'cut'));
END $c$;

-- owner B: no B todo reaches A; B sees exactly its own
CREATE FUNCTION pg_temp.c_td_isolation() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE a jsonb; b jsonb; brows uuid[];
BEGIN
  PERFORM pg_temp.unrate();
  SELECT array_agg(id) INTO brows FROM public.cloud_deal_checklist_items WHERE owner_user_id = pg_temp.id('B');
  a := pg_temp.w(pg_temp.q_td(1, st => 'all', dfrom => '2026-12-05', dto => '2026-12-05'));
  b := pg_temp.w(pg_temp.q_td(2, st => 'all'));
  RETURN pg_temp.all_of(pg_temp.pass(pg_temp.ws(a) = 'ok' AND cardinality(pg_temp.tids(a)) >= 3 AND NOT (pg_temp.tids(a) && brows), 'A ' || pg_temp.tids(a)::text),
                        pg_temp.pass(pg_temp.tids(b) = ARRAY[pg_temp.id('b1')], 'B ' || pg_temp.tids(b)::text));
END $c$;

-- ================================================================ both tools
-- the caller's claims are as they came on every path, from every start shape; read-only is off again
CREATE FUNCTION pg_temp.c_claims() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE s int; q text; p jsonb; bad text[] := '{}'; n int := 0;
BEGIN
  FOREACH s IN ARRAY ARRAY[1, 2, 3] LOOP
    PERFORM pg_temp.unrate();
    FOREACH q IN ARRAY ARRAY[
        pg_temp.q_fp(1, name => 'pat'), pg_temp.q_fp(1, name => 'a'), pg_temp.q_fp(1, deal => pg_temp.id('DB1')::text), pg_temp.q_fp(3, name => 'pat'),
        pg_temp.q_td(1), pg_temp.q_td(1, st => 'x'), pg_temp.q_td(3)] LOOP
      p := pg_temp.wp(q, s); n := n + 1;
      IF p -> 'before' IS DISTINCT FROM p -> 'after' OR p -> 'res' ? 'sqlerr' OR (s IN (1, 2) AND p -> 'after' ->> 'auth_role' IS DISTINCT FROM 'anon')
         OR p -> 'after' -> 'auth_uid' <> 'null'::jsonb OR p -> 'after' ->> 'read_only' <> 'off' THEN
        bad := bad || ('shape ' || s || ' ' || left(q, 60) || ' -> ' || p::text);
      END IF;
    END LOOP;
  END LOOP;
  RETURN pg_temp.pass(cardinality(bad) = 0 AND n = 21, coalesce(array_to_string(bad, ' || '), '') || ' n=' || n);
END $c$;

-- catalogue: the anon list is exactly 17; the four new functions as stated; no other function changed; the CHECKs
CREATE FUNCTION pg_temp.c_catalog() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE anon_list text[]; probs jsonb; changed bigint; added text[]; tool_names text[]; outcome_def text;
BEGIN
  SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text COLLATE "C") INTO anon_list FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_' AND has_function_privilege('anon', p.oid, 'EXECUTE');
  SELECT coalesce(jsonb_object_agg(x.sig, x.problem), '{}') INTO probs FROM (
    SELECT s.sig, CASE WHEN p.oid IS NULL THEN 'missing'
                       WHEN array_to_string(p.proconfig, ',') IS DISTINCT FROM 'search_path=""' THEN 'search_path'
                       WHEN NOT p.prosecdef THEN 'not definer'
                       WHEN s.kind = 'anon' AND (p.proowner <> 'postgres'::regrole::oid OR p.provolatile <> 'v' OR NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                                                 OR has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE')) THEN 'anon grants'
                       WHEN s.kind = 'reader' AND (p.proowner <> 'mcp_reader'::regrole::oid OR p.provolatile <> 's' OR has_function_privilege('anon', p.oid, 'EXECUTE')
                                                   OR has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE')
                                                   OR NOT has_function_privilege('postgres', p.oid, 'EXECUTE') OR NOT public._mcp_reader_ok(p.oid::regprocedure)) THEN 'reader grants'
                       WHEN coalesce(p.proacl::text ~ '(^|[{,])=X', p.proacl IS NULL) THEN 'PUBLIC execute' END AS problem
      FROM (VALUES ('public.mcp_find_people(text,bytea,text,text,text,text,text,text,text)', 'anon'),
                   ('public.mcp_list_todos(text,bytea,text,text,text,text,text,boolean,boolean,text)', 'anon'),
                   ('public._mcp_r_find_people(text,text,uuid,text,text,uuid)', 'reader'),
                   ('public._mcp_r_list_todos(text,text,date,date,boolean,boolean,date,uuid)', 'reader')) s(sig, kind)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(s.sig)) x WHERE x.problem IS NOT NULL;
  SELECT count(*) INTO changed FROM pg_temp.p4263p8_fn_before b
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.oid::regprocedure::text = b.sig
                       AND md5(p.prosrc) = b.src_md5 AND p.proacl::text IS NOT DISTINCT FROM b.acl AND p.proconfig IS NOT DISTINCT FROM b.config
                       AND p.prosecdef = b.secdef AND p.proowner = b.owner AND p.provolatile = b.vol);
  SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text COLLATE "C") INTO added FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND NOT EXISTS (SELECT 1 FROM pg_temp.p4263p8_fn_before b WHERE b.sig = p.oid::regprocedure::text);
  SELECT array_agg(m[1] ORDER BY m[1] COLLATE "C") INTO tool_names FROM pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') m
   WHERE c.conrelid = 'public.mcp_call_log'::regclass AND c.conname = 'mcp_call_log_tool_check';
  SELECT pg_get_constraintdef(c.oid) INTO outcome_def FROM pg_constraint c WHERE c.conrelid = 'public.mcp_call_log'::regclass AND c.conname = 'mcp_call_log_outcome_check';
  RETURN pg_temp.all_of(
    pg_temp.pass(anon_list = (SELECT array_agg(x ORDER BY x COLLATE "C") FROM unnest(ARRAY[@@ANON_ALL@@]::text[]) x), 'anon list ' || anon_list::text),
    pg_temp.pass(probs = '{}'::jsonb, 'attributes ' || probs::text),
    pg_temp.pass(changed = 0, 'existing functions changed: ' || changed),
    pg_temp.pass(added = ARRAY['_mcp_r_find_people(text,text,uuid,text,text,uuid)', '_mcp_r_list_todos(text,text,date,date,boolean,boolean,date,uuid)',
                               'mcp_find_people(text,bytea,text,text,text,text,text,text,text)', 'mcp_list_todos(text,bytea,text,text,text,text,text,boolean,boolean,text)'],
                 'added ' || coalesce(added::text, 'none')),
    pg_temp.pass(tool_names = ARRAY['add_todo', 'find_people', 'get_deal', 'get_deal_checklists', 'get_status', 'list_all_deals', 'list_deals', 'list_todos',
                                    'remove_todo', 'restore_todo', 'update_todo'], 'tool check ' || coalesce(tool_names::text, 'none')),
    pg_temp.pass(outcome_def = (SELECT def FROM pg_temp.p4263p8_check_before WHERE name = 'mcp_call_log_outcome_check'), 'outcome check'),
    pg_temp.pass((SELECT count(*) FROM pg_constraint c WHERE c.conrelid = 'public.mcp_call_log'::regclass AND c.contype = 'c') =
                 (SELECT count(*) FROM pg_temp.p4263p8_check_before), 'check count'),
    pg_temp.pass(NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proowner = 'mcp_reader'::regrole::oid AND p.prosrc ~ 'public\.cloud_deals\M'
                             AND p.prosrc !~ 'removed_at IS NULL'), 'reader removed filter'),
    pg_temp.pass(NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN (to_regprocedure('public._mcp_r_find_people(text,text,uuid,text,text,uuid)'),
                                                                     to_regprocedure('public._mcp_r_list_todos(text,text,date,date,boolean,boolean,date,uuid)'))
                             AND p.prosrc ~ '\m(INSERT|UPDATE|DELETE|EXECUTE|LIKE|ILIKE|SIMILAR)\M'), 'readers: no write, no dynamic SQL, no pattern from input'));
END $c$;
