-- BACKLOG-4263 PR-11a harness: controls, loaded AFTER the migration. Each returns 'PASS ...' or 'FAIL: ...';
-- pg_temp.iso runs one and rolls its writes back, so controls never see each other's writes.

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
CREATE FUNCTION pg_temp.done_v() RETURNS jsonb LANGUAGE sql STABLE AS $h$ SELECT jsonb_build_object('is_checked', true, 'checked_at', NULL) $h$;
CREATE FUNCTION pg_temp.ok_st(r jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $h$
  SELECT r ? 'results' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'results') x WHERE x ->> 'status' NOT IN ('applied', 'added', 'removed', 'restored')) $h$;

-- T1: a desktop push (a set of done and note on an existing item, and a create) leaves app NULL and reads
-- mcp_connections zero times
CREATE FUNCTION pg_temp.c_t1() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE s0 bigint; d bigint; r jsonb; m1 uuid := pg_temp.id('m1');
BEGIN
  s0 := pg_temp.scans();
  r := pg_temp.push(pg_temp.id('A'), pg_temp.id('IA'), jsonb_build_array(
         pg_temp.op_set(m1, 'note', '"Desktop note"', 2), pg_temp.op_set(m1, 'done', pg_temp.done_v(), 2),
         pg_temp.ci(pg_temp.id('D1'), 'd1-my', 'm9', 'Desktop added', 9, 'with a note')));
  d := pg_temp.scans() - s0;
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.ok_st(r), 'push ' || r::text),
    pg_temp.pass(pg_temp.apps(m1) ->> 'note_app' IS NULL AND pg_temp.apps(m1) ->> 'done_app' IS NULL, 'm1 ' || pg_temp.apps(m1)::text),
    pg_temp.pass((pg_temp.apps(pg_temp.item_of(pg_temp.id('D1'), 'm9')) - 'done_rev' - 'note_rev') = '{"done_app":null,"note_app":null}', 'm9'),
    pg_temp.pass(d = 0, 'mcp_connections reads during the desktop push: ' || d)) || ' [reads=' || d || ']';
END $h$;

-- T2: AI-app writes through mcp_update_todo record the connection's provider (client_name is not used); the pull
-- and the push answers carry 'app' on done and note only
CREATE FUNCTION pg_temp.c_t2() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE r1 jsonb; r2 jsonb; p jsonb; m2 uuid := pg_temp.id('m2'); m3 uuid := pg_temp.id('m3'); row_ jsonb; ans jsonb;
BEGIN
  PERFORM pg_temp.unrate();
  r1 := pg_temp.upd(1, m2, '{"note":"AI note","done":true}');
  r2 := pg_temp.upd(2, m3, '{"note":"Other app note"}');
  p := pg_temp.pull(pg_temp.id('A'), pg_temp.id('IA'));
  SELECT x INTO row_ FROM jsonb_array_elements(p -> 'rows') x WHERE x ->> 'cloud_id' = m2::text ORDER BY (x ->> 'change_seq')::bigint DESC LIMIT 1;
  ans := pg_temp.push(pg_temp.id('A'), pg_temp.id('IA'), jsonb_build_array(pg_temp.op_set(m3, 'title', '"Renamed"', 2)));
  RETURN pg_temp.all_of(
    pg_temp.pass(r1 -> 'result' ->> 'status' IS NOT NULL AND r1 ->> 'error' IS NULL, 'upd1 ' || r1::text),
    pg_temp.pass(pg_temp.apps(m2) ->> 'note_app' = 'anthropic' AND pg_temp.apps(m2) ->> 'done_app' = 'anthropic', 'm2 ' || pg_temp.apps(m2)::text),
    pg_temp.pass(pg_temp.apps(m3) ->> 'note_app' = 'openai' AND pg_temp.apps(m3) ->> 'done_app' IS NULL, 'm3 ' || pg_temp.apps(m3)::text),
    pg_temp.pass(row_ -> 'parts' -> 'note' ->> 'app' = 'anthropic' AND row_ -> 'parts' -> 'done' ->> 'app' = 'anthropic', 'pull ' || coalesce(row_ -> 'parts', 'null')::text),
    pg_temp.pass(NOT (row_ -> 'parts' -> 'title') ? 'app' AND NOT (row_ -> 'parts' -> 'due') ? 'app', 'title/due carry app'),
    pg_temp.pass(ans -> 'results' -> 0 -> 'parts' -> 'note' ->> 'app' = 'openai' AND (ans -> 'results' -> 0 -> 'parts' -> 'done') ? 'app',
                 'push answer ' || coalesce(ans -> 'results' -> 0 -> 'parts', ans)::text))
    || ' [pull_note_keys=' || coalesce((SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(row_ -> 'parts' -> 'note') k), '-') || ']';
