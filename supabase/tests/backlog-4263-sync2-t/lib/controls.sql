-- BACKLOG-4263 P9 harness controls. Each returns 'PASS' or 'FAIL: <detail>'; the driver runs each in a subtransaction
-- that is undone at its end. Visible on dA for user A (computer IA active): m_none, m_txt, m_rev, m_recv, m_lin (newest
-- first); never m_tomb (removed), m_sug (suggested), m_unc (unconfirmed deal), m_rem (removed deal), m_inact (other
-- computer), m_bb (another person).

-- C-9a: approval page 1 -> not_found, logged as refused, no read row; page 2 -> the messages
CREATE FUNCTION pg_temp.c_c9a_permission() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE r1 jsonb; g1 jsonb; r2 jsonb; g2 jsonb; o1 text; o2 text; n0 bigint; n1 bigint;
BEGIN
  n0 := pg_temp.reads('A');
  r1 := pg_temp.lst('K1', pg_temp.s('dA'), NULL, NULL, 20, NULL); o1 := pg_temp.last_outcome('K1');
  g1 := pg_temp.getm('K1', pg_temp.s('m_lin'), 1); o2 := pg_temp.last_outcome('K1');
  n1 := pg_temp.reads('A');
  r2 := pg_temp.lst('K2', pg_temp.s('dA'), NULL, NULL, 20, NULL);
  g2 := pg_temp.getm('K2', pg_temp.s('m_lin'), 1);
  RETURN pg_temp.pass(r1 = '{"ok":false,"error":"not_found"}' AND o1 = 'refused' AND g1 = '{"ok":false,"error":"not_found"}' AND o2 = 'refused'
                      AND n1 = n0 AND r2 ->> 'ok' = 'true' AND jsonb_array_length(r2 -> 'result' -> 'messages') = 5 AND g2 ->> 'ok' = 'true',
    jsonb_build_object('r1', r1, 'o1', o1, 'g1', g1, 'o2', o2, 'rows', n1 - n0, 'r2', left(r2::text, 200), 'g2', left(g2::text, 200))::text);
END $c$;

-- M7 / §12.7: mcp_message_access answers exactly {ok, messages}; mcp_write_access keeps exactly {ok, write}
CREATE FUNCTION pg_temp.c_c9a_access() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE a1 jsonb; a2 jsonb; ax jsonb; a3 jsonb; w jsonb;
BEGIN
  a1 := pg_temp.access('K1');
  a2 := pg_temp.access('K2');
  ax := pg_temp.access('KX');
  w := pg_temp.j(pg_temp.tool('mcp_write_access', 'K2', ''));
  UPDATE public.cloud_release_switches SET messages_upload = false WHERE id;
  a3 := pg_temp.access('K2');
  RETURN pg_temp.pass(a1 = '{"ok":true,"messages":false}' AND a2 = '{"ok":true,"messages":true}' AND ax = '{"ok":false,"error":"not_connected"}'
                      AND a3 = '{"ok":true,"messages":false}'
                      AND (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(w) x) = ARRAY['ok', 'write'],
    jsonb_build_object('a1', a1, 'a2', a2, 'ax', ax, 'a3', a3, 'w', w)::text);
END $c$;

-- C-9b: every part of a 1,000,000-character body under the cap, the parts joined equal the stored body; the header
-- at every cap (1011 participants, 500 files, 1,000,000-character subject) fits
CREATE FUNCTION pg_temp.c_c9b_parts_big() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE r jsonb; g jsonb; m jsonb;
BEGIN
  g := pg_temp.getm('K2', pg_temp.s('m_big1'), 1);
  m := g -> 'result' -> 'message';
  r := pg_temp.all_parts('K2', pg_temp.s('m_big1'));
  RETURN pg_temp.pass(g ->> 'ok' = 'true' AND NOT r ? 'error' AND r ->> 'body_md5' = pg_temp.tx('big1_md5') AND r -> 'over_cap' = '[]'
                      AND (r ->> 'max_bytes')::int <= 90000 AND (r ->> 'parts')::int >= 2
                      AND r -> 'after_last' = '{"ok":false,"error":"not_found"}'
                      AND (m ->> 'participants_more')::int = 991
                      AND (CASE WHEN m ->> 'from' IS NULL THEN 0 ELSE 1 END) + jsonb_array_length(m -> 'to') + jsonb_array_length(m -> 'cc') = 20
                      AND (g -> 'result' ->> 'files_more')::int = 480 AND jsonb_array_length(g -> 'result' -> 'files') = 20
                      AND char_length(m ->> 'subject') <= 300,
    jsonb_build_object('r', r - 'after_last', 'after_last', r -> 'after_last', 'first', left(g::text, 300),
                       'more', m -> 'participants_more', 'files_more', g -> 'result' -> 'files_more')::text);
END $c$;

