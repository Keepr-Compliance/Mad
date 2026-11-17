-- BACKLOG-4263 PR-2 probes. Each returns 'PASS' or 'FAIL: ...'. harness.py runs each in its own
-- subtransaction that is undone afterwards, so every probe starts from the fixtures.

CREATE FUNCTION pg_temp.tsx(t timestamptz) RETURNS text LANGUAGE sql IMMUTABLE AS $h$
  SELECT to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$h$;
-- a stale-base desktop note change on item `id`, edited `age` before it is sent
CREATE FUNCTION pg_temp.desk_note(id uuid, val text, base bigint, age interval, es bigint DEFAULT NULL, inst text DEFAULT 'I1') RETURNS jsonb LANGUAGE plpgsql AS $h$
DECLARE s timestamptz := clock_timestamp();
BEGIN
  RETURN pg_temp.push(pg_temp.id('A'), pg_temp.id(inst), pg_temp.tsx(s),
           jsonb_build_array(pg_temp.op_set(id, 'note', to_jsonb(val), base, es, pg_temp.tsx(s - age))));
END $h$;

-- C1 / W1: per part. A desktop change of one part never undoes a newer change of another part; a stale
-- desktop change of the same part made before the AI change loses and is kept in history.
CREATE FUNCTION pg_temp.p_parts() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); i2 uuid := pg_temp.id('i2'); r1 jsonb; r2 jsonb; r3 jsonb; t public.cloud_deal_checklist_items;
BEGIN
  r1 := pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(i2, 'note', '"AI note"')));
  r2 := pg_temp.push(A, pg_temp.id('I1'), pg_temp.nowt(), jsonb_build_array(pg_temp.op_set(i2, 'done', '{"is_checked":true}', 1, 1, pg_temp.nowt())));
  r3 := pg_temp.desk_note(i2, 'old desk note', 1, interval '3 days', 2);
  t := pg_temp.it(i2);
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.st(r1) = 'applied', 'ai ' || r1::text),
    pg_temp.pass(pg_temp.st(r2) = 'applied', 'done ' || r2::text),
    pg_temp.pass(pg_temp.st(r3) = 'lost' AND (pg_temp.r0(r3) ->> 'conflict')::boolean, 'stale note ' || r3::text),
    pg_temp.pass(t.note = 'AI note' AND t.is_checked AND t.done_by = 'desktop:' || pg_temp.id('I1') AND t.note_by = 'ai_app:conn-1', 'row ' || to_jsonb(t)::text),
    pg_temp.pass((SELECT count(*) FROM public.cloud_todo_history h WHERE h.entity_id = i2 AND h.kind = 'change' AND h.outcome = 'lost'
                    AND h.new_value = '"old desk note"' AND h.actor_kind = 'desktop') = 1, 'lost row'),
    pg_temp.pass(pg_temp.hist_n(i2, 'conflict') = 1, 'conflict events ' || pg_temp.hist_n(i2, 'conflict')));
END $p$;

-- concurrent, the desktop edit is later: it wins, the overwritten value stays in history, one conflict event
CREATE FUNCTION pg_temp.p_later_wins() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); i2 uuid := pg_temp.id('i2'); r jsonb; t public.cloud_deal_checklist_items;
BEGIN
  PERFORM pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(i2, 'note', '"AI note"')));
  UPDATE public.cloud_deal_checklist_items SET note_eff_at = now() - interval '1 hour' WHERE id = i2;
  r := pg_temp.desk_note(i2, 'desk later', 1, interval '1 minute', 5);
  t := pg_temp.it(i2);
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.st(r) = 'applied' AND (pg_temp.r0(r) ->> 'conflict')::boolean, r::text),
    pg_temp.pass(t.note = 'desk later' AND t.note_rev = 3, to_jsonb(t)::text),
    pg_temp.pass(EXISTS (SELECT 1 FROM public.cloud_todo_history h WHERE h.entity_id = i2 AND h.kind = 'conflict'
                          AND h.old_value = '"AI note"' AND h.other_by = 'ai_app:conn-1'), 'event'));
END $p$;

-- R9 / W29: the same value on both sides is unchanged, one history row, no conflict
CREATE FUNCTION pg_temp.p_equal() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); i2 uuid := pg_temp.id('i2'); r jsonb; n0 bigint; n1 bigint;
BEGIN
  PERFORM pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(i2, 'note', '"Call lender"')));
  n0 := pg_temp.hist_n(i2);
  r := pg_temp.desk_note(i2, 'Call lender', 1, interval '1 hour', 3);
  n1 := pg_temp.hist_n(i2);
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.st(r) = 'unchanged' AND (pg_temp.r0(r) ->> 'conflict')::boolean IS NOT TRUE, r::text),
    pg_temp.pass(n1 - n0 = 1 AND pg_temp.hist_n(i2, 'conflict') = 0, 'history +' || (n1 - n0)),
    pg_temp.pass((SELECT outcome FROM public.cloud_todo_history WHERE entity_id = i2 ORDER BY change_seq DESC LIMIT 1) = 'unchanged', 'outcome'));
END $p$;

-- C5: a repeated op_id returns the stored result and writes nothing (desktop and AI)
CREATE FUNCTION pg_temp.p_replay() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); i2 uuid := pg_temp.id('i2'); m1 uuid := pg_temp.id('m1'); op jsonb; aop jsonb;
        r1 jsonb; r2 jsonb; a1 jsonb; a2 jsonb; h0 bigint; n0 bigint; s text := pg_temp.nowt();
BEGIN
  op := pg_temp.op_set(i2, 'note', '"once"', 1, 1, s);
  r1 := pg_temp.push(A, pg_temp.id('I1'), s, jsonb_build_array(op));
  h0 := pg_temp.head(A); n0 := pg_temp.hist_n(i2);
  r2 := pg_temp.push(A, pg_temp.id('I1'), s, jsonb_build_array(op || '{"value":"twice"}'));
  aop := pg_temp.op_set(m1, 'title', '"Call lender today"');
  a1 := pg_temp.ai(A, jsonb_build_array(aop));
  a2 := pg_temp.ai(A, jsonb_build_array(aop || '{"value":"other"}'));
  RETURN pg_temp.all_of(
    pg_temp.pass(r1 -> 'results' = r2 -> 'results', r1::text || ' / ' || r2::text),
    pg_temp.pass(pg_temp.head(A) - h0 = 2 AND pg_temp.hist_n(i2) = n0, 'head +' || (pg_temp.head(A) - h0) || ' hist ' || pg_temp.hist_n(i2)),
    pg_temp.pass((pg_temp.it(i2)).note = 'once', 'note ' || (pg_temp.it(i2)).note),
    pg_temp.pass(a1 -> 'results' = a2 -> 'results' AND (pg_temp.it(m1)).title = 'Call lender today', a1::text || ' / ' || a2::text));
END $p$;

-- R3 / W25 / W21: reordered delivery from one install (edit_seq), and a later re-edit after a lost answer
CREATE FUNCTION pg_temp.p_edit_seq() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE i2 uuid := pg_temp.id('i2'); rb jsonb; ra jsonb; rc jsonb;
BEGIN
  rb := pg_temp.desk_note(i2, 'B', 1, interval '1 minute', 3);
  ra := pg_temp.desk_note(i2, 'A', 1, interval '2 minutes', 2);
  rc := pg_temp.desk_note(i2, 'C', 1, interval '3 minutes', 4);
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.st(rb) = 'applied', 'B ' || rb::text),
    pg_temp.pass(pg_temp.st(ra) = 'lost', 'A ' || ra::text),
    pg_temp.pass(pg_temp.st(rc) = 'applied' AND (pg_temp.r0(rc) ->> 'conflict')::boolean IS NOT TRUE, 'C ' || rc::text),
    pg_temp.pass((pg_temp.it(i2)).note = 'C' AND (pg_temp.it(i2)).note_edit_seq = 4, 'final ' || (pg_temp.it(i2)).note));
END $p$;

-- R6 / C29: removal through the checklist and the deal; AI writes refused, desktop writes kept
CREATE FUNCTION pg_temp.p_parents() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); i1 uuid := pg_temp.id('i1'); i3 uuid := pg_temp.id('i3'); rc jsonb; ra jsonb; rd jsonb; rx jsonb; rr jsonb;
BEGIN
  rc := pg_temp.push(A, pg_temp.id('I1'), pg_temp.nowt(), jsonb_build_array(pg_temp.op('remove', 'checklist', pg_temp.id('cl1'), pg_temp.nowt())));
  ra := pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(i1, 'done', 'true')));
  rd := pg_temp.push(A, pg_temp.id('I1'), pg_temp.nowt(), jsonb_build_array(pg_temp.op_set(i1, 'note', '"offline edit"', 1, 1, pg_temp.nowt())));
  PERFORM pg_temp.deldeal(A, pg_temp.id('D2'));
  rx := pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(i3, 'note', '"x"')));
  rr := pg_temp.rpc(A, format('SELECT public.cloud_todo_restore(%L::uuid, %L, %L::uuid)', A, 'item', i1));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.st(rc) = 'removed', 'checklist ' || rc::text),
    pg_temp.pass(pg_temp.st(ra) = 'refused_removed' AND (pg_temp.it(i1)).is_checked IS NOT TRUE, 'ai ' || ra::text),
    pg_temp.pass(pg_temp.st(rd) = 'applied_to_removed' AND (pg_temp.it(i1)).note = 'offline edit', 'desk ' || rd::text),
    pg_temp.pass(pg_temp.st(rx) = 'refused_removed' AND (pg_temp.it(i3)).note IS NULL, 'deal ' || rx::text),
    pg_temp.pass(pg_temp.st(rr) = 'not_removed', 'restore child ' || rr::text));
END $p$;

-- ruling 2: removal wins over an edit; restorable with the edit intact
CREATE FUNCTION pg_temp.p_removal_wins() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); m1 uuid := pg_temp.id('m1'); r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb;
BEGIN
  r1 := pg_temp.ai(A, jsonb_build_array(pg_temp.op('remove', 'item', m1)));
  r2 := pg_temp.push(A, pg_temp.id('I1'), pg_temp.nowt(), jsonb_build_array(pg_temp.op_set(m1, 'note', '"made offline"', 1, 7, pg_temp.nowt())));
  r3 := pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(m1, 'note', '"ai after"')));
  r4 := pg_temp.rpc(A, format('SELECT public.cloud_todo_restore(%L::uuid, %L, %L::uuid)', A, 'item', m1));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.st(r1) = 'removed', 'remove ' || r1::text),
    pg_temp.pass(pg_temp.st(r2) = 'applied_to_removed', 'desk ' || r2::text),
    pg_temp.pass(pg_temp.st(r3) = 'refused_removed', 'ai ' || r3::text),
    pg_temp.pass(pg_temp.st(r4) = 'restored' AND (pg_temp.it(m1)).removed_at IS NULL AND (pg_temp.it(m1)).note = 'made offline', 'restore ' || r4::text));
END $p$;

-- §1.3 / Q1 / Q5: AI apps add to My items only, rename or remove only My items, may tick required items
CREATE FUNCTION pg_temp.p_ai_rules() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); i1 uuid := pg_temp.id('i1'); m1 uuid := pg_temp.id('m1');
        r_ren jsonb; r_rem jsonb; r_my jsonb; r_ord jsonb; r_tick jsonb; r_add jsonb; r_add2 jsonb; r_add3 jsonb; r_cl jsonb;
BEGIN
  r_ren := pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(i1, 'title', '"renamed"')));
  r_rem := pg_temp.ai(A, jsonb_build_array(pg_temp.op('remove', 'item', i1)));
  r_my := pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(m1, 'title', '"Call the lender"')));
  r_ord := pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(m1, 'order', '5')));
  r_tick := pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(i1, 'done', 'true')));
  r_add := pg_temp.ai(A, jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_item', 'deal_id', pg_temp.id('D2'),
             'title', 'Order survey', 'due_date', '2026-12-01', 'note', 'from AI')));
  r_add2 := pg_temp.ai(A, jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_item', 'deal_id', pg_temp.id('D2'),
             'title', ' order survey ')));
  r_add3 := pg_temp.ai(A, jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_item', 'deal_id', pg_temp.id('D1'), 'title', 'Book movers')));
  r_cl := pg_temp.ai(A, jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_checklist', 'deal_id', pg_temp.id('D1'),
             'local_id', 'x', 'template_id', 'tpl')));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.st(r_ren) = 'not_allowed' AND (pg_temp.it(i1)).title = 'Inspection report', 'rename template ' || r_ren::text),
    pg_temp.pass(pg_temp.st(r_rem) = 'not_allowed' AND (pg_temp.it(i1)).removed_at IS NULL, 'remove template ' || r_rem::text),
    pg_temp.pass(pg_temp.st(r_my) = 'applied', 'rename my ' || r_my::text),
    pg_temp.pass(pg_temp.st(r_ord) = 'not_allowed', 'order ' || r_ord::text),
    pg_temp.pass(pg_temp.st(r_tick) = 'applied' AND (pg_temp.it(i1)).is_checked AND (pg_temp.it(i1)).done_by = 'ai_app:conn-1', 'tick required ' || r_tick::text),
    pg_temp.pass(pg_temp.st(r_add) = 'added' AND (SELECT count(*) FROM public.cloud_deal_checklists c WHERE c.cloud_deal_id = pg_temp.id('D2')
                   AND c.template_id = 'keepr:my-items') = 1
                 AND (SELECT due_date FROM public.cloud_deal_checklist_items WHERE id = (pg_temp.r0(r_add) ->> 'cloud_id')::uuid) = DATE '2026-12-01',
                 'add ' || r_add::text),
    pg_temp.pass(pg_temp.st(r_add2) = 'already_added', 'repeat add ' || r_add2::text),
    pg_temp.pass(pg_temp.st(r_add3) = 'added' AND (SELECT cloud_checklist_id FROM public.cloud_deal_checklist_items
                   WHERE id = (pg_temp.r0(r_add3) ->> 'cloud_id')::uuid) = pg_temp.id('my1'), 'add to existing my items ' || r_add3::text),
    pg_temp.pass(pg_temp.st(r_cl) = 'not_allowed', 'ai checklist ' || r_cl::text));