END $h$;

-- T3: a desktop write of the same part after an AI write sets app back to NULL
CREATE FUNCTION pg_temp.c_t3() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE r jsonb; m4 uuid := pg_temp.id('m4'); a0 jsonb;
BEGIN
  PERFORM pg_temp.unrate();
  r := pg_temp.upd(1, m4, '{"note":"AI first","done":true}');
  a0 := pg_temp.apps(m4);
  r := pg_temp.push(pg_temp.id('A'), pg_temp.id('IA'), jsonb_build_array(pg_temp.op_set(m4, 'note', '"Agent rewrote it"', 5),
         pg_temp.op_set(m4, 'done', '{"is_checked":false,"checked_at":null}', 5)));
  RETURN pg_temp.all_of(
    pg_temp.pass(a0 ->> 'note_app' = 'anthropic' AND a0 ->> 'done_app' = 'anthropic', 'after AI ' || a0::text),
    pg_temp.pass(pg_temp.ok_st(r), 'push ' || r::text),
    pg_temp.pass(pg_temp.apps(m4) ->> 'note_app' IS NULL AND pg_temp.apps(m4) ->> 'done_app' IS NULL, 'after desktop ' || pg_temp.apps(m4)::text));
END $h$;

-- T4: after the connection is removed, a title change by the desktop keeps note_app
CREATE FUNCTION pg_temp.c_t4() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE r jsonb; d text; m5 uuid := pg_temp.id('m5');
BEGIN
  PERFORM pg_temp.unrate();
  r := pg_temp.upd(1, m5, '{"note":"AI note"}');
  d := pg_temp.call_as(pg_temp.id('A'), format('SELECT public.mcp_disconnect(%L::uuid)', pg_temp.id('KA')));
  r := pg_temp.push(pg_temp.id('A'), pg_temp.id('IA'), jsonb_build_array(pg_temp.op_set(m5, 'title', '"Title by the agent"', 5)));
  RETURN pg_temp.all_of(
    pg_temp.pass(d LIKE '%"ok": true%' AND NOT EXISTS (SELECT 1 FROM public.mcp_connections WHERE id = pg_temp.id('KA')), 'disconnect ' || d),
    pg_temp.pass(pg_temp.ok_st(r), 'push ' || r::text),
    pg_temp.pass(pg_temp.apps(m5) ->> 'note_app' = 'anthropic', 'm5 ' || pg_temp.apps(m5)::text));
END $h$;

-- T5: the desktop removes an item an AI app wrote, then restore brings it back with its app values
CREATE FUNCTION pg_temp.c_t5() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE r jsonb; rr jsonb; m6 uuid := pg_temp.id('m6');
BEGIN
  PERFORM pg_temp.unrate();
  r := pg_temp.upd(2, m6, '{"note":"AI note","done":true}');
  r := pg_temp.push(pg_temp.id('A'), pg_temp.id('IA'), jsonb_build_array(pg_temp.op('remove', m6)));
  rr := pg_temp.restore(pg_temp.id('A'), m6);
  RETURN pg_temp.all_of(
    pg_temp.pass(r -> 'results' -> 0 ->> 'status' = 'removed', 'remove ' || r::text),
    pg_temp.pass(rr::text LIKE '%restored%', 'restore ' || rr::text),
    pg_temp.pass(pg_temp.apps(m6) ->> 'note_app' = 'openai' AND pg_temp.apps(m6) ->> 'done_app' = 'openai', 'm6 ' || pg_temp.apps(m6)::text));
END $h$;