-- C-9b: list pages by bytes: two rows at every cap never share a page; each page under the cap; every row once
CREATE FUNCTION pg_temp.c_c9b_list_big() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE w jsonb; p jsonb; row1 jsonb;
BEGIN
  w := pg_temp.walk('K2', pg_temp.s('dBig'), 50);
  p := pg_temp.lst('K2', pg_temp.s('dBig'), NULL, NULL, 50, NULL);
  row1 := p -> 'result' -> 'messages' -> 0;
  RETURN pg_temp.pass(NOT w ? 'error' AND pg_temp.sorted(w -> 'ids') = pg_temp.ids('m_big1', 'm_big2') AND (w ->> 'pages')::int = 2
                      AND (w ->> 'max_bytes')::int <= 90000 AND (row1 ->> 'participants_more')::int = 991 AND NOT row1 ? 'cc'
                      AND (row1 ->> 'files_more')::int = 480 AND char_length(row1 ->> 'subject') <= 300
                      AND char_length(row1 ->> 'thread_key') <= 200,
    jsonb_build_object('walk', w, 'row1', left(row1::text, 300))::text);
END $c$;

-- C-9b: body sizes at a part boundary, for 1-, 2- (quote, tab) and 4-byte encoded characters (budget 60000)
CREATE FUNCTION pg_temp.c_c9b_sweep() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE x record; r jsonb; bad jsonb := '[]';
BEGIN
  FOR x IN SELECT * FROM (VALUES ('s_a1', 1), ('s_a2', 2), ('s_q1', 1), ('s_q2', 2), ('s_e1', 1), ('s_e2', 2), ('s_t1', 1), ('s_t2', 2)) v(k, want) LOOP
    r := pg_temp.all_parts('K2', pg_temp.s(x.k));
    IF r ? 'error' OR (r ->> 'parts')::int IS DISTINCT FROM x.want OR r -> 'over_cap' <> '[]' OR (r ->> 'max_bytes')::int > 90000
       OR r ->> 'body_md5' IS DISTINCT FROM (SELECT md5(public._mcp_strip(body_text)) FROM public.cloud_deal_messages WHERE id = pg_temp.f(x.k))
       OR r -> 'after_last' <> '{"ok":false,"error":"not_found"}' THEN
      bad := bad || jsonb_build_object(x.k, r - 'after_last');
    END IF;
  END LOOP;
  RETURN pg_temp.pass(bad = '[]', bad::text);
END $c$;

-- C-9c: one read row per message returned (list) and one per part (get), with the ids, channel and send time returned
CREATE FUNCTION pg_temp.c_c9c_log_rows() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE r jsonb; g jsonb; cid bigint; cid2 bigint; ok_list boolean; ok_get boolean;
BEGIN
  r := pg_temp.lst('K2', pg_temp.s('dA'), NULL, NULL, 20, NULL);
  cid := (SELECT id FROM public.mcp_call_log WHERE connection_id = pg_temp.f('K2') ORDER BY id DESC LIMIT 1);
  ok_list := r ->> 'ok' = 'true'
    AND (SELECT count(*) FROM public.mcp_message_reads WHERE call_id = cid) = jsonb_array_length(r -> 'result' -> 'messages')
    AND (SELECT pg_temp.sorted(jsonb_agg(to_jsonb(cloud_message_id::text))) FROM public.mcp_message_reads WHERE call_id = cid)
        = pg_temp.ids('m_lin', 'm_rev', 'm_txt', 'm_recv', 'm_none')
    AND NOT EXISTS (SELECT 1 FROM public.mcp_message_reads x
                     WHERE x.call_id = cid AND (x.user_id <> pg_temp.f('A') OR x.connection_id <> pg_temp.f('K2') OR x.provider <> 'anthropic'
                       OR x.client_name <> 'Fixture app K2' OR x.tool <> 'list_deal_messages' OR x.cloud_deal_id <> pg_temp.f('dA')
                       OR x.part IS NOT NULL
                       OR x.channel <> (SELECT m.channel_kind FROM public.cloud_deal_messages m WHERE m.id = x.cloud_message_id)
                       OR x.sent_at IS DISTINCT FROM (SELECT m.sent_at FROM public.cloud_deal_messages m WHERE m.id = x.cloud_message_id)));
  g := pg_temp.getm('K2', pg_temp.s('m_lin'), 1);
  cid2 := (SELECT id FROM public.mcp_call_log WHERE connection_id = pg_temp.f('K2') ORDER BY id DESC LIMIT 1);
  ok_get := g ->> 'ok' = 'true'
    AND (SELECT count(*) FROM public.mcp_message_reads WHERE call_id = cid2) = 1
    AND EXISTS (SELECT 1 FROM public.mcp_message_reads x WHERE x.call_id = cid2 AND x.tool = 'get_message' AND x.part = 1
                   AND x.cloud_message_id = pg_temp.f('m_lin') AND x.cloud_deal_id = pg_temp.f('dA') AND x.channel = 'email'
                   AND x.sent_at = timestamptz '2026-01-01T10:00:00Z');
  RETURN pg_temp.pass(ok_list AND ok_get, jsonb_build_object('list', ok_list, 'get', ok_get, 'r', left(r::text, 200), 'g', left(g::text, 200))::text);
END $c$;