END $p$;

-- AI text is cleaned before storing and lengths are checked after cleaning
CREATE FUNCTION pg_temp.p_strip() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); m1 uuid := pg_temp.id('m1'); r1 jsonb; r2 jsonb;
BEGIN
  r1 := pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(m1, 'note', to_jsonb('ab' || chr(8203) || 'c' || chr(7)))));
  r2 := pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(m1, 'title', to_jsonb(chr(8203) || chr(8203)))));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.st(r1) = 'applied' AND (pg_temp.it(m1)).note = 'abc', 'note ' || r1::text || ' stored ' || coalesce((pg_temp.it(m1)).note, 'null')),
    pg_temp.pass(pg_temp.st(r2) = 'rejected' AND (pg_temp.it(m1)).title = 'Call lender', 'title ' || r2::text));
END $p$;

-- §2.4 / R13: lock rule for AI-app changes; uploading is not locked; the desktop is not refused
CREATE FUNCTION pg_temp.p_lock(which text) RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); i2 uuid := pg_temp.id('i2'); r jsonb; rd jsonb; ru jsonb; rn jsonb; O uuid := pg_temp.fx(101);
BEGIN
  IF which = 'reason' THEN
    UPDATE public.cloud_deals SET lock_reason = 'submitted' WHERE id = pg_temp.id('D1');
    r := pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(i2, 'note', '"x"')));
    rd := pg_temp.push(A, pg_temp.id('I1'), pg_temp.nowt(), jsonb_build_array(pg_temp.op_set(i2, 'note', '"desk"', 1, 1, pg_temp.nowt())));
    RETURN pg_temp.all_of(pg_temp.pass(pg_temp.st(r) = 'locked', 'ai ' || r::text), pg_temp.pass(pg_temp.st(rd) = 'applied', 'desk ' || rd::text));
  END IF;
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, status, version)
  VALUES (O, A, 'd1', 'Fixture d1 Way', 'uploading', 1);
  SET LOCAL session_replication_role = origin;
  ru := pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(i2, 'note', '"during upload"')));
  SET LOCAL session_replication_role = replica;
  UPDATE public.transaction_submissions SET status = 'submitted' WHERE submitted_by = A AND local_transaction_id = 'd1';
  SET LOCAL session_replication_role = origin;
  r := pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(i2, 'note', '"after submit"')));
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, status, version)
  VALUES (O, A, 'd1', 'Fixture d1 Way', 'needs_changes', 2);
  SET LOCAL session_replication_role = origin;
  rn := pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(i2, 'note', '"after changes asked"')));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.st(ru) = 'applied', 'uploading ' || ru::text),
    pg_temp.pass(pg_temp.st(r) = 'locked', 'submitted ' || r::text),
    pg_temp.pass(pg_temp.st(rn) = 'applied', 'needs_changes v2 ' || rn::text));
END $p$;

-- no write reaches another owner's deal or item, or another install's deal from the desktop path
CREATE FUNCTION pg_temp.p_cross_owner() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); B uuid := pg_temp.id('B'); i2 uuid := pg_temp.id('i2'); i4 uuid := pg_temp.id('i4');
        r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb; r5 jsonb; r6 jsonb; r7 jsonb; pb jsonb; rh jsonb;
BEGIN
  r1 := pg_temp.ai(B, jsonb_build_array(pg_temp.op_set(i2, 'note', '"B was here"')));
  r2 := pg_temp.push(B, pg_temp.id('IB'), pg_temp.nowt(), jsonb_build_array(pg_temp.op_set(i2, 'note', '"B desk"', 1, 1, pg_temp.nowt())));
  r3 := pg_temp.push(A, pg_temp.id('I1'), pg_temp.nowt(), jsonb_build_array(pg_temp.op_set(i4, 'note', '"other install"', 1, 1, pg_temp.nowt())));
  r4 := pg_temp.deldeal(B, pg_temp.id('D1'));
  r5 := pg_temp.ai(B, jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_item', 'deal_id', pg_temp.id('D1'), 'title', 'B add')));
  r6 := pg_temp.rpc(B, format('SELECT public.cloud_todo_restore(%L::uuid, %L, %L::uuid)', B, 'deal', pg_temp.id('D1')));
  r7 := pg_temp.rpc(B, format('SELECT public.cloud_reclaim_install(%L::uuid, %L::uuid)', B, pg_temp.id('I1')));
  pb := pg_temp.pull(B, pg_temp.id('I1'), 0, 500);
  rh := pg_temp.rpc(B, format('SELECT public.cloud_todo_history(%L::uuid, %L, %L::uuid, 20)', B, 'item', i2));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.st(r1) = 'not_found', 'ai ' || r1::text),
    pg_temp.pass(pg_temp.st(r2) = 'not_found', 'push ' || r2::text),
    pg_temp.pass(pg_temp.st(r3) = 'not_found' AND (pg_temp.it(i4)).note IS NULL, 'install ' || r3::text),
    pg_temp.pass(r4 ->> 'error' = 'not_found' AND (SELECT removed_at FROM public.cloud_deals WHERE id = pg_temp.id('D1')) IS NULL, 'delete ' || r4::text),
    pg_temp.pass(pg_temp.st(r5) = 'not_found', 'add ' || r5::text),
    pg_temp.pass(pg_temp.st(r6) = 'not_found', 'restore ' || r6::text),
    pg_temp.pass((pg_temp.it(i2)).note = 'start', 'note ' || (pg_temp.it(i2)).note),
    pg_temp.pass(jsonb_array_length(pb -> 'rows') = 0, 'pull ' || pb::text),
    pg_temp.pass(jsonb_array_length(rh -> 'rows') = 0, 'history ' || rh::text),
    pg_temp.pass(r7 ->> 'removed_entry' = 'false', 'reclaim ' || r7::text));
END $p$;

-- E2 / C38: the unknowable list, one case per boundary
CREATE FUNCTION pg_temp.p_e2() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); i2 uuid := pg_temp.id('i2'); s timestamptz; r jsonb; res text[] := '{}'; c record; ops jsonb;
BEGIN
  FOR c IN SELECT * FROM (VALUES
      ('minus_1ms', interval '-1 millisecond', false, false, 'lost'),
      ('zero', interval '0', false, false, 'applied'),
      ('365d', interval '365 days', false, false, 'applied'),
      ('365d_1ms', interval '365 days 1 millisecond', false, false, 'lost'),
      ('edited_null', NULL::interval, false, false, 'lost'),
      ('sent_bad', interval '1 minute', true, false, 'lost'),
      ('stepped', interval '1 minute', false, true, 'lost')) v(name, age, bad_sent, stepped, want) LOOP
    UPDATE public.cloud_deal_checklist_items SET note_eff_at = TIMESTAMPTZ '2025-01-01', note_by = 'ai_app:x', note_rev = 9 WHERE id = i2;
    s := clock_timestamp();
    ops := jsonb_build_array(pg_temp.op_set(i2, 'note', to_jsonb('v-' || c.name), 1, NULL,
             CASE WHEN c.age IS NULL THEN NULL ELSE pg_temp.tsx(s - c.age) END)
           || CASE WHEN c.stepped THEN '{"clock_stepped":true}'::jsonb ELSE '{}'::jsonb END);
    r := pg_temp.push(A, pg_temp.id('I1'), CASE WHEN c.bad_sent THEN 'not a time' ELSE pg_temp.tsx(s) END, ops);
    res := res || pg_temp.pass(pg_temp.st(r) = c.want, c.name || ' want ' || c.want || ' got ' || r::text);
  END LOOP;
  RETURN pg_temp.all_of(VARIADIC res);
END $p$;

-- SR A1: an edit 3 days old loses to an AI change made 1 day ago
CREATE FUNCTION pg_temp.p_a1() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); i2 uuid := pg_temp.id('i2'); r jsonb;
BEGIN
  PERFORM pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(i2, 'note', '"AI yesterday"')));
  UPDATE public.cloud_deal_checklist_items SET note_eff_at = now() - interval '1 day' WHERE id = i2;
  r := pg_temp.desk_note(i2, 'desk 3 days ago', 1, interval '3 days', 2);
  RETURN pg_temp.pass(pg_temp.st(r) = 'lost' AND (pg_temp.it(i2)).note = 'AI yesterday', r::text);
END $p$;

-- F4 / W33: un-remove (same hash) and the deal restore renumber the deal and its live checklists and items
CREATE FUNCTION pg_temp.p_f4() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); D1 uuid := pg_temp.id('D1'); h1 bigint; r jsonb; p jsonb; ids text[]; want text[];
        h2 bigint; rr jsonb; p2 jsonb; ids2 text[]; r_again jsonb; h3 bigint;
BEGIN
  PERFORM pg_temp.deldeal(A, D1);
  h1 := pg_temp.head(A);
  r := pg_temp.deal(A, pg_temp.dp(pg_temp.id('I1'), 'd1'));
  p := pg_temp.pull(A, pg_temp.id('I1'), h1, 500, pg_temp.hz(A));
  SELECT array_agg(x ->> 'cloud_id' ORDER BY x ->> 'cloud_id') INTO ids FROM jsonb_array_elements(p -> 'rows') x;
  want := ARRAY[D1::text, pg_temp.id('cl1')::text, pg_temp.id('my1')::text, pg_temp.id('i1')::text, pg_temp.id('i2')::text, pg_temp.id('m1')::text];
  SELECT array_agg(x ORDER BY x) INTO want FROM unnest(want) x;
  h3 := pg_temp.head(A);
  r_again := pg_temp.deal(A, pg_temp.dp(pg_temp.id('I1'), 'd1'));
  h3 := pg_temp.head(A) - h3;
  PERFORM pg_temp.deldeal(A, D1);
  h2 := pg_temp.head(A);
  rr := pg_temp.rpc(A, format('SELECT public.cloud_todo_restore(%L::uuid, %L, %L::uuid)', A, 'deal', D1));
  p2 := pg_temp.pull(A, pg_temp.id('I1'), h2, 500, pg_temp.hz(A));
  SELECT array_agg(x ->> 'cloud_id' ORDER BY x ->> 'cloud_id') INTO ids2 FROM jsonb_array_elements(p2 -> 'rows') x WHERE x ->> 'entity' <> 'event';
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.r0(r) ->> 'status' = 'unchanged' AND (pg_temp.r0(r) ->> 'restored')::boolean, 'upsert ' || r::text),
    pg_temp.pass((SELECT removed_at FROM public.cloud_deals WHERE id = D1) IS NULL OR h2 IS NOT NULL, 'deal live'),
    pg_temp.pass(ids = want, 'pull after un-remove ' || coalesce(array_to_string(ids, ','), 'none') || ' want ' || array_to_string(want, ',')),
    pg_temp.pass((pg_temp.r0(r_again) ->> 'restored')::boolean IS NOT TRUE AND h3 = 0, 'second upsert ' || r_again::text || ' head +' || h3),
    pg_temp.pass(pg_temp.st(rr) = 'restored' AND ids2 = want, 'restore ' || rr::text || ' pull ' || coalesce(array_to_string(ids2, ','), 'none')));
END $p$;

-- R5 / D8: paging across one large batch never skips or repeats; every number unique; history and
-- events take their own numbers
CREATE FUNCTION pg_temp.p_feed() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); h0 bigint; ops jsonb := '[]'; r jsonb; pa jsonb; created text[]; got text[]; seqs bigint[];
        h1 bigint; r2 jsonb; i2 uuid := pg_temp.id('i2'); hd0 bigint; s text := pg_temp.nowt();