-- T6: a ref that is not a connection uuid of this owner gives NULL and the write succeeds; an upper-case uuid of
-- the owner's own connection gives its provider
CREATE FUNCTION pg_temp.c_t6() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE r1 jsonb; r2 jsonb; r3 jsonb; m7 uuid := pg_temp.id('m7'); m8 uuid := pg_temp.id('m8'); m1 uuid := pg_temp.id('m1');
BEGIN
  r1 := pg_temp.ai(pg_temp.id('A'), jsonb_build_array(pg_temp.op_set(m7, 'done', pg_temp.done_v(), NULL)), 'conn-1');
  r2 := pg_temp.ai(pg_temp.id('A'), jsonb_build_array(pg_temp.op_set(m8, 'note', '"Other owner ref"', NULL)), pg_temp.id('KB')::text);
  r3 := pg_temp.ai(pg_temp.id('A'), jsonb_build_array(pg_temp.op_set(m1, 'note', '"Upper case ref"', NULL)), upper(pg_temp.id('KO')::text));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.st(r1) = 'applied' AND pg_temp.apps(m7) ->> 'done_app' IS NULL, 'malformed ' || r1::text || ' ' || coalesce(pg_temp.apps(m7)::text, '')),
    pg_temp.pass(pg_temp.st(r2) = 'applied' AND pg_temp.apps(m8) ->> 'note_app' IS NULL, 'other owner ' || r2::text),
    pg_temp.pass(pg_temp.st(r3) = 'applied' AND pg_temp.apps(m1) ->> 'note_app' = 'openai', 'upper case ' || r3::text || ' ' || coalesce(pg_temp.apps(m1)::text, '')));
END $h$;

-- T7: rewriting done_by without a new rev keeps done_app (even when the connection is gone); a new rev recomputes
CREATE FUNCTION pg_temp.c_t7() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE r jsonb; m8 uuid := pg_temp.id('m8'); a1 jsonb; a2 jsonb;
BEGIN
  PERFORM pg_temp.unrate();
  r := pg_temp.upd(1, m8, '{"done":true}');
  DELETE FROM public.mcp_connections WHERE id = pg_temp.id('KA');
  UPDATE public.cloud_deal_checklist_items SET done_by = done_by WHERE id = m8;
  a1 := pg_temp.apps(m8);
  UPDATE public.cloud_deal_checklist_items SET done_rev = done_rev + 1 WHERE id = m8;
  a2 := pg_temp.apps(m8);
  RETURN pg_temp.all_of(
    pg_temp.pass(a1 ->> 'done_app' = 'anthropic', 'same rev ' || a1::text || ' ' || r::text),
    pg_temp.pass(a2 ->> 'done_app' IS NULL, 'new rev ' || a2::text));
END $h$;

-- T8: an item an AI app adds carries the provider on done and note
CREATE FUNCTION pg_temp.c_t8() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE r jsonb; t uuid;
BEGIN
  PERFORM pg_temp.unrate();
  r := pg_temp.add(2, pg_temp.id('D1'), 'Added by an app', 'with a note');
  SELECT id INTO t FROM public.cloud_deal_checklist_items WHERE cloud_deal_id = pg_temp.id('D1') AND title = 'Added by an app';
  RETURN pg_temp.all_of(
    pg_temp.pass(t IS NOT NULL, 'add ' || r::text),
    pg_temp.pass(pg_temp.apps(t) ->> 'note_app' = 'openai' AND pg_temp.apps(t) ->> 'done_app' = 'openai', 'added ' || coalesce(pg_temp.apps(t)::text, 'null')));
END $h$;

-- T9: the read probe sees reads (an AI write reads mcp_connections in _mcp_enter)
CREATE FUNCTION pg_temp.c_t9() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE s0 bigint; d bigint; r jsonb;
BEGIN
  PERFORM pg_temp.unrate();
  s0 := pg_temp.scans();
  r := pg_temp.upd(2, pg_temp.id('m2'), '{"title":"Probe"}');
  d := pg_temp.scans() - s0;
  RETURN pg_temp.pass(d > 0, 'reads ' || d || ' ' || r::text) || ' [reads=' || d || ']';
END $h$;

-- S1 (G1a): the 2.48.0 payload through the new function stores the same rows as the old function did, new columns NULL
CREATE FUNCTION pg_temp.c_s1() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE a text; newr jsonb; oldr jsonb := pg_temp.fxv('g1_old_rows')::jsonb; olda jsonb := pg_temp.fxv('g1_old_answer')::jsonb;
BEGIN
  a := pg_temp.snap(pg_temp.id('A'), pg_temp.id('S_new'), pg_temp.payload248());
  newr := pg_temp.items(pg_temp.id('S_new'));
  RETURN pg_temp.all_of(
    pg_temp.pass(a NOT LIKE 'ERR%' AND (pg_temp.j(a) - 'carry') = (olda - 'carry'), 'answer ' || a || ' old ' || olda::text),
    pg_temp.pass(jsonb_array_length(newr) = 3 AND jsonb_array_length(oldr) = 3, 'rows ' || jsonb_array_length(newr)),
    pg_temp.pass((SELECT jsonb_agg(x - 'attribution_v' - 'note_by_kind' - 'note_by_app') FROM jsonb_array_elements(newr) x) = oldr,
                 'rows differ: new ' || newr::text || ' old ' || oldr::text),
    pg_temp.pass(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(newr) x WHERE x ->> 'attribution_v' IS NOT NULL OR x ->> 'note_by_kind' IS NOT NULL
                                                                         OR x ->> 'note_by_app' IS NOT NULL), 'new columns not NULL'));