-- C-9d / P9 condition 5: removed message, suggested row, unconfirmed deal, removed deal, removed file, a file with no
-- message, another person's message: never returned
CREATE FUNCTION pg_temp.c_c9d_filters() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE l jsonb; g jsonb; nf jsonb := '{"ok":false,"error":"not_found"}'; v jsonb := '{}'; lin jsonb;
BEGIN
  l := pg_temp.lst('K2', pg_temp.s('dA'), NULL, NULL, 50, NULL);
  v := v || jsonb_build_object('list_ids', (SELECT pg_temp.sorted(jsonb_agg(e -> 'message_id')) FROM jsonb_array_elements(l -> 'result' -> 'messages') e)
                                            = pg_temp.ids('m_lin', 'm_rev', 'm_txt', 'm_recv', 'm_none'));
  lin := (SELECT e FROM jsonb_array_elements(l -> 'result' -> 'messages') e WHERE e ->> 'message_id' = pg_temp.s('m_lin'));
  v := v || jsonb_build_object('list_files', (SELECT pg_temp.sorted(jsonb_agg(e -> 'file_id')) FROM jsonb_array_elements(lin -> 'files') e)
                                             = pg_temp.ids('f_lin1', 'f_lin2'));
  g := pg_temp.getm('K2', pg_temp.s('m_lin'), 1);
  v := v || jsonb_build_object('get_files', (SELECT pg_temp.sorted(jsonb_agg(e -> 'file_id')) FROM jsonb_array_elements(g -> 'result' -> 'files') e)
                                            = pg_temp.ids('f_lin1', 'f_lin2'));
  v := v || jsonb_build_object('tomb', pg_temp.getm('K2', pg_temp.s('m_tomb'), 1) = nf, 'sug', pg_temp.getm('K2', pg_temp.s('m_sug'), 1) = nf,
                               'unc', pg_temp.getm('K2', pg_temp.s('m_unc'), 1) = nf, 'rem', pg_temp.getm('K2', pg_temp.s('m_rem'), 1) = nf,
                               'list_dU', pg_temp.lst('K2', pg_temp.s('dU'), NULL, NULL, 20, NULL) = nf,
                               'list_dR', pg_temp.lst('K2', pg_temp.s('dR'), NULL, NULL, 20, NULL) = nf,
                               'other_get', pg_temp.getm('KB2', pg_temp.s('m_lin'), 1) = nf,
                               'other_list', pg_temp.lst('KB2', pg_temp.s('dA'), NULL, NULL, 20, NULL) = nf,
                               'own_b', pg_temp.getm('KB2', pg_temp.s('m_bb'), 1) ->> 'ok' = 'true');
  RETURN pg_temp.pass(NOT EXISTS (SELECT 1 FROM jsonb_each(v) e WHERE e.value <> 'true'), v::text);
END $c$;

-- C-9e: notice outdated, messages_upload off, licence ended -> not_entitled, and no read row
CREATE FUNCTION pg_temp.c_c9e_entitlement() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE ne jsonb := '{"ok":false,"error":"not_entitled"}'; v jsonb := '{}'; n0 bigint := pg_temp.reads('A');
BEGIN
  UPDATE public.cloud_autosave_settings SET notice_version = notice_version + 1 WHERE user_id = pg_temp.f('A');
  v := v || jsonb_build_object('notice_list', pg_temp.lst('K2', pg_temp.s('dA'), NULL, NULL, 20, NULL) = ne,
                               'notice_get', pg_temp.getm('K2', pg_temp.s('m_lin'), 1) = ne);
  UPDATE public.cloud_autosave_settings SET notice_version = notice_version - 1 WHERE user_id = pg_temp.f('A');
  UPDATE public.cloud_release_switches SET messages_upload = false WHERE id;
  v := v || jsonb_build_object('switch_list', pg_temp.lst('K2', pg_temp.s('dA'), NULL, NULL, 20, NULL) = ne,
                               'switch_get', pg_temp.getm('K2', pg_temp.s('m_lin'), 1) = ne);
  UPDATE public.cloud_release_switches SET messages_upload = true WHERE id;
  UPDATE public.member_addons SET revoked_at = now() WHERE user_id = pg_temp.f('A') AND addon_key = 'cloud_autosave';
  v := v || jsonb_build_object('licence_list', pg_temp.lst('K2', pg_temp.s('dA'), NULL, NULL, 20, NULL) = ne,
                               'licence_get', pg_temp.getm('K2', pg_temp.s('m_lin'), 1) = ne);
  -- a read of what the calls wrote: its own statement, after them
  v := v || jsonb_build_object('no_rows', pg_temp.reads('A') = n0);
  RETURN pg_temp.pass(NOT EXISTS (SELECT 1 FROM jsonb_each(v) e WHERE e.value <> 'true'), v::text);
END $c$;