BEGIN
  h0 := pg_temp.head(A);
  FOR n IN 1..30 LOOP
    ops := ops || jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_item', 'deal_id', pg_temp.id('D1'),
                    'checklist_local_id', 'cl1', 'local_id', 'bulk-' || n, 'title', 'Bulk ' || n, 'edited_at', s);
  END LOOP;
  r := pg_temp.push(A, pg_temp.id('I1'), s, ops);
  SELECT array_agg(x ->> 'cloud_id' ORDER BY x ->> 'cloud_id') INTO created FROM jsonb_array_elements(r -> 'results') x;
  pa := pg_temp.pull_all(A, pg_temp.id('I1'), h0, 7, pg_temp.hz(A));
  SELECT array_agg(x ORDER BY x) INTO got FROM jsonb_array_elements_text(pa -> 'ids') x;
  SELECT array_agg(x::bigint ORDER BY o) INTO seqs FROM jsonb_array_elements_text(pa -> 'seqs') WITH ORDINALITY y(x, o);
  hd0 := pg_temp.head(A);
  r2 := pg_temp.push(A, pg_temp.id('I1'), s, jsonb_build_array(pg_temp.op_set(i2, 'done', 'true', 1, 1, s), pg_temp.op_set(i2, 'note', '"n"', 1, 1, s)));
  RETURN pg_temp.all_of(
    pg_temp.pass(jsonb_array_length(r -> 'results') = 30 AND (SELECT bool_and(x ->> 'status' = 'added') FROM jsonb_array_elements(r -> 'results') x), 'push ' || left(r::text, 300)),
    pg_temp.pass(got = created, 'pull ids ' || cardinality(got) || ' vs ' || cardinality(created)),
    pg_temp.pass((SELECT bool_and(seqs[k] > seqs[k - 1]) FROM generate_series(2, cardinality(seqs)) k), 'seqs not increasing'),
    pg_temp.pass((pa ->> 'pages')::int >= 5, 'pages ' || (pa ->> 'pages')),
    pg_temp.pass(pg_temp.st(r2) = 'applied' AND pg_temp.st(r2, 1) = 'applied' AND pg_temp.head(A) - hd0 = 4, 'two parts: head +' || (pg_temp.head(A) - hd0) || ' ' || r2::text),
    pg_temp.pass((SELECT count(*) = count(DISTINCT change_seq) FROM public.cloud_todo_history WHERE owner_user_id = A), 'history numbers'));
END $p$;

-- W28 / R8 server side: install removal, refusal, status, reclaim per owner, un-remove by upload, restore
CREATE FUNCTION pg_temp.p_install() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); B uuid := pg_temp.id('B'); I2 uuid := pg_temp.id('I2'); D3 uuid := pg_temp.id('D3');
        r0 jsonb; r_up jsonb; r_new jsonb; r_push jsonb; s1 jsonb; rb jsonb; ra jsonb; s2 jsonb; r_up2 jsonb; n0 bigint; r_again jsonb;
BEGIN
  r0 := pg_temp.delinst(A, I2);
  r0 := r0 || jsonb_build_object('kind_now', (SELECT removed_kind FROM public.cloud_deals WHERE id = D3));
  r_again := pg_temp.delinst(A, I2);
  n0 := (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = A);
  r_up := pg_temp.deal(A, pg_temp.dp(I2, 'd3'));
  r_new := pg_temp.deal(A, pg_temp.dp(I2, 'd3-new'));
  r_push := pg_temp.push(A, I2, pg_temp.nowt(), jsonb_build_array(pg_temp.op_set(pg_temp.id('i4'), 'note', '"x"', 1, 1, pg_temp.nowt())));
  s1 := pg_temp.rpc(A, format('SELECT public.cloud_install_status(%L::uuid, %L::uuid)', A, I2));
  rb := pg_temp.rpc(B, format('SELECT public.cloud_reclaim_install(%L::uuid, %L::uuid)', B, I2));
  ra := pg_temp.rpc(A, format('SELECT public.cloud_reclaim_install(%L::uuid, %L::uuid)', A, I2));
  s2 := pg_temp.rpc(A, format('SELECT public.cloud_install_status(%L::uuid, %L::uuid)', A, I2));
  r_up2 := pg_temp.deal(A, pg_temp.dp(I2, 'd3'));
  RETURN pg_temp.all_of(
    pg_temp.pass(r0 ->> 'deleted_deals' = '1' AND r0 ->> 'kind_now' = 'install', 'delete install ' || r0::text),
    pg_temp.pass(r_again ->> 'success' = 'true' AND r_again ->> 'deleted_deals' = '0', 'repeat ' || r_again::text),
    pg_temp.pass(r_up ->> 'error' = 'install_removed' AND r_new ->> 'error' = 'install_removed'
                 AND (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = A) = n0, 'upload ' || r_up::text || r_new::text),
    pg_temp.pass(r_push ->> 'error' = 'install_removed', 'push ' || r_push::text),
    pg_temp.pass(s1 ->> 'removed' = 'true' AND s2 ->> 'removed' = 'false', 'status ' || s1::text || s2::text),
    pg_temp.pass(rb ->> 'removed_entry' = 'false' AND ra ->> 'removed_entry' = 'true', 'reclaim ' || rb::text || ra::text),
    pg_temp.pass((pg_temp.r0(r_up2) ->> 'restored')::boolean AND (SELECT removed_at FROM public.cloud_deals WHERE id = D3) IS NULL, 'upload after reclaim ' || r_up2::text));
END $p$;

-- a deal removed with its install: restoring it restores the install's copy and clears the register row
CREATE FUNCTION pg_temp.p_install_restore() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); I2 uuid := pg_temp.id('I2'); D3 uuid := pg_temp.id('D3'); r jsonb; s jsonb;
BEGIN
  PERFORM pg_temp.delinst(A, I2);
  r := pg_temp.rpc(A, format('SELECT public.cloud_todo_restore(%L::uuid, %L, %L::uuid)', A, 'deal', D3));
  s := pg_temp.rpc(A, format('SELECT public.cloud_install_status(%L::uuid, %L::uuid)', A, I2));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.st(r) = 'restored' AND (pg_temp.r0(r) ->> 'install_restored')::boolean, r::text),
    pg_temp.pass(s ->> 'removed' = 'false' AND (SELECT removed_at FROM public.cloud_deals WHERE id = D3) IS NULL, s::text));
END $p$;

-- deal delete is a soft removal: people, files and blobs stay; repeat answers ok; LIR, install list and readers skip it
CREATE FUNCTION pg_temp.p_soft_delete() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); D2 uuid := pg_temp.id('D2'); r1 jsonb; r2 jsonb; h0 bigint; h1 bigint; lir jsonb; lci jsonb; li jsonb;
        ld0 jsonb; ld1 jsonb; gd jsonb; gc jsonb;
BEGIN
  ld0 := pg_temp.j(pg_temp.as_user(A, 'SELECT public._mcp_r_list_deals(NULL, NULL, 50, NULL, NULL)'));
  r1 := pg_temp.deldeal(A, D2);
  h0 := pg_temp.head(A);
  r2 := pg_temp.deldeal(A, D2);
  h1 := pg_temp.head(A);
  lir := pg_temp.rpc(A, format('SELECT public.cloud_list_install_rows(%L::uuid, %L::uuid, %L, NULL, 1000)', A, pg_temp.id('I1'), 'deal'));
  lci := pg_temp.rpc(A, format('SELECT public.cloud_list_install_rows(%L::uuid, %L::uuid, %L, NULL, 1000)', A, pg_temp.id('I1'), 'checklist_item'));
  li := pg_temp.rpc(A, 'SELECT public.cloud_list_installs()');
  ld1 := pg_temp.j(pg_temp.as_user(A, 'SELECT public._mcp_r_list_deals(NULL, NULL, 50, NULL, NULL)'));
  gd := pg_temp.j(pg_temp.as_user(A, format('SELECT public._mcp_r_get_deal(%L::uuid)', D2)));
  gc := pg_temp.j(pg_temp.as_user(A, format('SELECT public._mcp_r_deal_checklists(%L::uuid, NULL, NULL)', D2)));
  RETURN pg_temp.all_of(
    pg_temp.pass(r1 ->> 'ok' = 'true' AND (SELECT removed_at IS NOT NULL AND restorable_until > now() + interval '29 days' FROM public.cloud_deals WHERE id = D2), 'delete ' || r1::text),
    pg_temp.pass((SELECT count(*) FROM public.cloud_deal_files WHERE cloud_deal_id = D2) = 1
                 AND (SELECT purge_requested_at FROM public.cloud_blobs WHERE id = pg_temp.id('BL1')) IS NULL, 'files and blob kept'),
    pg_temp.pass(r2 ->> 'ok' = 'true' AND h1 = h0, 'repeat ' || r2::text || ' head +' || (h1 - h0)),
    pg_temp.pass((SELECT bool_and((x ->> 'removed')::boolean = (x ->> 'cloud_id' = D2::text)) FROM jsonb_array_elements(lir -> 'rows') x), 'lir deal ' || lir::text),
    pg_temp.pass((SELECT (x ->> 'removed')::boolean FROM jsonb_array_elements(lci -> 'rows') x WHERE x ->> 'cloud_id' = pg_temp.id('i3')::text)
                 AND (SELECT NOT (x ->> 'removed')::boolean FROM jsonb_array_elements(lci -> 'rows') x WHERE x ->> 'cloud_id' = pg_temp.id('i1')::text), 'lir item ' || lci::text),
    pg_temp.pass((SELECT (x ->> 'deals')::int FROM jsonb_array_elements(li -> 'installs') x WHERE x ->> 'source_install_id' = pg_temp.id('I1')::text) = 1, 'installs ' || li::text),
    pg_temp.pass(NOT (ld1 -> 'deals' @> jsonb_build_array(jsonb_build_object('deal_id', D2))) AND ld0 -> 'deals' @> jsonb_build_array(jsonb_build_object('deal_id', D2))
                 AND (ld1 -> 'copy' ->> 'deals_saved')::int = (ld0 -> 'copy' ->> 'deals_saved')::int - 1, 'list_deals'),
    pg_temp.pass(gd ->> 'not_found' = 'true' AND gc ->> 'not_found' = 'true', 'get ' || gd::text || gc::text));
END $p$;

-- items of a removed checklist do not count in the readers
CREATE FUNCTION pg_temp.p_reader_counts() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); D1 uuid := pg_temp.id('D1'); g0 jsonb; g1 jsonb; l1 jsonb;
BEGIN
  g0 := pg_temp.j(pg_temp.as_user(A, format('SELECT public._mcp_r_deal_checklists(%L::uuid, NULL, NULL)', D1)));
  PERFORM pg_temp.push(A, pg_temp.id('I1'), pg_temp.nowt(), jsonb_build_array(pg_temp.op('remove', 'checklist', pg_temp.id('cl1'), pg_temp.nowt())));
  g1 := pg_temp.j(pg_temp.as_user(A, format('SELECT public._mcp_r_deal_checklists(%L::uuid, NULL, NULL)', D1)));
  l1 := pg_temp.j(pg_temp.as_user(A, 'SELECT public._mcp_r_list_deals(NULL, NULL, 50, NULL, NULL)'));
  RETURN pg_temp.all_of(
    pg_temp.pass((g0 ->> 'items_total')::int = 3 AND (g1 ->> 'items_total')::int = 1 AND (g1 ->> 'items_open_required')::int = 0, g0 ->> 'items_total' || '/' || (g1 ->> 'items_total')),
    pg_temp.pass((SELECT (x ->> 'todos_total')::int FROM jsonb_array_elements(l1 -> 'deals') x WHERE x ->> 'deal_id' = D1::text) = 1, 'list todos'));
END $p$;

-- the daily purge: 30-day boundary, scrub, hard delete, blob fence, history, horizon, claim restored
CREATE FUNCTION pg_temp.p_purge() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); i2 uuid := pg_temp.id('i2'); m1 uuid := pg_temp.id('m1'); D2 uuid := pg_temp.id('D2'); D3 uuid := pg_temp.id('D3');
        r jsonb; f0 bigint; pr jsonb; rs jsonb; hi jsonb; role_after text; old_seq bigint;