END $h$;

-- S2: every malformed or CHECK-breaking author shape stores NULL and the call succeeds; well-formed ones are stored;
-- is_checked never becomes reviewer_checked
CREATE FUNCTION pg_temp.sweep_payload() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $h$
  SELECT jsonb_build_array(jsonb_build_object('template_id', NULL, 'template_name', 'Sweep', 'sort_order', 0, 'items',
    (SELECT jsonb_agg(jsonb_build_object('title', 'Sweep ' || c.k, 'local_item_id', 'sw-' || c.k, 'description', NULL, 'is_required', true,
                                         'expected_document_type', NULL, 'is_checked', c.k = 'p', 'note', c.note, 'sort_order', c.o, 'links', '[]'::jsonb) || c.extra)
       FROM (VALUES
         ('a', 1, 'text', '{"attribution_v":"1","note_by":{"kind":"agent"}}'::jsonb),
         ('b', 2, 'text', '{"attribution_v":2,"note_by":{"kind":"agent"}}'),
         ('c', 3, 'text', '{"attribution_v":1,"note_by":"agent"}'),
         ('d', 4, 'text', '{"attribution_v":1,"note_by":{"kind":"robot"}}'),
         ('e', 5, 'text', '{"attribution_v":1,"note_by":{"kind":"ai_app","app":"Claude<b>"}}'),
         ('f', 6, 'text', '{"attribution_v":1,"note_by":{"kind":"agent","app":"anthropic"}}'),
         ('g', 7, 'text', '{"attribution_v":1,"note_by":{"app":"anthropic"}}'),
         ('h', 8, '   ', '{"attribution_v":1,"note_by":{"kind":"agent"}}'),
         ('i', 9, NULL, '{"attribution_v":1,"note_by":{"kind":"agent"}}'),
         ('j', 10, 'text', '{"note_by":{"kind":"agent"}}'),
         ('k', 11, 'text', '{"attribution_v":1,"note_by":{"kind":"ai_app","app":"anthropic"}}'),
         ('l', 12, 'text', '{"attribution_v":1,"note_by":{"kind":"agent"}}'),
         ('m', 13, 'text', '{"attribution_v":1,"note_by":null}'),
         ('n', 14, 'text', '{"attribution_v":1,"note_by":{"kind":5}}'),
         ('o', 15, 'text', '{"attribution_v":1.0,"note_by":{"kind":"ai_app","app":"openai"}}'),
         ('p', 16, 'text', '{"attribution_v":true,"note_by":{"kind":"ai_app"}}'),
         ('q', 17, 'text', '{"attribution_v":1,"note_by":{"kind":"ai_app","app":null}}'),
         ('r', 18, 'text', '{"attribution_v":[1],"note_by":[]}')
       ) c(k, o, note, extra)))) $h$;
CREATE FUNCTION pg_temp.c_s2() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE a text; got jsonb; want jsonb := '{
  "sw-a":[null,null,null],"sw-b":[null,null,null],"sw-c":[1,null,null],"sw-d":[1,null,null],"sw-e":[1,"ai_app",null],
  "sw-f":[1,"agent",null],"sw-g":[1,null,null],"sw-h":[1,null,null],"sw-i":[1,null,null],"sw-j":[null,null,null],
  "sw-k":[1,"ai_app","anthropic"],"sw-l":[1,"agent",null],"sw-m":[1,null,null],"sw-n":[1,null,null],"sw-o":[1,"ai_app","openai"],
  "sw-p":[null,null,null],"sw-q":[1,"ai_app",null],"sw-r":[null,null,null]}';