-- C-9f / P9 condition 2: the read row cannot be written -> the call fails and returns no body
CREATE FUNCTION pg_temp.c_c9f_log_fails() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE g text; l text;
BEGIN
  ALTER TABLE public.mcp_message_reads ADD CONSTRAINT t4263_insert_fails CHECK (false) NOT VALID;
  g := pg_temp.tool('mcp_get_message', 'K2', format('%L, 1', pg_temp.s('m_lin')));
  l := pg_temp.tool('mcp_list_deal_messages', 'K2', format('%L, NULL, NULL, 20, NULL', pg_temp.s('dA')));
  RETURN pg_temp.pass(g LIKE 'ERR 23514 %' AND l LIKE 'ERR 23514 %', jsonb_build_object('get', left(g, 200), 'list', left(l, 200))::text);
END $c$;

-- C-9g / P9 condition 3: no read row without an answer: not_found (removed, part after the last, unconfirmed deal),
-- invalid_input, refused, and too_large (readers replaced by answers over the cap for this control only: no stored
-- row can reach the cap, so the wrapper's too_large branch is reached this way)
CREATE FUNCTION pg_temp.c_c9g_no_read_no_row() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE v jsonb := '{}'; n0 bigint := pg_temp.reads('A'); nf jsonb := '{"ok":false,"error":"not_found"}'; tl jsonb := '{"ok":false,"error":"too_large"}';
  g jsonb; o text;
BEGIN
  -- each call, then the read of what it logged, in separate statements (evaluation order inside one expression is
  -- not promised)
  g := pg_temp.getm('K2', pg_temp.s('m_tomb'), 1);
  o := pg_temp.last_outcome('K2');
  v := v || jsonb_build_object('removed', g = nf AND o = 'not_found');
  v := v || jsonb_build_object(
    'after_last', pg_temp.getm('K2', pg_temp.s('m_lin'), 2) = nf,
    'unconfirmed', pg_temp.lst('K2', pg_temp.s('dU'), NULL, NULL, 20, NULL) = nf,
    'invalid', pg_temp.getm('K2', 'x', 1) = '{"ok":false,"error":"invalid_input"}',
    'refused', pg_temp.getm('K1', pg_temp.s('m_lin'), 1) = nf);
  PERFORM pg_temp.as_reader(format($s$CREATE OR REPLACE FUNCTION public._mcp_r_get_message(p_message_id uuid, p_part integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $f$
BEGIN
  RETURN jsonb_build_object('kind', 'keepr.get_message', 'message', jsonb_build_object('message_id', p_message_id, 'deal_id', %L::uuid,
    'channel', 'email', 'sent_at', NULL, 'part', 1, 'parts', 1, 'body_text', repeat('x', 95000)), 'files', '[]'::jsonb);
END $f$$s$, pg_temp.s('dA')));
  PERFORM pg_temp.as_reader(format($s$CREATE OR REPLACE FUNCTION public._mcp_r_list_deal_messages(p_deal_id uuid, p_channel text, p_linked_only boolean,
  p_limit integer, p_after_key timestamptz, p_after_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $f$
BEGIN
  RETURN jsonb_build_object('kind', 'keepr.list_deal_messages', 'deal_id', p_deal_id, 'messages',
    jsonb_build_array(jsonb_build_object('message_id', %L::uuid, 'channel', 'email', 'sent_at', NULL, 'snippet', repeat('x', 95000))));
END $f$$s$, pg_temp.s('m_lin')));
  g := pg_temp.getm('K2', pg_temp.s('m_lin'), 1);
  o := pg_temp.last_outcome('K2');
  v := v || jsonb_build_object('too_large_get', g = tl AND o = 'too_large');
  v := v || jsonb_build_object('too_large_list', pg_temp.lst('K2', pg_temp.s('dA'), NULL, NULL, 20, NULL) = tl);
  v := v || jsonb_build_object('no_rows', pg_temp.reads('A') = n0);
  RETURN pg_temp.pass(NOT EXISTS (SELECT 1 FROM jsonb_each(v) e WHERE e.value <> 'true'), v::text);
END $c$;

-- C-9h / P9 condition 9 (§13.2, §14 D4): messages of a computer that is not the active one are hidden at once, in the
-- list and by id; moving the active computer swaps which deal's messages show; one_computer off shows both
CREATE FUNCTION pg_temp.c_c9h_inactive() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE v jsonb := '{}'; nf jsonb := '{"ok":false,"error":"not_found"}'; l jsonb; c jsonb;
BEGIN
  l := pg_temp.lst('K2', pg_temp.s('dB'), NULL, NULL, 20, NULL);
  v := v || jsonb_build_object('b_list_empty', l -> 'result' -> 'messages' = '[]' AND l -> 'result' -> 'messages_hidden' = 'true',
                               'b_get', pg_temp.getm('K2', pg_temp.s('m_inact'), 1) = nf,
                               'a_list', jsonb_array_length(pg_temp.lst('K2', pg_temp.s('dA'), NULL, NULL, 20, NULL) -> 'result' -> 'messages') = 5);
  c := pg_temp.claim('A', 'IB', true);
  l := pg_temp.lst('K2', pg_temp.s('dA'), NULL, NULL, 20, NULL);
  v := v || jsonb_build_object('moved', c ->> 'ok' = 'true',
                               'a_hidden', l -> 'result' -> 'messages' = '[]' AND l -> 'result' -> 'messages_hidden' = 'true',
                               'a_get', pg_temp.getm('K2', pg_temp.s('m_lin'), 1) = nf,
                               'b_list', (SELECT jsonb_agg(e -> 'message_id') FROM jsonb_array_elements(pg_temp.lst('K2', pg_temp.s('dB'), NULL, NULL, 20, NULL) -> 'result' -> 'messages') e) = pg_temp.ids('m_inact'),
                               'b_get_now', pg_temp.getm('K2', pg_temp.s('m_inact'), 1) ->> 'ok' = 'true');
  -- no active computer while the switch is on (state after a restore of removed deals on an account the S1 backfill
  -- left without one; set directly): nothing is shown
  UPDATE public.cloud_autosave_settings SET active_install_id = NULL, active_since = NULL WHERE user_id = pg_temp.f('A');
  l := pg_temp.lst('K2', pg_temp.s('dA'), NULL, NULL, 20, NULL);
  v := v || jsonb_build_object('none_list', l -> 'result' -> 'messages' = '[]' AND l -> 'result' -> 'messages_hidden' = 'true',
                               'none_get', pg_temp.getm('K2', pg_temp.s('m_lin'), 1) = nf,
                               'none_get_b', pg_temp.getm('K2', pg_temp.s('m_inact'), 1) = nf);
  UPDATE public.cloud_release_switches SET one_computer = false WHERE id;
  v := v || jsonb_build_object('off_a', jsonb_array_length(pg_temp.lst('K2', pg_temp.s('dA'), NULL, NULL, 20, NULL) -> 'result' -> 'messages') = 5,
                               'off_b', pg_temp.getm('K2', pg_temp.s('m_inact'), 1) ->> 'ok' = 'true');
  RETURN pg_temp.pass(NOT EXISTS (SELECT 1 FROM jsonb_each(v) e WHERE e.value <> 'true'), v::text);
END $c$;

-- P9 condition 1: the read log stays when the AI app is disconnected and when Keepr Cloud is turned off
CREATE FUNCTION pg_temp.c_p9a_log_survives() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE n1 bigint; n2 bigint; d jsonb; t jsonb;
BEGIN
  PERFORM pg_temp.lst('K2', pg_temp.s('dA'), NULL, NULL, 20, NULL);
  PERFORM pg_temp.getm('K2', pg_temp.s('m_lin'), 1);
  n1 := pg_temp.reads('A');
  d := pg_temp.as_user('A', 'mcp_disconnect', '%L::uuid', pg_temp.s('K2'));
  t := pg_temp.as_user('A', 'set_my_cloud_autosave', '%L::uuid, %L::boolean, %L::integer, %L::uuid', pg_temp.s('A'), 'false', '1', pg_temp.s('IA'));
  n2 := pg_temp.reads('A');
  RETURN pg_temp.pass(n1 = 6 AND n2 = n1 AND d ->> 'ok' = 'true' AND t ->> 'success' = 'true'
                      AND NOT EXISTS (SELECT 1 FROM public.mcp_connections WHERE user_id = pg_temp.f('A'))
                      AND NOT EXISTS (SELECT 1 FROM public.cloud_deals WHERE owner_user_id = pg_temp.f('A')),
    jsonb_build_object('before', n1, 'after', n2, 'disconnect', d, 'off', t)::text);
END $c$;

-- The person's read log (for the "Messages read" page): own rows only, live subject and sender while the message is
-- live, none after it is removed, deal state after turn-off, paging, support sessions refused, anon refused
CREATE FUNCTION pg_temp.c_log_view() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE v jsonb := '{}'; r jsonb; p1 jsonb; p2 jsonb; lin jsonb; rev jsonb;
BEGIN
  PERFORM pg_temp.lst('K2', pg_temp.s('dA'), NULL, NULL, 20, NULL);
  PERFORM pg_temp.getm('K2', pg_temp.s('m_lin'), 1);
  r := pg_temp.as_user('A', 'mcp_list_my_message_reads', '%L, %L::integer', NULL, '50');
  -- the fixture user's own get_message row (one); rows of anyone else, if the view shows them, are a FAIL of own_rows_only
  lin := (SELECT e FROM jsonb_array_elements(r -> 'reads') e WHERE e ->> 'tool' = 'get_message'
             AND e ->> 'read_id' IN (SELECT x.id::text FROM public.mcp_message_reads x WHERE x.user_id = pg_temp.f('A')));
  v := v || jsonb_build_object('count', jsonb_array_length(r -> 'reads') = 6,
    'own_rows_only', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'reads') e
                                  WHERE e ->> 'read_id' IS NULL
                                     OR NOT EXISTS (SELECT 1 FROM public.mcp_message_reads x
                                                     WHERE x.user_id = pg_temp.f('A') AND x.id::text = e ->> 'read_id')),
    'lin', lin ->> 'subject' = 'Offer accepted' AND lin ->> 'from' = 'Seller Agent <seller@example.test>' AND lin ->> 'message_state' = 'live'
           AND lin ->> 'deal_state' = 'live' AND lin ->> 'address' = 'Fixture dA Street' AND lin ->> 'app_name' = 'Fixture app K2'
           AND (lin ->> 'part')::int = 1 AND lin ->> 'channel' = 'email' AND lin ->> 'deal_id' = pg_temp.s('dA'));
  PERFORM pg_temp.tomb('A', 'IA', 'message', ARRAY[pg_temp.f('m_rev')]);
  r := pg_temp.as_user('A', 'mcp_list_my_message_reads', '%L, %L::integer', NULL, '50');
  rev := (SELECT e FROM jsonb_array_elements(r -> 'reads') e WHERE e ->> 'read_id' IN (
            SELECT x.id::text FROM public.mcp_message_reads x WHERE x.cloud_message_id = pg_temp.f('m_rev')));
  v := v || jsonb_build_object('removed', rev ->> 'message_state' = 'removed' AND rev -> 'subject' = 'null' AND rev -> 'from' = 'null');
  p1 := pg_temp.as_user('A', 'mcp_list_my_message_reads', '%L, %L::integer', NULL, '1');
  p2 := pg_temp.as_user('A', 'mcp_list_my_message_reads', '%L, %L::integer', p1 ->> 'next_cursor', '1');
  v := v || jsonb_build_object('paging', jsonb_array_length(p1 -> 'reads') = 1 AND p1 ->> 'next_cursor' IS NOT NULL AND jsonb_array_length(p2 -> 'reads') = 1
                                         AND p2 -> 'reads' -> 0 ->> 'read_id' <> p1 -> 'reads' -> 0 ->> 'read_id',
    'other_person', pg_temp.as_user('B', 'mcp_list_my_message_reads', '%L, %L::integer', NULL, '50') -> 'reads' = '[]',
    'anon', pg_temp.call_as(NULL, 'SELECT public.mcp_list_my_message_reads(NULL, 50)', 'anon') LIKE 'ERR 42501 %',
    'bad_cursor', pg_temp.as_user('A', 'mcp_list_my_message_reads', '%L, %L::integer', 'x', '50') = '{"ok":false,"error":"invalid_input"}');
  INSERT INTO public.impersonation_sessions (admin_user_id, target_user_id, status, expires_at, session_expires_at)
  VALUES (pg_temp.f('A'), pg_temp.f('B'), 'active', now() + interval '1 hour', now() + interval '1 hour');
  v := v || jsonb_build_object('support', pg_temp.as_user('A', 'mcp_list_my_message_reads', '%L, %L::integer', NULL, '50') = '{"ok":false,"error":"impersonating"}');
  DELETE FROM public.impersonation_sessions WHERE admin_user_id = pg_temp.f('A');
  PERFORM pg_temp.as_user('A', 'set_my_cloud_autosave', '%L::uuid, %L::boolean, %L::integer, %L::uuid', pg_temp.s('A'), 'false', '1', pg_temp.s('IA'));
  r := pg_temp.as_user('A', 'mcp_list_my_message_reads', '%L, %L::integer', NULL, '50');
  v := v || jsonb_build_object('after_off', jsonb_array_length(r -> 'reads') = 6
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'reads') e
                            WHERE e ->> 'deal_state' <> 'gone' OR e -> 'address' <> 'null' OR e ->> 'message_state' <> 'removed'));
  RETURN pg_temp.pass(NOT EXISTS (SELECT 1 FROM jsonb_each(v) e WHERE e.value <> 'true'), v::text);