BEGIN
  PERFORM pg_temp.push(A, pg_temp.id('I1'), pg_temp.nowt(), jsonb_build_array(pg_temp.op('remove', 'item', i2, pg_temp.nowt())));
  PERFORM pg_temp.ai(A, jsonb_build_array(pg_temp.op('remove', 'item', m1)));
  UPDATE public.cloud_deal_checklist_items SET removed_at = now() - interval '30 days 1 minute' WHERE id = i2;
  UPDATE public.cloud_deal_checklist_items SET removed_at = now() - interval '29 days 23 hours' WHERE id = m1;
  PERFORM pg_temp.deldeal(A, D2);
  UPDATE public.cloud_deals SET restorable_until = now() - interval '1 second' WHERE id = D2;
  PERFORM pg_temp.delinst(A, pg_temp.id('I2'));
  old_seq := (SELECT change_seq FROM public.cloud_deal_checklist_items WHERE id = i2);
  f0 := (SELECT forgotten_through_seq FROM public.cloud_todo_feed_head WHERE owner_user_id = A);
  PERFORM pg_temp.clear_claims();
  r := public._cloud_todo_purge();
  role_after := current_setting('request.jwt.claim.role', true);
  pr := pg_temp.pull(A, pg_temp.id('I1'), 1, 500, 0);
  rs := pg_temp.rpc(A, format('SELECT public.cloud_todo_restore(%L::uuid, %L, %L::uuid)', A, 'item', i2));
  hi := pg_temp.rpc(A, format('SELECT public.cloud_todo_history(%L::uuid, %L, %L::uuid, 20)', A, 'item', i2));
  RETURN pg_temp.all_of(
    pg_temp.pass((r ->> 'deals_purged')::int >= 1 AND (r ->> 'failed_owners')::int = 0, 'purge ' || r::text),
    pg_temp.pass((SELECT purged_at IS NOT NULL AND title IS NULL AND note IS NULL AND change_seq > old_seq FROM public.cloud_deal_checklist_items WHERE id = i2), 'i2 purged'),
    pg_temp.pass(pg_temp.hist_n(i2) = 0, 'i2 history ' || pg_temp.hist_n(i2)),
    pg_temp.pass((SELECT purged_at IS NULL AND title = 'Call lender' FROM public.cloud_deal_checklist_items WHERE id = m1), 'm1 kept (29 days)'),
    pg_temp.pass(NOT EXISTS (SELECT 1 FROM public.cloud_deals WHERE id = D2) AND NOT EXISTS (SELECT 1 FROM public.cloud_deal_files WHERE cloud_deal_id = D2)
                 AND NOT EXISTS (SELECT 1 FROM public.cloud_todo_history WHERE cloud_deal_id = D2), 'D2 deleted'),
    pg_temp.pass((SELECT purge_requested_at FROM public.cloud_blobs WHERE id = pg_temp.id('BL1')) IS NOT NULL, 'blob fenced'),
    pg_temp.pass(EXISTS (SELECT 1 FROM public.cloud_deals WHERE id = D3), 'D3 kept (within 30 days)'),
    pg_temp.pass((SELECT forgotten_through_seq FROM public.cloud_todo_feed_head WHERE owner_user_id = A) > f0, 'horizon'),
    pg_temp.pass((pr ->> 'resync_required')::boolean, 'stale cursor ' || left(pr::text, 200)),
    pg_temp.pass((SELECT (x ->> 'purged')::boolean AND NOT x ? 'parts' FROM jsonb_array_elements(pg_temp.pull(A, pg_temp.id('I1'), 0, 500) -> 'rows') x
                    WHERE x ->> 'cloud_id' = i2::text), 'pull tombstone'),
    pg_temp.pass(pg_temp.st(rs) = 'not_restorable', 'restore purged ' || rs::text),
    pg_temp.pass(hi ->> 'purged' = 'true' AND jsonb_array_length(hi -> 'rows') = 0, 'history ' || hi::text),
    pg_temp.pass(coalesce(role_after, '') = '', 'claim after purge: ' || coalesce(role_after, 'null')));
END $p$;

-- Q8 / C41: cloud_purge_deal_now
CREATE FUNCTION pg_temp.p_purge_now() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); B uuid := pg_temp.id('B'); D1 uuid := pg_temp.id('D1'); D2 uuid := pg_temp.id('D2');
        r_live jsonb; r_anon text; r_b jsonb; r_a jsonb; r_again jsonb; r_none text; r_bd text;
BEGIN
  r_live := pg_temp.rpc(A, format('SELECT public.cloud_purge_deal_now(%L::uuid, %L::uuid)', A, D1));
  PERFORM pg_temp.deldeal(A, D2);
  r_anon := pg_temp.call_as(NULL, format('SELECT public.cloud_purge_deal_now(%L::uuid, %L::uuid)', A, D2), 'anon');
  r_none := pg_temp.as_user(NULL, format('SELECT public.cloud_purge_deal_now(%L::uuid, %L::uuid)', A, D2));
  r_b := pg_temp.rpc(B, format('SELECT public.cloud_purge_deal_now(%L::uuid, %L::uuid)', B, D2));
  r_bd := pg_temp.as_user(B, format('SELECT to_jsonb(public._cloud_todo_purge_deal(%L::uuid, %L::uuid))', B, D2))
          || CASE WHEN EXISTS (SELECT 1 FROM public.cloud_deals WHERE id = D2) THEN ' kept' ELSE ' gone' END;
  r_a := pg_temp.rpc(A, format('SELECT public.cloud_purge_deal_now(%L::uuid, %L::uuid)', A, D2));
  r_again := pg_temp.rpc(A, format('SELECT public.cloud_purge_deal_now(%L::uuid, %L::uuid)', A, D2));
  RETURN pg_temp.all_of(
    pg_temp.pass(r_live ->> 'error' = 'not_removed' AND EXISTS (SELECT 1 FROM public.cloud_deals WHERE id = D1), 'live ' || r_live::text),
    pg_temp.pass(r_anon LIKE 'ERR 42501%', 'anon ' || r_anon::text),
    pg_temp.pass(pg_temp.j(r_none) ->> 'error' = 'not_authorized', 'no claims ' || r_none::text),
    pg_temp.pass(r_b ->> 'status' = 'not_found', 'other owner ' || r_b::text),
    pg_temp.pass(r_bd = '"not_found" kept', 'purge step as other owner ' || r_bd),
    pg_temp.pass(r_a ->> 'status' = 'purged' AND NOT EXISTS (SELECT 1 FROM public.cloud_deals WHERE id = D2)
                 AND (SELECT purge_requested_at FROM public.cloud_blobs WHERE id = pg_temp.id('BL1')) IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM public.cloud_todo_history WHERE cloud_deal_id = D2), 'owner ' || r_a::text),
    pg_temp.pass(r_again ->> 'status' = 'not_found', 'repeat ' || r_again::text));
END $p$;

-- claims: no new function treats empty claims as the database owner
CREATE FUNCTION pg_temp.p_claims() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); B uuid := pg_temp.id('B'); c1 text; c2 text; c3 text; c4 text; c5 text; c6 text;
BEGIN
  PERFORM pg_temp.deldeal(A, pg_temp.id('D2'));
  c1 := pg_temp.as_user(NULL, format('SELECT public._cloud_todo_apply(%L::uuid, %L::jsonb, %L::jsonb)', A, '{"kind":"ai_app","ref":"x"}', '[]'));
  c2 := pg_temp.as_user(NULL, format('SELECT to_jsonb(public._cloud_todo_purge_deal(%L::uuid, %L::uuid))', A, pg_temp.id('D2')));
  c3 := pg_temp.as_user(B, format('SELECT to_jsonb(public._cloud_todo_purge_deal(%L::uuid, %L::uuid))', A, pg_temp.id('D2')));
  c4 := pg_temp.call_as(A, format('SELECT to_jsonb(public._cloud_todo_take_seq(%L::uuid, 1))', A));
  c5 := pg_temp.call_as(A, format('SELECT public._cloud_todo_apply(%L::uuid, %L::jsonb, %L::jsonb)', A, '{"kind":"ai_app","ref":"x"}', '[]'));
  c6 := pg_temp.as_user(B, format('SELECT public._cloud_todo_apply(%L::uuid, %L::jsonb, %L::jsonb)', A, '{"kind":"ai_app","ref":"x"}', '[]'));
  RETURN pg_temp.all_of(
    pg_temp.pass(c1 LIKE 'ERR 42501%', 'core no claims ' || c1),
    pg_temp.pass(c2 LIKE 'ERR 42501 purge_deal: not allowed%' AND EXISTS (SELECT 1 FROM public.cloud_deals WHERE id = pg_temp.id('D2')), 'purge_deal no claims ' || c2),
    pg_temp.pass(c3 LIKE 'ERR 42501 purge_deal: not allowed%', 'purge_deal other user ' || c3),
    pg_temp.pass(c4 LIKE 'ERR 42501%', 'take_seq authenticated ' || c4),
    pg_temp.pass(c5 LIKE 'ERR 42501%', 'core authenticated ' || c5),
    pg_temp.pass(c6 LIKE 'ERR 42501%', 'core other owner ' || c6));
END $p$;

-- C17: turn-off leaves no row of the owner in any cloud table with an owner column; no live blob
CREATE FUNCTION pg_temp.p_turnoff() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); r jsonb; t text; n bigint; left_rows text := '';
BEGIN
  PERFORM pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(pg_temp.id('m1'), 'note', '"x"')));
  PERFORM pg_temp.deldeal(A, pg_temp.id('D2'));
  PERFORM pg_temp.delinst(A, pg_temp.id('I2'));
  r := pg_temp.onoff(A, false);
  FOR t IN SELECT c.table_name FROM information_schema.columns c
            WHERE c.table_schema = 'public' AND c.table_name LIKE 'cloud%' AND c.column_name = 'owner_user_id' ORDER BY 1 LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE owner_user_id = $1', t) INTO n USING A;
    IF t = 'cloud_blobs' THEN EXECUTE 'SELECT count(*) FROM public.cloud_blobs WHERE owner_user_id = $1 AND purge_requested_at IS NULL' INTO n USING A; END IF;
    IF n > 0 THEN left_rows := left_rows || t || '=' || n || ' '; END IF;
  END LOOP;
  RETURN pg_temp.all_of(pg_temp.pass(r ->> 'success' = 'true', r::text), pg_temp.pass(left_rows = '', 'left: ' || left_rows),
           pg_temp.pass((SELECT count(*) FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name LIKE 'cloud_todo%' AND c.column_name = 'owner_user_id') = 3, 'tables seen'));
END $p$;

-- idempotent replays of the restore RPC and of the deal writes
CREATE FUNCTION pg_temp.p_idem() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); D1 uuid := pg_temp.id('D1'); m1 uuid := pg_temp.id('m1'); opid uuid := gen_random_uuid(); r1 jsonb; r2 jsonb; h0 bigint;
        opi uuid := gen_random_uuid(); ri1 jsonb; ri2 jsonb;
BEGIN
  PERFORM pg_temp.deldeal(A, D1);
  r1 := pg_temp.rpc(A, format('SELECT public.cloud_todo_restore(%L::uuid, %L, %L::uuid, %L::uuid)', A, 'deal', D1, opid));
  h0 := pg_temp.head(A);
  r2 := pg_temp.rpc(A, format('SELECT public.cloud_todo_restore(%L::uuid, %L, %L::uuid, %L::uuid)', A, 'deal', D1, opid));
  h0 := pg_temp.head(A) - h0;
  PERFORM pg_temp.ai(A, jsonb_build_array(pg_temp.op('remove', 'item', m1)));
  ri1 := pg_temp.rpc(A, format('SELECT public.cloud_todo_restore(%L::uuid, %L, %L::uuid, %L::uuid)', A, 'item', m1, opi));
  ri2 := pg_temp.rpc(A, format('SELECT public.cloud_todo_restore(%L::uuid, %L, %L::uuid, %L::uuid)', A, 'item', m1, opi));
  RETURN pg_temp.all_of(
    pg_temp.pass(r1 = r2 AND h0 = 0 AND pg_temp.st(r1) = 'restored', r1::text || ' / ' || r2::text),
    pg_temp.pass(ri1 -> 'results' = ri2 -> 'results' AND pg_temp.st(ri1) = 'restored', ri1::text || ' / ' || ri2::text));
END $p$;

-- desktop creates: a retried create dedupes; My items maps; a retried create never undoes a newer AI change
CREATE FUNCTION pg_temp.p_create() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); s text := pg_temp.nowt(); op jsonb; r1 jsonb; r2 jsonb; r3 jsonb; rm jsonb; n0 bigint; id uuid; r4 jsonb;
BEGIN
  op := jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_item', 'deal_id', pg_temp.id('D1'), 'checklist_local_id', 'cl1',
          'local_id', 'new-1', 'title', 'Wire funds', 'note', 'desk', 'edited_at', s, 'edit_seq', 1);
  r1 := pg_temp.push(A, pg_temp.id('I1'), s, jsonb_build_array(op));
  id := (pg_temp.r0(r1) ->> 'cloud_id')::uuid;
  n0 := (SELECT count(*) FROM public.cloud_deal_checklist_items WHERE cloud_deal_id = pg_temp.id('D1'));
  r2 := pg_temp.push(A, pg_temp.id('I1'), s, jsonb_build_array(op));
  PERFORM pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(id, 'note', '"AI later"')));
  r3 := pg_temp.push(A, pg_temp.id('I1'), pg_temp.nowt(), jsonb_build_array(op || jsonb_build_object('op_id', gen_random_uuid())));
  rm := pg_temp.push(A, pg_temp.id('I1'), s, jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_checklist',
          'deal_id', pg_temp.id('D1'), 'local_id', 'my-other', 'template_id', 'keepr:my-items', 'template_name', 'My items', 'edited_at', s)));
  r4 := pg_temp.push(A, pg_temp.id('I1'), s, jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_item', 'deal_id', pg_temp.id('D1'),
          'checklist_local_id', 'nope', 'local_id', 'new-2', 'title', 'x', 'edited_at', s)));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.st(r1) = 'added', 'create ' || r1::text),
    pg_temp.pass(r1 -> 'results' = r2 -> 'results' AND (SELECT count(*) FROM public.cloud_deal_checklist_items WHERE cloud_deal_id = pg_temp.id('D1')) = n0, 'replay'),
    pg_temp.pass(pg_temp.st(r3) = 'exists' AND (pg_temp.it(id)).note = 'AI later' AND (SELECT count(*) FROM public.cloud_deal_checklist_items WHERE cloud_deal_id = pg_temp.id('D1')) = n0,
                 'retried create ' || r3::text || ' note ' || (pg_temp.it(id)).note),
    pg_temp.pass(pg_temp.st(rm) = 'mapped' AND (pg_temp.r0(rm) ->> 'cloud_id')::uuid = pg_temp.id('my1'), 'my items ' || rm::text),
    pg_temp.pass(pg_temp.st(r4) = 'rejected' AND pg_temp.r0(r4) ->> 'reason' = 'parent_missing', 'parent ' || r4::text));