BEGIN
  a := pg_temp.snap(pg_temp.id('A'), pg_temp.id('S_sweep'), pg_temp.sweep_payload());
  SELECT jsonb_object_agg(i.local_item_id, jsonb_build_array(i.attribution_v, i.note_by_kind, i.note_by_app)) INTO got
    FROM public.submission_checklist_items i WHERE i.submission_id = pg_temp.id('S_sweep');
  RETURN pg_temp.all_of(
    pg_temp.pass(a NOT LIKE 'ERR%' AND (pg_temp.j(a) ->> 'items')::int = 18, 'call ' || a),
    pg_temp.pass(got = want, 'got ' || coalesce(got::text, 'null')),
    pg_temp.pass((SELECT bool_and(NOT i.reviewer_checked) AND bool_or(i.is_checked) FROM public.submission_checklist_items i
                   WHERE i.submission_id = pg_temp.id('S_sweep')), 'reviewer_checked set'));
END $h$;

-- S3: every existing structural refusal still raises 22023 invalid_payload, as before the migration
CREATE FUNCTION pg_temp.refusals() RETURNS jsonb LANGUAGE sql AS $h$
  SELECT jsonb_agg(left(pg_temp.snap(pg_temp.id('A'), CASE WHEN x.n = 7 THEN NULL ELSE pg_temp.id('S_sweep') END, x.p), 30) ORDER BY x.n)
    FROM (VALUES
      (1, '{}'::jsonb), (2, '[1]'), (3, '[{"template_name":"X","items":{}}]'), (4, '[{"template_name":"X","items":[1]}]'),
      (5, '[{"template_name":"X","items":[{"title":"I","links":{}}]}]'),
      (6, '[{"template_name":"X","items":[{"title":"I","links":[{"kind":"fax","label":"F","local_ids":["x"]}]}]}]'),
      (7, '[]')) x(n, p) $h$;
CREATE FUNCTION pg_temp.c_s3() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE now_ jsonb := pg_temp.refusals(); before_ jsonb := pg_temp.fxv('s3_before')::jsonb;
BEGIN
  RETURN pg_temp.all_of(
    pg_temp.pass(now_ = before_, 'after ' || now_::text || ' before ' || before_::text),
    pg_temp.pass(NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(now_) x WHERE x NOT LIKE 'ERR 22023 invalid_payload%'), now_::text));
END $h$;

-- G3: a second user calling the function for A's submission is refused as before; A can set the three columns
-- directly (table INSERT under the insert policy) to any well-formed value, and a CHECK refuses the rest
CREATE FUNCTION pg_temp.c_g3() RETURNS text LANGUAGE plpgsql AS $h$
DECLARE b text; hdr text; ins jsonb := '[]'; q text; v text;
BEGIN
  b := pg_temp.snap(pg_temp.id('B'), pg_temp.id('S_ref2'), pg_temp.payload248());
  hdr := pg_temp.call_as(pg_temp.id('A'), format('INSERT INTO public.submission_checklists (submission_id, template_name, sort_order) VALUES (%L::uuid, %L, 0)',
                                                 pg_temp.id('S_ref2'), 'Direct'));
  FOREACH q IN ARRAY ARRAY['1, ''ai_app'', ''anthropic''', '1, ''ai_app'', ''Claude<b>''', '1, NULL, ''anthropic''', 'NULL, ''agent'', NULL', '1, ''agent'', NULL'] LOOP
    v := pg_temp.call_as(pg_temp.id('A'), format('INSERT INTO public.submission_checklist_items (submission_id, submission_checklist_id, title, is_required, note, attribution_v, note_by_kind, note_by_app)
       SELECT %L::uuid, c.id, %L, false, %L, %s FROM public.submission_checklists c WHERE c.submission_id = %L::uuid AND c.template_name = %L',
       pg_temp.id('S_ref2'), 'Direct item', 'a note', q, pg_temp.id('S_ref2'), 'Direct'));
    ins := ins || to_jsonb(left(v, 9));
  END LOOP;
  RETURN pg_temp.all_of(
    pg_temp.pass(left(b, 9) = left(pg_temp.fxv('g3_before'), 9) AND b LIKE 'ERR 42501%', 'second user after ' || b || ' before ' || pg_temp.fxv('g3_before')),
    pg_temp.pass(hdr = '"rows=1"', 'header ' || hdr),
    pg_temp.pass(ins = '["\"rows=1\"", "ERR 23514", "ERR 23514", "ERR 23514", "\"rows=1\""]'::jsonb, 'direct inserts ' || ins::text))
    || ' [direct=' || ins::text || ' second_user=' || left(b, 9) || ']';
END $h$;