END $c$;

-- Marks and arguments: needs_review and hidden_from_export as stored; review linked_only; channel text; bad arguments
CREATE FUNCTION pg_temp.c_marks_args() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE v jsonb := '{}'; l jsonb; e jsonb; ii jsonb := '{"ok":false,"error":"invalid_input"}';
BEGIN
  l := pg_temp.lst('K2', pg_temp.s('dA'), NULL, NULL, 20, NULL);
  v := v || jsonb_build_object('marks', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(l -> 'result' -> 'messages') x
      WHERE x ->> 'review_state' <> CASE WHEN x ->> 'message_id' = pg_temp.s('m_rev') THEN 'needs_review' ELSE 'linked' END
         OR x -> 'hidden_from_export' <> to_jsonb(x ->> 'message_id' = pg_temp.s('m_txt'))
         OR x ->> 'channel' <> CASE WHEN x ->> 'message_id' = pg_temp.s('m_txt') THEN 'text' ELSE 'email' END));
  e := pg_temp.getm('K2', pg_temp.s('m_rev'), 1);
  v := v || jsonb_build_object('get_mark', e -> 'result' -> 'message' ->> 'review_state' = 'needs_review',
    'get_hidden', pg_temp.getm('K2', pg_temp.s('m_txt'), 1) -> 'result' -> 'message' -> 'hidden_from_export' = 'true',
    'linked_only', (SELECT pg_temp.sorted(jsonb_agg(x -> 'message_id')) FROM jsonb_array_elements(pg_temp.lst('K2', pg_temp.s('dA'), NULL, 'linked_only', 20, NULL) -> 'result' -> 'messages') x)
                   = pg_temp.ids('m_lin', 'm_txt', 'm_recv', 'm_none'),
    'text_only', (SELECT jsonb_agg(x -> 'message_id') FROM jsonb_array_elements(pg_temp.lst('K2', pg_temp.s('dA'), 'text', NULL, 20, NULL) -> 'result' -> 'messages') x)
                 = pg_temp.ids('m_txt'),
    'bad_review', pg_temp.lst('K2', pg_temp.s('dA'), NULL, 'x', 20, NULL) = ii,
    'bad_limit', pg_temp.lst('K2', pg_temp.s('dA'), NULL, NULL, 51, NULL) = ii,
    'bad_cursor', pg_temp.lst('K2', pg_temp.s('dA'), NULL, NULL, 20, 'x') = ii,
    'bad_part', pg_temp.getm('K2', pg_temp.s('m_lin'), 0) = ii);
  RETURN pg_temp.pass(NOT EXISTS (SELECT 1 FROM jsonb_each(v) x WHERE x.value <> 'true'), v::text);