END $p$;

-- C15: one live My items checklist per deal, also against the earlier upload path
CREATE FUNCTION pg_temp.p_my_items_unique() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); r jsonb;
BEGIN
  r := pg_temp.up(A, 'cloud_upsert_checklists', pg_temp.id('I1'), pg_temp.id('D1'), jsonb_build_array(
         pg_temp.rw('my2', jsonb_build_object('template_id', 'keepr:my-items', 'template_name', 'My items'))));
  RETURN pg_temp.pass(r::text LIKE '%23505%', r::text);
END $p$;

-- the pull: conflict events, resync above the head, another install's rows, structure refusals
CREATE FUNCTION pg_temp.p_pull() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); i2 uuid := pg_temp.id('i2'); h0 bigint; p jsonb; pz jsonb; px jsonb; pi2 jsonb; big jsonb := '[]';
BEGIN
  h0 := pg_temp.head(A);
  PERFORM pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(i2, 'note', '"AI"')));
  PERFORM pg_temp.desk_note(i2, 'old', 1, interval '1 day', 3);
  PERFORM pg_temp.push(A, pg_temp.id('I1'), pg_temp.nowt(), jsonb_build_array(pg_temp.op_set(pg_temp.id('i1'), 'note', '"n"', 1, 5, pg_temp.nowt())));
  p := pg_temp.pull(A, pg_temp.id('I1'), h0, 500, pg_temp.hz(A));
  pz := pg_temp.pull(A, pg_temp.id('I1'), 0, 500);
  px := pg_temp.pull(A, pg_temp.id('I1'), pg_temp.head(A) + 1000, 500, pg_temp.hz(A));
  pi2 := pg_temp.pull(A, pg_temp.id('I2'), 0, 500);
  FOR n IN 1..201 LOOP big := big || pg_temp.op_set(i2, 'note', '"x"'); END LOOP;
  RETURN pg_temp.all_of(
    pg_temp.pass((SELECT count(*) FROM jsonb_array_elements(p -> 'rows') x WHERE x ->> 'entity' = 'event' AND x ->> 'outcome' = 'lost') = 1, 'event ' || p::text),
    pg_temp.pass((pz ->> 'resync_required')::boolean IS NOT TRUE AND (pz ->> 'next_after')::bigint = pg_temp.head(A), 'full ' || left(pz::text, 200)),
    pg_temp.pass((px ->> 'resync_required')::boolean, 'above head'),
    pg_temp.pass(pg_temp.pull(A, pg_temp.id('I1'), 3, 500) ->> 'error' = 'horizon_required', 'cursor without horizon'),
    pg_temp.pass(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(pi2 -> 'rows') x WHERE x ->> 'cloud_deal_id' = pg_temp.id('D1')::text OR x ->> 'cloud_id' = pg_temp.id('D1')::text), 'I2 sees I1 rows'),
    pg_temp.pass((pz ->> 'install_max_edit_seq')::bigint = 5, 'max edit_seq ' || (pz ->> 'install_max_edit_seq')),
    pg_temp.pass(pg_temp.ai(A, big) ->> 'error' = 'batch_too_large', '201 ops'),
    pg_temp.pass(pg_temp.ai(A, '[{"op_id":"nope","kind":"set"}]') ->> 'error' = 'invalid_input', 'bad op id'));
END $p$;

-- R10.3 and the grants rules, read from the catalogue
CREATE FUNCTION pg_temp.p_grants() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE bad text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO bad FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_cloud_todo_'
     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
          OR has_function_privilege('service_role', p.oid, 'EXECUTE') OR p.prosecdef);
  IF bad IS NOT NULL THEN RETURN 'FAIL: internal reachable or definer: ' || bad; END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO bad FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('cloud_todo_push', 'cloud_todo_pull', 'cloud_todo_history', 'cloud_todo_restore', 'cloud_list_removed',
                       'cloud_reclaim_install', 'cloud_install_status', 'cloud_purge_deal_now')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
          OR has_function_privilege('service_role', p.oid, 'EXECUTE') OR NOT p.prosecdef
          OR NOT (p.proconfig @> ARRAY['search_path=""']));
  IF bad IS NOT NULL THEN RETURN 'FAIL: rpc acl: ' || bad; END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('cloud_todo_push', 'cloud_todo_pull', 'cloud_todo_history', 'cloud_todo_restore', 'cloud_list_removed',
                          'cloud_reclaim_install', 'cloud_install_status', 'cloud_purge_deal_now')) <> 8 THEN RETURN 'FAIL: rpc count'; END IF;
  SELECT string_agg(c.relname || ':' || r.rolname, ', ') INTO bad FROM pg_class c CROSS JOIN pg_roles r
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('cloud_todo_feed_head', 'cloud_todo_history', 'cloud_todo_ops', 'cloud_removed_installs', 'cloud_todo_seq')
     AND r.rolname IN ('anon', 'authenticated', 'service_role')
     AND (CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(r.rolname, c.oid, 'USAGE,SELECT,UPDATE')
               ELSE has_table_privilege(r.rolname, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') END);
  IF bad IS NOT NULL THEN RETURN 'FAIL: table privileges: ' || bad; END IF;
  IF (SELECT bool_and(relrowsecurity) FROM pg_class WHERE relnamespace = 'public'::regnamespace
        AND relname IN ('cloud_todo_feed_head', 'cloud_todo_history', 'cloud_todo_ops', 'cloud_removed_installs')) IS NOT TRUE THEN RETURN 'FAIL: rls'; END IF;
  SELECT string_agg(x, ', ') INTO bad FROM (
    SELECT a.sig AS x FROM pg_temp.p4263_anon_before a WHERE a.sig NOT IN (SELECT p.oid::regprocedure::text FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('anon', p.oid, 'EXECUTE'))
    UNION ALL
    SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('anon', p.oid, 'EXECUTE')
       AND p.oid::regprocedure::text NOT IN (SELECT sig FROM pg_temp.p4263_anon_before)) y;
  IF bad IS NOT NULL THEN RETURN 'FAIL: anon-callable list changed: ' || bad; END IF;
  SELECT string_agg(p.proname, ', ') INTO bad FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('cloud_todo_pull', 'cloud_todo_history', 'cloud_list_removed', 'cloud_install_status', 'cloud_list_install_rows', 'cloud_list_installs')
     AND p.provolatile <> 's';
  IF bad IS NOT NULL THEN RETURN 'FAIL: not STABLE: ' || bad; END IF;
  SELECT string_agg(p.proname, ', ') INTO bad FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('_mcp_r_list_deals', '_mcp_r_get_deal', '_mcp_r_deal_checklists')
     AND (p.provolatile <> 's' OR pg_get_userbyid(p.proowner) <> 'mcp_reader' OR NOT p.prosecdef);
  IF bad IS NOT NULL THEN RETURN 'FAIL: readers: ' || bad; END IF;
  SELECT string_agg(p.proname, ', ') INTO bad FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname ~ '^_?mcp_' AND (p.prosrc ~ 'cloud_purge_deal_now' OR p.prosrc ~ '_cloud_todo_purge');
  IF bad IS NOT NULL THEN RETURN 'FAIL: an mcp function names the purge: ' || bad; END IF;
  RETURN 'PASS';
END $p$;

-- C26: only the allocator reads the sequence; every function that writes change_seq takes its number from it
-- (p_seq_catalog: rewritten below)

-- lock order: the head is taken after settings and before any deal row lock (catalogue text order)
-- (p_lock_order: rewritten below)

-- the earlier one-way path still works after the migration (a desktop built from this branch)
CREATE FUNCTION pg_temp.p_old_path() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb;
BEGIN
  r1 := pg_temp.up(A, 'cloud_upsert_checklist_items', pg_temp.id('I1'), pg_temp.id('D1'), jsonb_build_array(
          pg_temp.rw('i2', jsonb_build_object('local_checklist_id', 'cl1', 'title', 'Appraisal', 'note', 'edited old path', 'sort_order', 2))));
  r2 := pg_temp.j(pg_temp.call_as(A, format('SELECT public.cloud_tombstone(%L::uuid, %L::uuid, %L, %L::uuid[])', A, pg_temp.id('I1'), 'checklist_item', ARRAY[pg_temp.id('m1')])));
  r3 := pg_temp.up(A, 'cloud_upsert_parties', pg_temp.id('I1'), pg_temp.id('D1'), jsonb_build_array(pg_temp.rw('p1', jsonb_build_object('display_name', 'Fixture Person'))));
  r4 := pg_temp.j(pg_temp.call_as(A, format('SELECT public.cloud_mark_deal_synced(%L::uuid, %L::uuid, %L::uuid)', A, pg_temp.id('I1'), pg_temp.id('D1'))));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.st(r1) = 'applied' AND (pg_temp.it(pg_temp.id('i2'))).note = 'edited old path', 'items ' || r1::text),
    pg_temp.pass(pg_temp.st(r2) = 'removed', 'tombstone ' || r2::text),
    pg_temp.pass(pg_temp.st(r3) = 'applied', 'parties ' || r3::text),
    pg_temp.pass(r4 ->> 'ok' = 'true', 'mark ' || r4::text));
END $p$;

-- install-scoped writers of the one-way path: install_removed for a removed install, not_found for a
-- soft-removed deal; cloud_tombstone refuses a removed install and still records removals on a removed deal
CREATE FUNCTION pg_temp.p_gates() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); I1 uuid := pg_temp.id('I1'); I2 uuid := pg_temp.id('I2'); D2 uuid := pg_temp.id('D2'); D3 uuid := pg_temp.id('D3');
        res text[] := '{}'; c record; r jsonb; n0 bigint; n1 bigint;
BEGIN
  PERFORM pg_temp.delinst(A, I2);
  PERFORM pg_temp.deldeal(A, D2);
  n0 := (SELECT (SELECT count(*) FROM public.cloud_deal_parties WHERE owner_user_id = A) + (SELECT count(*) FROM public.cloud_deal_checklists WHERE owner_user_id = A)
              + (SELECT count(*) FROM public.cloud_deal_checklist_items WHERE owner_user_id = A) + (SELECT count(*) FROM public.cloud_deal_messages WHERE owner_user_id = A)
              + (SELECT count(*) FROM public.cloud_deal_files WHERE owner_user_id = A));
  FOR c IN SELECT * FROM (VALUES
      ('cloud_upsert_parties', jsonb_build_array(pg_temp.rw('gp', '{}'))),
      ('cloud_upsert_checklists', jsonb_build_array(pg_temp.rw('gc', '{"template_id":"t"}'))),
      ('cloud_upsert_checklist_items', jsonb_build_array(pg_temp.rw('gi', '{"local_checklist_id":"cl2","title":"g"}'))),
      ('cloud_upsert_messages', jsonb_build_array(pg_temp.rw('gm', '{"channel_kind":"email","hidden_from_export":false}'))),
      ('cloud_upsert_files', jsonb_build_array(pg_temp.rw('gf', '{"filename":"g.pdf"}')))) v(fn, rows) LOOP
    r := pg_temp.up(A, c.fn, I2, D3, c.rows);
    res := res || pg_temp.pass(r ->> 'error' = 'install_removed', c.fn || ' removed install: ' || r::text);
    r := pg_temp.up(A, c.fn, I1, D2, c.rows);
    res := res || pg_temp.pass(r ->> 'error' = 'not_found', c.fn || ' removed deal: ' || r::text);
  END LOOP;
  r := pg_temp.j(pg_temp.call_as(A, format('SELECT public.cloud_mark_deal_synced(%L::uuid, %L::uuid, %L::uuid)', A, I2, D3)));
  res := res || pg_temp.pass(r ->> 'error' = 'install_removed', 'mark removed install: ' || r::text);
  r := pg_temp.j(pg_temp.call_as(A, format('SELECT public.cloud_mark_deal_synced(%L::uuid, %L::uuid, %L::uuid)', A, I1, D2)));
  res := res || pg_temp.pass(r ->> 'error' = 'not_found', 'mark removed deal: ' || r::text);
  r := pg_temp.j(pg_temp.call_as(A, format('SELECT public.cloud_tombstone(%L::uuid, %L::uuid, %L, %L::uuid[])', A, I2, 'checklist_item', ARRAY[pg_temp.id('i4')])));
  res := res || pg_temp.pass(r ->> 'error' = 'install_removed' AND (pg_temp.it(pg_temp.id('i4'))).removed_at IS NULL, 'tombstone removed install: ' || r::text);
  n1 := (SELECT (SELECT count(*) FROM public.cloud_deal_parties WHERE owner_user_id = A) + (SELECT count(*) FROM public.cloud_deal_checklists WHERE owner_user_id = A)
              + (SELECT count(*) FROM public.cloud_deal_checklist_items WHERE owner_user_id = A) + (SELECT count(*) FROM public.cloud_deal_messages WHERE owner_user_id = A)
              + (SELECT count(*) FROM public.cloud_deal_files WHERE owner_user_id = A));
  res := res || pg_temp.pass(n1 = n0 AND (SELECT removed_at IS NOT NULL FROM public.cloud_deals WHERE id = D2) AND (SELECT removed_at IS NOT NULL FROM public.cloud_deals WHERE id = D3),
                             'rows ' || n0 || '->' || n1);
  r := pg_temp.j(pg_temp.call_as(A, format('SELECT public.cloud_tombstone(%L::uuid, %L::uuid, %L, %L::uuid[])', A, I1, 'checklist_item', ARRAY[pg_temp.id('i3')])));
  res := res || pg_temp.pass(pg_temp.st(r) = 'removed', 'tombstone on a removed deal records the removal: ' || r::text);
  r := pg_temp.up(A, 'cloud_upsert_parties', I1, pg_temp.id('D1'), jsonb_build_array(pg_temp.rw('gp', '{}')));
  res := res || pg_temp.pass(pg_temp.st(r) = 'applied', 'live deal still written: ' || r::text);
  RETURN pg_temp.all_of(VARIADIC res);
END $p$;

-- catalogue: every install-scoped or deal-scoped writer carries the gates; the register helper is not reachable
CREATE FUNCTION pg_temp.p_gate_catalog() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE bad text; bad2 text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO bad FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.provolatile = 'v'
     AND ('p_source_install_id' = ANY (p.proargnames) OR 'p_cloud_deal_id' = ANY (p.proargnames) OR p.proname = 'cloud_upsert_deal')
     AND p.proname NOT IN ('cloud_delete_install', 'cloud_reclaim_install', 'cloud_delete_deal', 'cloud_purge_deal_now')
     AND p.prosrc !~ '_cloud_install_removed\(';
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO bad2 FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.provolatile = 'v' AND 'p_cloud_deal_id' = ANY (p.proargnames)
     AND p.proname NOT IN ('cloud_delete_deal', 'cloud_purge_deal_now')
     AND p.prosrc !~ 'd\.removed_at IS NULL';
  RETURN pg_temp.all_of(
    pg_temp.pass(bad IS NULL, 'writers without the install gate: ' || coalesce(bad, '')),
    pg_temp.pass(bad2 IS NULL, 'deal writers without the live-deal gate: ' || coalesce(bad2, '')),
    pg_temp.pass(NOT has_function_privilege('authenticated', 'public._cloud_install_removed(uuid,uuid)', 'EXECUTE')
                 AND NOT has_function_privilege('anon', 'public._cloud_install_removed(uuid,uuid)', 'EXECUTE'), 'helper reachable'));
END $p$;

-- malformed ids are answered per op; the rest of the batch still applies
CREATE FUNCTION pg_temp.p_bad_ids() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); r jsonb; s text := pg_temp.nowt();
BEGIN
  r := pg_temp.push(A, pg_temp.id('I1'), s, jsonb_build_array(
         jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'set', 'entity', 'item', 'id', 'abc', 'part', 'note', 'value', 'x', 'edited_at', s),
         jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_item', 'deal_id', 'abc', 'checklist_local_id', 'cl1', 'local_id', 'b1', 'title', 'x', 'edited_at', s),
         jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'set', 'entity', 'item', 'deal_id', 'abc', 'local_id', 'i2', 'part', 'note', 'value', 'x', 'edited_at', s),
         jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_checklist', 'deal_id', 'abc', 'local_id', 'c9', 'template_id', 't', 'edited_at', s),
         pg_temp.op_set(pg_temp.id('i2'), 'note', '"good"', 1, 1, s)));
  RETURN pg_temp.pass(r ->> 'ok' = 'true' AND pg_temp.st(r, 0) = 'not_found' AND pg_temp.st(r, 1) = 'not_found' AND pg_temp.st(r, 2) = 'not_found'
                      AND pg_temp.st(r, 3) = 'not_found' AND pg_temp.st(r, 4) = 'applied', r::text);
END $p$;


-- C26 (R5): every statement that assigns change_seq takes the number from the allocator in that statement;
-- only the allocator reads the sequence
CREATE FUNCTION pg_temp.p_seq_catalog() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE bad text := ''; who text; r record; st text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO who FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc ~ 'cloud_todo_seq\M';
  IF who IS DISTINCT FROM '_cloud_todo_take_seq' THEN RETURN 'FAIL: sequence readers: ' || coalesce(who, 'none'); END IF;
  FOR r IN SELECT p.proname, p.prosrc FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc ~ 'change_seq' LOOP
    FOREACH st IN ARRAY regexp_split_to_array(r.prosrc, ';') LOOP
      IF (st ~* 'change_seq\s*=[^=]' OR st ~* 'insert\s+into\s+public\.cloud_(deals|deal_checklists|deal_checklist_items|todo_history)\s*\([^)]*change_seq')
         AND st !~ '_cloud_todo_take_seq\(' THEN
        bad := bad || r.proname || ': ' || left(regexp_replace(st, '\s+', ' ', 'g'), 120) || ' | ';
      END IF;
    END LOOP;
  END LOOP;
  RETURN pg_temp.pass(bad = '', 'change_seq written without the allocator in the same statement: ' || bad);
END $p$;

-- lock order (R5): in every writer that takes the head, per branch: settings before the head, the head before
-- any deal row lock or write
CREATE FUNCTION pg_temp.p_lock_order() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE r record; s text; bad text := ''; blk text; a int; b int; c int;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.cloud_upsert_deal(uuid,jsonb)', 'public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE', 'PERFORM public._cloud_todo_take_seq(v_uid, 0);', 'INSERT INTO public.cloud_deals'),
      ('public.cloud_upsert_deal(uuid,jsonb)', 'public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE', 'PERFORM public._cloud_todo_take_seq(v_uid, 0);', 'x.local_transaction_id = v_local FOR UPDATE'),
      ('public.cloud_delete_deal(uuid,uuid)', 'public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE', 'PERFORM public._cloud_todo_take_seq(v_uid, 0);', 'FOR UPDATE;'),
      ('public.cloud_delete_install(uuid,uuid)', 'public.cloud_autosave_settings WHERE user_id = v_uid FOR UPDATE', 'PERFORM public._cloud_todo_take_seq(v_uid, 0);', 'ORDER BY d.id FOR UPDATE'),
      ('public.cloud_todo_restore(uuid,text,uuid,uuid)', 'public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE', 'PERFORM public._cloud_todo_take_seq(v_uid, 0);', 'WHERE x.id = p_id AND x.owner_user_id = v_uid FOR UPDATE'),
      ('public._cloud_todo_purge_deal(uuid,uuid)', 'IF p_owner IS NULL', 'PERFORM public._cloud_todo_take_seq(p_owner, 0);', 'WHERE d.id = p_deal AND d.owner_user_id = p_owner FOR UPDATE'),
      ('public.cloud_purge_deal_now(uuid,uuid)', 'public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE', 'NOT EXISTS (SELECT 1 FROM public.cloud_deals d', 'public._cloud_todo_purge_deal(v_uid'),
      ('public._cloud_todo_purge()', 'FOR v_owner IN', 'FOR UPDATE SKIP LOCKED', 'public._cloud_todo_purge_deal(v_owner'),
      ('public.set_my_cloud_autosave(uuid,boolean,integer)', 'public.cloud_autosave_settings WHERE user_id = v_uid FOR UPDATE', 'h.owner_user_id = v_uid FOR UPDATE', 'DELETE FROM public.cloud_deals')) v(sig, first, head, deal) LOOP
    SELECT prosrc INTO s FROM pg_proc WHERE oid = to_regprocedure(r.sig);
    a := position(r.first IN s); b := position(r.head IN s); c := position(r.deal IN s);
    IF NOT (a > 0 AND b > a AND c > b) THEN bad := bad || r.sig || format(' first@%s head@%s deal@%s; ', a, b, c); END IF;
  END LOOP;
  -- the core: both arms of the head step take the head, and nothing locks a row before the step ends
  SELECT prosrc INTO s FROM pg_proc WHERE oid = to_regprocedure('public._cloud_todo_apply(uuid,jsonb,jsonb)');
  a := position('IF v_kind = ''ai_app'' THEN' IN s); c := position('/*CORE:lockdeals*/' IN s);
  blk := substr(s, a, c - a);
  IF a = 0 OR (length(blk) - length(replace(blk, 'PERFORM public._cloud_todo_take_seq(p_owner, 0);', ''))) / length('PERFORM public._cloud_todo_take_seq(p_owner, 0);') <> 2
     OR position('FOR UPDATE' IN substr(s, 1, a)) > 0 THEN
    bad := bad || '_cloud_todo_apply: head not taken in both arms before the row locks; ';
  END IF;
  RETURN pg_temp.pass(bad = '', bad);
END $p$;

-- R1: a paged full pull across a purge horizon finishes; a stale cursor resyncs; a purge between two pages resyncs
CREATE FUNCTION pg_temp.p_resync() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); I1 uuid := pg_temp.id('I1'); r jsonb; pa jsonb; p1 jsonb; p2 jsonb; old_cursor bigint; old_hz bigint; st jsonb; f bigint; cu jsonb;
BEGIN
  -- a cursor that was current before the purge
  PERFORM pg_temp.deldeal(A, pg_temp.id('D2'));
  UPDATE public.cloud_deals SET restorable_until = now() - interval '1 day' WHERE id = pg_temp.id('D2');
  p1 := pg_temp.pull(A, I1, 0, 500);
  old_cursor := 2; old_hz := (p1 ->> 'horizon')::bigint;
  PERFORM pg_temp.clear_claims();
  r := public._cloud_todo_purge();
  f := (SELECT forgotten_through_seq FROM public.cloud_todo_feed_head WHERE owner_user_id = A);
  pa := pg_temp.pull_all(A, I1, 0, 1);
  st := pg_temp.pull(A, I1, old_cursor, 500, old_hz);
  cu := pg_temp.pull(A, I1, (p1 ->> 'next_after')::bigint, 500, old_hz);   -- caught up before the purge: everything deleted is below it
  -- a purge between two pages of a full pull
  p1 := pg_temp.pull(A, I1, 0, 1);
  PERFORM pg_temp.push(A, I1, pg_temp.nowt(), jsonb_build_array(pg_temp.op('remove', 'item', pg_temp.id('i2'), pg_temp.nowt())));
  UPDATE public.cloud_deal_checklist_items SET removed_at = now() - interval '31 days' WHERE id = pg_temp.id('i2');
  UPDATE public.cloud_deal_checklist_items SET purged_at = now() - interval '366 days' WHERE id = pg_temp.id('i3');
  r := public._cloud_todo_purge();
  p2 := pg_temp.pull(A, I1, (p1 ->> 'next_after')::bigint, 1, (p1 ->> 'horizon')::bigint);
  RETURN pg_temp.all_of(
    pg_temp.pass((pa ->> 'resync')::boolean IS NOT TRUE AND (pa ->> 'pages')::int > 3, 'limit-1 full pull after purge: ' || left(pa::text, 200) || ' forgotten ' || f),
    pg_temp.pass((st ->> 'resync_required')::boolean, 'stale cursor ' || old_cursor || '/' || old_hz || ' forgotten ' || f || ': ' || left(st::text, 120)),
    pg_temp.pass((p2 ->> 'resync_required')::boolean, 'purge between pages: ' || left(p2::text, 160) || ' page1 ' || left(p1::text, 80)),
    pg_temp.pass((cu ->> 'resync_required')::boolean IS NOT TRUE AND (cu ->> 'horizon')::bigint > old_hz, 'caught-up cursor after a purge: ' || left(cu::text, 120)));
END $p$;