END $c$;

-- Paging with NULL send times: limit 1 walks every message once, in the documented order
CREATE FUNCTION pg_temp.c_keyset_null() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE w jsonb;
BEGIN
  w := pg_temp.walk('K2', pg_temp.s('dA'), 1);
  RETURN pg_temp.pass(NOT w ? 'error' AND (w ->> 'pages')::int = 5
                      AND w -> 'ids' = jsonb_build_array(pg_temp.s('m_none'), pg_temp.s('m_txt'), pg_temp.s('m_rev'), pg_temp.s('m_recv'), pg_temp.s('m_lin')),
    w::text);
END $c$;

-- Retention: rows older than one year are deleted, younger ones kept (rows written directly with their read time)
CREATE FUNCTION pg_temp.c_prune() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE o uuid := gen_random_uuid(); y uuid := gen_random_uuid(); z uuid := gen_random_uuid(); n int;
BEGIN
  INSERT INTO public.mcp_message_reads (id, user_id, provider, client_name, tool, cloud_deal_id, cloud_message_id, channel, read_at) VALUES
    (o, pg_temp.f('A'), 'anthropic', 'Fixture', 'get_message', pg_temp.f('dA'), pg_temp.f('m_lin'), 'email', now() - interval '400 days'),
    (y, pg_temp.f('A'), 'anthropic', 'Fixture', 'get_message', pg_temp.f('dA'), pg_temp.f('m_lin'), 'email', now() - interval '300 days'),
    (z, pg_temp.f('A'), 'anthropic', 'Fixture', 'get_message', pg_temp.f('dA'), pg_temp.f('m_lin'), 'email', now());
  n := public._mcp_prune_message_reads();
  RETURN pg_temp.pass(n >= 1 AND NOT EXISTS (SELECT 1 FROM public.mcp_message_reads WHERE id = o)
                      AND (SELECT count(*) FROM public.mcp_message_reads WHERE id IN (y, z)) = 2,
    jsonb_build_object('deleted', n, 'old_left', EXISTS (SELECT 1 FROM public.mcp_message_reads WHERE id = o),
                       'young_left', (SELECT count(*) FROM public.mcp_message_reads WHERE id IN (y, z)))::text);
END $c$;

-- Grants, RLS, foreign keys, the job, the call-log CHECK and the readers' attributes, from the catalogue
CREATE FUNCTION pg_temp.c_catalogue() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE v jsonb := '{}';
  mine text[] := ARRAY['public._mcp_conn_reads_messages(uuid)', 'public._mcp_msg_people(jsonb,boolean)',
                       'public._mcp_r_list_deal_messages(uuid,text,boolean,integer,timestamp with time zone,uuid)', 'public._mcp_r_get_message(uuid,integer)',
                       'public.mcp_list_deal_messages(text,bytea,text,text,text,text,integer,text)', 'public.mcp_get_message(text,bytea,text,text,integer)',
                       'public.mcp_message_access(text,bytea,text)', 'public.mcp_list_my_message_reads(text,integer)', 'public._mcp_prune_message_reads()'];
BEGIN
  v := v || jsonb_build_object(
    'anon', (SELECT array_agg(s ORDER BY s) FROM unnest(mine) s WHERE has_function_privilege('anon', pg_catalog.to_regprocedure(s), 'EXECUTE'))
            = ARRAY['public.mcp_get_message(text,bytea,text,text,integer)', 'public.mcp_list_deal_messages(text,bytea,text,text,text,text,integer,text)',
                    'public.mcp_message_access(text,bytea,text)'],
    'authenticated', (SELECT array_agg(s ORDER BY s) FROM unnest(mine) s WHERE has_function_privilege('authenticated', pg_catalog.to_regprocedure(s), 'EXECUTE'))
            = ARRAY['public.mcp_list_my_message_reads(text,integer)'],
    'service_role', NOT EXISTS (SELECT 1 FROM unnest(mine) s WHERE has_function_privilege('service_role', pg_catalog.to_regprocedure(s), 'EXECUTE')),
    'public', NOT EXISTS (SELECT 1 FROM unnest(mine) s, pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                           WHERE p.oid = to_regprocedure(s) AND a.grantee = 0::oid),
    'readers', (SELECT bool_and(public._mcp_reader_ok(to_regprocedure(s))) FROM unnest(mine[3:4]) s),
    'table_privs', NOT EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES']) p
                                WHERE has_table_privilege(r::name, 'public.mcp_message_reads'::regclass::oid, p)),
    'rls', (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.mcp_message_reads'::regclass),
    'no_policy', NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.mcp_message_reads'::regclass),
    'fk_only_users', (SELECT array_agg(confrelid::regclass::text) FROM pg_constraint WHERE conrelid = 'public.mcp_message_reads'::regclass AND contype = 'f') = ARRAY['auth.users'],
    'job', EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mcp-message-reads-prune' AND schedule = '41 3 * * *' AND command = 'SELECT public._mcp_prune_message_reads()'),
    'tool_check', (SELECT array_agg(m[1] ORDER BY m[1] COLLATE "C") FROM pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') m
                    WHERE c.conrelid = 'public.mcp_call_log'::regclass AND c.conname = 'mcp_call_log_tool_check')
                  = (SELECT array_agg(x ORDER BY x COLLATE "C") FROM unnest(ARRAY['get_status', 'list_deals', 'get_deal', 'get_deal_checklists', 'list_all_deals',
                       'update_todo', 'add_todo', 'remove_todo', 'restore_todo', 'find_people', 'list_todos', 'list_deal_messages', 'get_message']) x));
  RETURN pg_temp.pass(NOT EXISTS (SELECT 1 FROM jsonb_each(v) e WHERE e.value <> 'true'), v::text);