-- R5: the horizon moves for tombstone and history deletes on their own (no deal purged)
CREATE FUNCTION pg_temp.p_purge_horizon() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); i3 uuid := pg_temp.id('i3'); i1 uuid := pg_temp.id('i1'); f0 bigint; f1 bigint; f2 bigint; s3 bigint; hmax bigint; r jsonb;
BEGIN
  UPDATE public.cloud_deal_checklist_items SET purged_at = now() - interval '366 days', removed_at = now() - interval '400 days' WHERE id = i3;
  s3 := (SELECT change_seq FROM public.cloud_deal_checklist_items WHERE id = i3);
  f0 := (SELECT forgotten_through_seq FROM public.cloud_todo_feed_head WHERE owner_user_id = A);
  PERFORM pg_temp.clear_claims();
  r := public._cloud_todo_purge();
  f1 := (SELECT forgotten_through_seq FROM public.cloud_todo_feed_head WHERE owner_user_id = A);
  FOR n IN 1..52 LOOP
    PERFORM public._cloud_todo_hist(A, pg_temp.id('D1'), 'item', i1, 'change', 'note', NULL, to_jsonb(n), 'applied',
              '{"kind":"desktop"}'::jsonb, NULL, now(), now() - interval '40 days', NULL);
  END LOOP;
  hmax := (SELECT max(change_seq) FROM (SELECT change_seq FROM public.cloud_todo_history WHERE entity_id = i1 ORDER BY change_seq LIMIT 2) x);
  r := public._cloud_todo_purge();
  f2 := (SELECT forgotten_through_seq FROM public.cloud_todo_feed_head WHERE owner_user_id = A);
  RETURN pg_temp.all_of(
    pg_temp.pass(NOT EXISTS (SELECT 1 FROM public.cloud_deal_checklist_items WHERE id = i3) AND f1 >= s3 AND f1 > f0, format('tombstone: seq %s f0 %s f1 %s', s3, f0, f1)),
    pg_temp.pass((SELECT count(*) FROM public.cloud_todo_history WHERE entity_id = i1) = 50 AND f2 >= hmax, format('history: left %s max deleted %s f2 %s',
                 (SELECT count(*) FROM public.cloud_todo_history WHERE entity_id = i1), hmax, f2)));
END $p$;

-- R6: with Keepr Cloud off, the removal calls write nothing; turning it on again is not refused
CREATE FUNCTION pg_temp.p_off_writes() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); I1 uuid := pg_temp.id('I1'); di jsonb; dd jsonb; pn jsonb; up jsonb; reg int; hd int;
BEGIN
  PERFORM pg_temp.onoff(A, false);
  di := pg_temp.delinst(A, I1);
  dd := pg_temp.deldeal(A, pg_temp.id('D1'));
  pn := pg_temp.rpc(A, format('SELECT public.cloud_purge_deal_now(%L::uuid, %L::uuid)', A, pg_temp.id('D1')));
  reg := (SELECT count(*) FROM public.cloud_removed_installs WHERE owner_user_id = A);
  hd := (SELECT count(*) FROM public.cloud_todo_feed_head WHERE owner_user_id = A);
  PERFORM pg_temp.onoff(A, true);
  up := pg_temp.deal(A, pg_temp.dp(I1, 'fresh'));
  RETURN pg_temp.all_of(
    pg_temp.pass(di ->> 'success' = 'true' AND di ->> 'deleted_deals' = '0' AND dd ->> 'error' = 'not_found' AND pn ->> 'status' = 'not_found',
                 di::text || dd::text || pn::text),
    pg_temp.pass(reg = 0 AND hd = 0, format('register %s head %s', reg, hd)),
    pg_temp.pass(pg_temp.st(up) = 'applied', 'upload after on: ' || up::text));
END $p$;

-- R3: every field of every op type fed a wrong JSON type is refused for that op alone; the batch goes on
CREATE FUNCTION pg_temp.p_types() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); s text := pg_temp.nowt(); ops jsonb := '[]'; want jsonb := '[]'; base jsonb; c record; r jsonb; res text[] := '{}'; k int := 0;
BEGIN
  FOR c IN SELECT * FROM (VALUES
      ('set', 'entity', '5'), ('set', 'id', '5'), ('set', 'part', '5'), ('set', 'base_rev', '"x"'), ('set', 'base_rev', '1.5'), ('set', 'edit_seq', '"x"'),
      ('set', 'edit_seq', '2.5'), ('set', 'clock_stepped', '"x"'), ('set', 'held_locked', '"x"'), ('set', 'value', '5'),
      ('create_item', 'deal_id', '5'), ('create_item', 'checklist_local_id', '7'), ('create_item', 'local_id', '7'), ('create_item', 'title', '5'),
      ('create_item', 'note', '5'), ('create_item', 'due_date', '5'), ('create_item', 'done', '5'), ('create_item', 'sort_order', '"x"'),
      ('create_item', 'description', '5'), ('create_item', 'is_required', '"x"'), ('create_item', 'expected_document_type', '5'),
      ('create_item', 'local_created_at', 'true'), ('create_item', 'edit_seq', '"x"'),
      ('create_checklist', 'deal_id', '5'), ('create_checklist', 'local_id', '5'), ('create_checklist', 'template_id', 'true'),
      ('create_checklist', 'template_name', '5'), ('create_checklist', 'sort_order', '"x"'), ('create_checklist', 'is_private', '"maybe"'),
      ('remove', 'entity', '5'), ('remove', 'id', '{}'), ('restore', 'entity', '5'), ('restore', 'id', '[]')) v(kind, field, bad) LOOP
    k := k + 1;
    base := CASE c.kind
      WHEN 'set' THEN jsonb_build_object('kind', 'set', 'entity', 'item', 'id', pg_temp.id('i1'), 'part', 'note', 'value', 'x', 'base_rev', 1, 'edit_seq', 1)
      WHEN 'create_item' THEN jsonb_build_object('kind', 'create_item', 'deal_id', pg_temp.id('D1'), 'checklist_local_id', 'cl1', 'local_id', 'ty-' || k, 'title', 'T' || k)
      WHEN 'create_checklist' THEN jsonb_build_object('kind', 'create_checklist', 'deal_id', pg_temp.id('D1'), 'local_id', 'tc-' || k, 'template_id', 't' || k)
      ELSE jsonb_build_object('kind', c.kind, 'entity', 'item', 'id', pg_temp.id('m1')) END;
    ops := ops || (base || jsonb_build_object('op_id', gen_random_uuid(), 'edited_at', s, c.field, c.bad::jsonb));
    want := want || to_jsonb(c.kind || '.' || c.field);
  END LOOP;
  ops := ops || pg_temp.op_set(pg_temp.id('i2'), 'note', '"good"', 1, 1, s);
  r := pg_temp.push(A, pg_temp.id('I1'), s, ops);
  IF r ->> 'ok' IS DISTINCT FROM 'true' THEN RETURN 'FAIL: batch refused: ' || left(r::text, 300); END IF;
  FOR n IN 0..jsonb_array_length(want) - 1 LOOP
    res := res || pg_temp.pass(pg_temp.st(r, n) = 'rejected', (want ->> n) || ' -> ' || coalesce(pg_temp.st(r, n), 'null') || ' ' || coalesce(pg_temp.r0(r, n) ->> 'field', ''));
  END LOOP;
  res := res || pg_temp.pass(pg_temp.st(r, jsonb_array_length(want)) = 'applied' AND (pg_temp.it(pg_temp.id('i2'))).note = 'good', 'good op');
  res := res || pg_temp.pass((SELECT count(*) FROM public.cloud_deal_checklist_items WHERE local_item_id LIKE 'ty-%') = 0
                             AND (SELECT count(*) FROM public.cloud_deal_checklists WHERE local_checklist_id LIKE 'tc-%') = 0, 'nothing created by a refused op');
  RETURN pg_temp.all_of(VARIADIC res);
END $p$;

-- R7: every mcp_reader-owned function that reads cloud_deals filters removed deals at each read, except the
-- install numbering read marked KEEP_REMOVED
CREATE FUNCTION pg_temp.p_reader_catalog() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE r record; parts text[]; bad text := ''; n int := 0;
BEGIN
  FOR r IN SELECT p.proname, p.prosrc FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
              AND pg_get_userbyid(p.proowner) = 'mcp_reader' AND p.prosrc ~ 'public\.cloud_deals\M' LOOP
    n := n + 1;
    parts := regexp_split_to_array(r.prosrc, 'public\.cloud_deals\M(?!%ROWTYPE)');
    FOR i IN 2..cardinality(parts) LOOP
      IF left(parts[i], 420) !~ 'removed_at IS NULL' AND left(parts[i], 420) !~ 'KEEP_REMOVED:install_numbering' THEN
        bad := bad || r.proname || '#' || (i - 1) || ' ';
      END IF;
    END LOOP;
  END LOOP;
  RETURN pg_temp.pass(bad = '' AND n >= 4, format('readers %s, reads without the filter: %s', n, bad));
END $p$;

-- R7: list_all_deals does not return a soft-removed deal; its shape is unchanged
CREATE FUNCTION pg_temp.p_list_all() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); D2 uuid := pg_temp.id('D2'); r0 jsonb; r1 jsonb; ids0 text[]; ids1 text[];
BEGIN
  r0 := pg_temp.j(pg_temp.as_user(A, 'SELECT public._mcp_r_list_all_deals(NULL, NULL, NULL, NULL)'));
  PERFORM pg_temp.deldeal(A, D2);
  r1 := pg_temp.j(pg_temp.as_user(A, 'SELECT public._mcp_r_list_all_deals(NULL, NULL, NULL, NULL)'));
  SELECT array_agg(x ->> 0) INTO ids0 FROM jsonb_array_elements(r0 -> 'rows') x;
  SELECT array_agg(x ->> 0) INTO ids1 FROM jsonb_array_elements(r1 -> 'rows') x;
  RETURN pg_temp.all_of(
    pg_temp.pass(D2::text = ANY (ids0) AND NOT (D2::text = ANY (coalesce(ids1, '{}'))), 'before ' || array_to_string(ids0, ',') || ' after ' || coalesce(array_to_string(ids1, ','), '')),
    pg_temp.pass(pg_temp.keys(r1) = pg_temp.keys(r0) AND r1 -> 'columns' = r0 -> 'columns' AND r1 ->> 'kind' = 'keepr.list_all_deals', 'shape'));
END $p$;
CREATE FUNCTION pg_temp.keys(o jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE AS $h$
  SELECT coalesce(array_agg(k ORDER BY k COLLATE "C"), ARRAY[]::text[]) FROM jsonb_object_keys(o) k
$h$;

-- R2 (SR): two desktop ops on one part of a removed item arriving out of order: the later edit stays
CREATE FUNCTION pg_temp.sr_removed_reorder() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); I1 uuid := pg_temp.id('I1'); i2 uuid := pg_temp.id('i2'); r0 jsonb; r1 jsonb; r2 jsonb;
BEGIN
  r0 := pg_temp.push(A, I1, pg_temp.nowt(), jsonb_build_array(pg_temp.op('remove', 'item', i2, pg_temp.nowt())));
  r1 := pg_temp.push(A, I1, pg_temp.nowt(), jsonb_build_array(pg_temp.op_set(i2, 'note', '"later edit"', 1, 3, pg_temp.nowt('-1 minute'))));
  r2 := pg_temp.push(A, I1, pg_temp.nowt(), jsonb_build_array(pg_temp.op_set(i2, 'note', '"earlier edit"', 1, 2, pg_temp.nowt('-10 minutes'))));
  RETURN pg_temp.pass((pg_temp.it(i2)).note = 'later edit' AND pg_temp.st(r1) = 'applied_to_removed' AND pg_temp.st(r2) = 'lost'
                      AND (pg_temp.it(i2)).removed_at IS NOT NULL,
    format('remove=%s first=%s second=%s final note=%s', pg_temp.st(r0), pg_temp.st(r1), pg_temp.st(r2), (pg_temp.it(i2)).note));
END $p$;

-- R3 (SR): a bad boolean in one op is answered for that op only
CREATE FUNCTION pg_temp.sr_bad_boolean_aborts() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); I1 uuid := pg_temp.id('I1'); r jsonb;
BEGIN
  r := pg_temp.push(A, I1, pg_temp.nowt(), jsonb_build_array(
         pg_temp.op_set(pg_temp.id('i1'), 'note', '"good op"', 1, 1, pg_temp.nowt()),
         jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_checklist', 'deal_id', pg_temp.id('D1'), 'local_id', 'bad-cl',
                            'template_id', 'tpl-y', 'is_private', 'maybe', 'edited_at', pg_temp.nowt())));
  RETURN pg_temp.pass(pg_temp.st(r) = 'applied' AND pg_temp.st(r, 1) = 'rejected', 'batch answer: ' || left(r::text, 300));
END $p$;