END $c$;

-- Body: invisible characters are removed before the body is returned and split (M1)
CREATE FUNCTION pg_temp.c_strip() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE r jsonb; b text; stored text;
BEGIN
  r := pg_temp.getm('K2', pg_temp.s('m_inv'), 1);
  b := r -> 'result' -> 'message' ->> 'body_text';
  stored := (SELECT body_text FROM public.cloud_deal_messages WHERE id = pg_temp.f('m_inv'));
  RETURN pg_temp.pass(r ->> 'ok' = 'true' AND strpos(stored, chr(917569)) > 0 AND strpos(stored, chr(8238)) > 0
                      AND b = public._mcp_strip(stored) AND strpos(b, chr(917569)) = 0 AND strpos(b, chr(917594)) = 0
                      AND strpos(b, chr(8238)) = 0 AND b = 'Visible start  visible end',
    jsonb_build_object('ok', r ->> 'ok', 'returned_chars', char_length(b), 'stored_chars', char_length(stored))::text);
END $c$;

-- Participants: a 'from' array shows its first value and counts the others; list leaves cc out and counts it
CREATE FUNCTION pg_temp.c_people() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE g jsonb; l jsonb; lr jsonb;
BEGIN
  g := pg_temp.getm('K2', pg_temp.s('m_from'), 1) -> 'result' -> 'message';
  l := pg_temp.lst('K2', pg_temp.s('dSw'), NULL, NULL, 50, NULL);
  lr := (SELECT e FROM jsonb_array_elements(l -> 'result' -> 'messages') e WHERE e ->> 'message_id' = pg_temp.s('m_from'));
  RETURN pg_temp.pass(g ->> 'from' = 'a@example.test' AND g -> 'to' = '["d@example.test"]' AND g -> 'cc' = '["e@example.test"]'
                      AND (g ->> 'participants_more')::int = 2
                      AND lr ->> 'from' = 'a@example.test' AND lr -> 'to' = '["d@example.test"]' AND NOT lr ? 'cc'
                      AND (lr ->> 'participants_more')::int = 3,
    jsonb_build_object('get', g - 'body_text', 'list', lr)::text);
END $c$;

-- Retention: more than one batch of old rows is deleted in one run (rows written directly with their read time)
CREATE FUNCTION pg_temp.c_prune_loop() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE n int; tag text := 'Fixture prune ' || pg_temp.s('RUN');
BEGIN
  INSERT INTO public.mcp_message_reads (user_id, provider, client_name, tool, cloud_deal_id, cloud_message_id, channel, read_at)
  SELECT pg_temp.f('A'), 'anthropic', tag, 'get_message', pg_temp.f('dA'), pg_temp.f('m_lin'), 'email', now() - interval '400 days'
    FROM generate_series(1, 100001);
  n := public._mcp_prune_message_reads();
  RETURN pg_temp.pass(n >= 100001 AND NOT EXISTS (SELECT 1 FROM public.mcp_message_reads WHERE client_name = tag),
    jsonb_build_object('deleted', n, 'left', (SELECT count(*) FROM public.mcp_message_reads WHERE client_name = tag))::text);
END $c$;