-- R4 (SR + not_found): an order-dependent refusal is not kept; the same op_id is evaluated again later
CREATE FUNCTION pg_temp.sr_ledger_transient() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); I1 uuid := pg_temp.id('I1'); D1 uuid := pg_temp.id('D1'); op jsonb; op2 jsonb; r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb; d jsonb; ok jsonb; okr jsonb;
BEGIN
  op := jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_item', 'deal_id', D1, 'checklist_local_id', 'later-cl',
                           'local_id', 'later-it', 'title', 'Waits for its list', 'edited_at', pg_temp.nowt());
  r1 := pg_temp.push(A, I1, pg_temp.nowt(), jsonb_build_array(op));
  PERFORM pg_temp.push(A, I1, pg_temp.nowt(), jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_checklist',
           'deal_id', D1, 'local_id', 'later-cl', 'template_id', 'tpl-x', 'template_name', 'Later', 'edited_at', pg_temp.nowt())));
  r2 := pg_temp.push(A, I1, pg_temp.nowt(), jsonb_build_array(op));
  -- not_found: the deal header is uploaded after the op was first sent
  op2 := jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'set', 'entity', 'item', 'deal_id', D1, 'local_id', 'late-x',
                            'part', 'note', 'value', 'set later', 'base_rev', 1, 'edit_seq', 1, 'edited_at', pg_temp.nowt());
  r3 := pg_temp.push(A, I1, pg_temp.nowt(), jsonb_build_array(op2));
  PERFORM pg_temp.up(A, 'cloud_upsert_checklist_items', I1, D1, jsonb_build_array(pg_temp.rw('late-x', '{"local_checklist_id":"cl1","title":"Late"}')));
  r4 := pg_temp.push(A, I1, pg_temp.nowt(), jsonb_build_array(op2));
  -- an applied answer is still replayed exactly
  ok := pg_temp.op_set(pg_temp.id('i1'), 'note', '"once"', 1, 1, pg_temp.nowt());
  okr := pg_temp.push(A, I1, pg_temp.nowt(), jsonb_build_array(ok));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.r0(r1) ->> 'reason' = 'parent_missing' AND pg_temp.st(r2) = 'added', format('parent_missing then %s', pg_temp.st(r2))),
    pg_temp.pass(pg_temp.st(r3) = 'not_found' AND pg_temp.st(r4) = 'applied', format('not_found then %s', pg_temp.st(r4))),
    pg_temp.pass(pg_temp.push(A, I1, pg_temp.nowt(), jsonb_build_array(ok || '{"value":"twice"}')) -> 'results' = okr -> 'results', 'applied replay'));
END $p$;

-- S1: an AI app cannot restore a checklist, nor (switch off) a brokerage checklist item; it can restore My items
CREATE FUNCTION pg_temp.p_ai_restore() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); I1 uuid := pg_temp.id('I1'); r1 jsonb; r2 jsonb; r3 jsonb; o1 jsonb;
BEGIN
  PERFORM pg_temp.push(A, I1, pg_temp.nowt(), jsonb_build_array(pg_temp.op('remove', 'item', pg_temp.id('i1'), pg_temp.nowt())));
  r1 := pg_temp.ai(A, jsonb_build_array(pg_temp.op('restore', 'item', pg_temp.id('i1'))));
  PERFORM pg_temp.ai(A, jsonb_build_array(pg_temp.op('remove', 'item', pg_temp.id('m1'))));
  r3 := pg_temp.ai(A, jsonb_build_array(pg_temp.op('restore', 'item', pg_temp.id('m1'))));
  PERFORM pg_temp.push(A, I1, pg_temp.nowt(), jsonb_build_array(pg_temp.op('remove', 'checklist', pg_temp.id('cl1'), pg_temp.nowt())));
  r2 := pg_temp.ai(A, jsonb_build_array(pg_temp.op('restore', 'checklist', pg_temp.id('cl1'))));
  o1 := pg_temp.rpc(A, format('SELECT public.cloud_todo_restore(%L::uuid, %L, %L::uuid)', A, 'checklist', pg_temp.id('cl1')));
  RETURN pg_temp.all_of(pg_temp.pass(pg_temp.st(r1) = 'not_allowed', 'template item ' || r1::text),
                        pg_temp.pass(pg_temp.st(r2) = 'not_allowed', 'checklist ' || r2::text),
                        pg_temp.pass(pg_temp.st(r3) = 'restored', 'my item ' || r3::text),
                        pg_temp.pass(pg_temp.st(o1) = 'restored', 'owner restores the checklist ' || o1::text));
END $p$;

-- S2: AI ops on a deal the readers hide (not confirmed) answer not_found
CREATE FUNCTION pg_temp.p_ai_unconfirmed() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); r1 jsonb; r2 jsonb; r3 jsonb;
BEGIN
  UPDATE public.cloud_deals SET is_confirmed = false WHERE id = pg_temp.id('D1');
  r1 := pg_temp.ai(A, jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'kind', 'create_item', 'deal_id', pg_temp.id('D1'), 'title', 'From AI')));
  r2 := pg_temp.ai(A, jsonb_build_array(pg_temp.op_set(pg_temp.id('m1'), 'note', '"x"')));
  -- the owner can still restore on that deal (cloud_list_removed lists it)
  PERFORM pg_temp.push(A, pg_temp.id('I1'), pg_temp.nowt(), jsonb_build_array(pg_temp.op('remove', 'item', pg_temp.id('m1'), pg_temp.nowt())));
  r3 := pg_temp.rpc(A, format('SELECT public.cloud_todo_restore(%L::uuid, %L, %L::uuid)', A, 'item', pg_temp.id('m1')));
  RETURN pg_temp.all_of(
    pg_temp.pass(pg_temp.st(r1) = 'not_found' AND pg_temp.st(r2) = 'not_found' AND (pg_temp.it(pg_temp.id('m1'))).note IS NULL, r1::text || r2::text),
    pg_temp.pass(pg_temp.st(r3) = 'restored', 'owner restore on an unconfirmed deal: ' || r3::text));
END $p$;

-- S3: a deal removed on its own, then its install removed: restoring the deal answers install_removed and changes nothing
CREATE FUNCTION pg_temp.p_restore_under_removed_install() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); D3 uuid := pg_temp.id('D3'); rr jsonb;
BEGIN
  PERFORM pg_temp.deldeal(A, D3);
  PERFORM pg_temp.delinst(A, pg_temp.id('I2'));
  rr := pg_temp.rpc(A, format('SELECT public.cloud_todo_restore(%L::uuid, %L, %L::uuid)', A, 'deal', D3));
  RETURN pg_temp.pass(pg_temp.st(rr) = 'install_removed' AND (SELECT removed_at IS NOT NULL FROM public.cloud_deals WHERE id = D3), rr::text);
END $p$;



-- DR1 (SR d1_masked_deletion): a tombstone deleted after the cursor's horizon, while the horizon's highest number
-- stays above it, must still resync the cursor
CREATE FUNCTION pg_temp.dr1_masked_deletion() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); I1 uuid := pg_temp.id('I1'); i2 uuid := pg_temp.id('i2'); i1x uuid := pg_temp.id('i1');
        a0 bigint; h0 bigint; s_tomb bigint; r jsonb; p1 jsonb; p2 jsonb; full0 jsonb; got boolean; f_before bigint; f_after bigint;
BEGIN
  full0 := pg_temp.pull(A, I1, 0, 500, NULL);
  a0 := (full0 ->> 'next_after')::bigint; h0 := (full0 ->> 'horizon')::bigint;
  PERFORM pg_temp.push(A, I1, pg_temp.nowt(), jsonb_build_array(pg_temp.op_set(i1x, 'note', '"filler"', 1, 1, pg_temp.nowt())));
  PERFORM pg_temp.push(A, I1, pg_temp.nowt(), jsonb_build_array(pg_temp.op('remove', 'item', i2, pg_temp.nowt())));
  UPDATE public.cloud_deal_checklist_items SET removed_at = now() - interval '31 days' WHERE id = i2;
  PERFORM pg_temp.clear_claims(); r := public._cloud_todo_purge();
  s_tomb := (SELECT change_seq FROM public.cloud_deal_checklist_items WHERE id = i2);
  PERFORM pg_temp.deldeal(A, pg_temp.id('D2'));
  UPDATE public.cloud_deals SET removed_at = now() - interval '31 days', restorable_until = now() - interval '1 day' WHERE id = pg_temp.id('D2');
  PERFORM pg_temp.clear_claims(); r := public._cloud_todo_purge();
  -- the desktop starts over at its own pace: page 1 from its old cursor carries today's horizon
  p1 := pg_temp.pull(A, I1, a0, 1, (pg_temp.pull(A, I1, a0, 1, h0) ->> 'horizon')::bigint);
  f_before := (SELECT forgotten_through_seq FROM public.cloud_todo_feed_head WHERE owner_user_id = A);
  UPDATE public.cloud_deal_checklist_items SET purged_at = now() - interval '366 days' WHERE id = i2;
  PERFORM pg_temp.clear_claims(); r := public._cloud_todo_purge();
  f_after := (SELECT forgotten_through_seq FROM public.cloud_todo_feed_head WHERE owner_user_id = A);
  p2 := pg_temp.pull(A, I1, (p1 ->> 'next_after')::bigint, 500, (p1 ->> 'horizon')::bigint);
  got := EXISTS (SELECT 1 FROM jsonb_array_elements(p1 -> 'rows') x WHERE x ->> 'cloud_id' = i2::text);
  RETURN pg_temp.pass(got OR (p2 ->> 'resync_required')::boolean,
    format('cursor a0=%s h0=%s; tombstone seq=%s; page1 next_after=%s horizon=%s had tombstone=%s; forgotten_through before=%s after=%s; page2 resync=%s',
           a0, h0, s_tomb, p1 ->> 'next_after', p1 ->> 'horizon', got, f_before, f_after, p2 ->> 'resync_required'));
END $p$;

-- DR1 (SR d1_horizon_cases, copied verbatim from scratchpad/4263/sr-pr2/sr_probes.sql)
CREATE FUNCTION pg_temp.dr1_horizon_cases() RETURNS text LANGUAGE plpgsql AS $p$
DECLARE A uuid := pg_temp.id('A'); B uuid := pg_temp.id('B'); I1 uuid := pg_temp.id('I1'); IB uuid := pg_temp.id('IB');
        p1 jsonb; p2 jsonb; pa jsonb; r jsonb; h1 bigint; a1 bigint; q1 jsonb; q2 jsonb; ob jsonb; nb jsonb; c1 jsonb; c2 jsonb; old_after bigint; old_h bigint; e jsonb; f jsonb;
BEGIN
  -- (a) full pull at limit 1 after a purge, horizon carried from page 1: must finish without resync
  PERFORM pg_temp.deldeal(A, pg_temp.id('D2'));
  UPDATE public.cloud_deals SET removed_at = now() - interval '31 days', restorable_until = now() - interval '1 day' WHERE id = pg_temp.id('D2');
  PERFORM pg_temp.clear_claims(); r := public._cloud_todo_purge();
  pa := pg_temp.pull_all(A, I1, 0, 1, NULL);
  -- (b) a purge between two pages of a full pull: must resync
  p1 := pg_temp.pull(A, I1, 0, 1, NULL); a1 := (p1 ->> 'next_after')::bigint; h1 := (p1 ->> 'horizon')::bigint;
  PERFORM pg_temp.deldeal(A, pg_temp.id('D1'));
  UPDATE public.cloud_deals SET removed_at = now() - interval '31 days', restorable_until = now() - interval '1 day' WHERE id = pg_temp.id('D1');
  PERFORM pg_temp.clear_claims(); r := public._cloud_todo_purge();
  p2 := pg_temp.pull(A, I1, a1, 1, h1);
  -- (c) horizon equal to after, (d) no horizon with after>0 below the horizon
  e := pg_temp.pull(A, I1, (p2 ->> 'horizon')::bigint, 1, (p2 ->> 'horizon')::bigint);
  f := pg_temp.pull(A, I1, a1, 1, NULL);
  -- (e) turn-off/turn-on cycle: B's cursor from before, before and after B's first new write
  ob := pg_temp.pull(B, IB, 0, 500, NULL); old_after := (ob ->> 'next_after')::bigint; old_h := (ob ->> 'horizon')::bigint;
  PERFORM pg_temp.onoff(B, false); PERFORM pg_temp.onoff(B, true);
  c1 := pg_temp.pull(B, IB, old_after, 500, old_h);
  nb := pg_temp.deal(B, pg_temp.dp(IB, 'db-new'));
  c2 := pg_temp.pull(B, IB, old_after, 500, old_h);
  q1 := pg_temp.pull(B, IB, 0, 500, NULL);
  RETURN pg_temp.pass((pa ->> 'resync')::boolean IS NOT TRUE AND (p2 ->> 'resync_required')::boolean AND (e ->> 'resync_required')::boolean IS NOT TRUE
                      AND (c1 ->> 'resync_required')::boolean AND (c2 ->> 'resync_required')::boolean AND (q1 ->> 'resync_required')::boolean IS NOT TRUE,
    format('(a) full pull lim1 resync=%s pages=%s | (b) purge between pages: page1 after=%s h=%s -> page2 resync=%s horizon now=%s | (c) h=after resync=%s | (d) no horizon after=%s resync=%s | (e) off/on: old cursor before write resync=%s, after write=%s (upload %s), fresh full pull resync=%s',
      pa ->> 'resync', pa ->> 'pages', a1, h1, p2 ->> 'resync_required', p2 ->> 'horizon', e ->> 'resync_required', a1, f ->> 'resync_required',
      c1 ->> 'resync_required', c2 ->> 'resync_required', pg_temp.st(nb), q1 ->> 'resync_required'));
END $p$;
