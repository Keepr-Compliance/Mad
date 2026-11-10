-- BACKLOG-4170 PR2c controls. compose.py order: [applied state] -> rollback (PR2b text) -> prelude
-- (fixtures + P0 on the PR2b text) -> migration TWICE -> this file. Fixtures: see prelude.sql.
-- Placeholders filled in by compose.py: the rollback text, the migration text, the file's post md5s.
-- Output: RAISE 'P4170_RESULT {total, pass, fail, reds, payload_md5}'.

-- PR2b state of the 9 group-E functions (md5 = PR2b post column, pm_comments 43d89657; ACL / config /
-- volatility = production, unchanged by PR2b). keepr-test held exactly this after PR2b + PR3.
CREATE FUNCTION pg_temp.pr2b() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $b$
  SELECT jsonb_object_agg(k, jsonb_build_object('md5', m, 'acl', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}',
                                                'config', '{search_path=public}', 'vol', 'v'))
    FROM (VALUES
      ('support_add_message/5', '9d9cb01bb5a1fed81f584aa6f268118c'),
      ('support_get_ticket_detail/2', 'fd14d57fe2cbd29a39a6e1af7b75e23f'),
      ('support_list_tickets/10', '6220590c8de1afd36c0f03152c3e7d92'),
      ('support_add_attachment/6', '25d8804822f9512df1ab5b37341a36a7'),
      ('support_add_diagnostic_attachment/6', '5d1cd82cfbe147bafb45ebdf41ff0e13'),
      ('support_delete_own_attachment/1', '7ecbe698370302a1659f11a43606de51'),
      ('support_list_attachments/1', '48d9e3f2c8a85e760b47a2448dd8fae0'),
      ('support_list_events/1', '269465224f282e27485b37fa0f2830e0'),
      ('support_record_attachment_access/1', 'a1c89e345b3dbccc6d61a50bfc74b84f')
    ) v(k, m)
$b$;

CREATE FUNCTION pg_temp.touched() RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $b$
  VALUES ('support_add_message/5'), ('support_get_ticket_detail/2'), ('support_list_events/1')
$b$;

CREATE FUNCTION pg_temp.p0(l text, cc text) RETURNS text LANGUAGE sql AS $b$
  SELECT res FROM p4170p2c_p0 WHERE lbl = l AND c = cc
$b$;
CREATE FUNCTION pg_temp.m(l text, cc text) RETURNS text LANGUAGE plpgsql AS $b$
BEGIN RETURN (SELECT res FROM p4170p2c_m WHERE lbl = l AND c = cc); END
$b$;

-- callers holding support.view (the agent path; their replies must not change)
CREATE FUNCTION pg_temp.is_agent(l text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $b$
  SELECT l IN ('u_support.view', 'u_sa', 'u_view+manage')
$b$;

-- an internal-note event row: message_added / internal_note, or internal_note_deleted
CREATE FUNCTION pg_temp.is_note_ev(e jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $b$
  SELECT (e ->> 'event_type' = 'message_added' AND (e ->> 'new_value') IS NOT DISTINCT FROM 'internal_note')
      OR e ->> 'event_type' = 'internal_note_deleted'
$b$;
CREATE FUNCTION pg_temp.strip_arr(a jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $b$
  SELECT coalesce((SELECT jsonb_agg(x.e ORDER BY x.o) FROM jsonb_array_elements(a) WITH ORDINALITY x(e, o)
                    WHERE NOT pg_temp.is_note_ev(x.e)), '[]'::jsonb)
$b$;
-- a P0 view reply with the internal_note events removed (errors unchanged)
CREATE FUNCTION pg_temp.strip(f text, s text) RETURNS text LANGUAGE sql AS $b$
  SELECT CASE WHEN s LIKE 'ERR %' THEN s
              WHEN f = 'support_list_events/1' THEN pg_temp.strip_arr(s::jsonb)::text
              ELSE jsonb_set(s::jsonb, '{events}', pg_temp.strip_arr(s::jsonb -> 'events'))::text END
$b$;
-- event ids in a view reply
CREATE FUNCTION pg_temp.ev_ids(f text, s text) RETURNS text[] LANGUAGE sql AS $b$
  SELECT CASE WHEN s LIKE 'ERR %' THEN NULL ELSE
    (SELECT array_agg(right(e ->> 'id', 3) ORDER BY right(e ->> 'id', 3))
       FROM jsonb_array_elements(CASE WHEN f = 'support_list_events/1' THEN s::jsonb ELSE s::jsonb -> 'events' END) e) END
$b$;

-- add_message: (caller, case) pairs where a caller without support.view is the ticket's requester
-- (hand-enumerated from the fixtures, not computed by the rule under test):
--   u_cust (user 7): 901 (requester_id) and 902 (requester_email only), whatever p_sender_email says
--   u0 (user 1): 903
--   signed out (anon, u_nullsub): p_sender_email equals the requester_email, any case
-- Cases with no p_sender_email for a signed-out caller keep the existing refusal (P0).
CREATE FUNCTION pg_temp.msg_allowed(l text, cc text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $b$
  SELECT cc = 'm_999_reply' OR CASE
    WHEN l = 'u_cust' THEN cc IN ('m_901_reply', 'm_901_reply_em7', 'm_902_reply', 'm_902_reply_em7', 'm_902_reply_EM7')
    WHEN l = 'u0' THEN cc IN ('m_903_reply', 'm_903_reply_em1', 'm_903_reply_em7', 'm_903_note', 'm_903_reply_pct', 'm_903_reply_em1pct')
    WHEN l IN ('anon', 'u_nullsub') THEN cc IN ('m_901_reply', 'm_902_reply', 'm_903_reply', 'm_904_reply', 'm_903_note', 'm_904_note',
                                                 'm_901_reply_em7', 'm_902_reply_em7', 'm_902_reply_EM7', 'm_903_reply_em1', 'm_904_reply_em8')
    ELSE false END
$b$;
CREATE FUNCTION pg_temp.tk(cc text) RETURNS int LANGUAGE sql IMMUTABLE AS $b$
  SELECT substring(cc FROM '^m_(\d+)_')::int
$b$;
-- the ticket's state with no call: what a refused call must leave behind
CREATE FUNCTION pg_temp.untouched(t int) RETURNS text LANGUAGE sql AS $b$
  SELECT split_part(pg_temp.call_as(NULL, 'SELECT NULL::jsonb', 'anon', NULL, pg_temp.after_msg(t)), ' | ', 2)
$b$;

-- the reply each caller must get after PR2c
CREATE FUNCTION pg_temp.want(l text, cc text, f text) RETURNS text LANGUAGE sql AS $b$
  SELECT CASE
    WHEN pg_temp.is_agent(l) THEN pg_temp.p0(l, cc)
    WHEN f = 'support_add_message/5' THEN
      CASE WHEN pg_temp.msg_allowed(l, cc) THEN pg_temp.p0(l, cc)
           ELSE 'ERR P0001 Ticket not found: ' || pg_temp.fx(pg_temp.tk(cc)) || ' | ' || pg_temp.untouched(pg_temp.tk(cc)) END
    ELSE pg_temp.strip(f, pg_temp.p0(l, cc)) END
$b$;

CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE r jsonb := '{}'; x record; ok boolean; s text; s2 text; n int; post jsonb := '__POSTMD5__'::jsonb;
BEGIN
  CREATE TEMP TABLE p4170p2c_m AS SELECT * FROM pg_temp.matrix(false);

  -- ================= V: every (caller, case) reply equals the expected reply =================
  FOR x IN SELECT m.lbl, m.c, m.f, m.res, pg_temp.want(m.lbl, m.c, m.f) AS w FROM p4170p2c_m m LOOP
    r := r || jsonb_build_object('V_' || x.lbl || '_' || x.c, pg_temp.pass(x.res IS NOT DISTINCT FROM x.w, coalesce(x.res, 'null') || ' WANT ' || coalesce(x.w, 'null')));
  END LOOP;
  n := (SELECT count(*) FROM p4170p2c_m);
  r := r || jsonb_build_object('V_matrix_size', pg_temp.pass(n = (SELECT count(*) FROM pg_temp.callers()) * (SELECT count(*) FROM pg_temp.cases()) AND n > 200, n::text));

  -- ================= B0: agent payloads byte-identical before / after (all cases) =================
  CREATE TEMP TABLE p4170p2c_md5 AS
    SELECT cl.lbl,
           (SELECT md5(string_agg(res, E'\n' ORDER BY c)) FROM p4170p2c_p0 WHERE lbl = cl.lbl) AS before,
           (SELECT md5(string_agg(res, E'\n' ORDER BY c)) FROM p4170p2c_m WHERE lbl = cl.lbl) AS after
      FROM pg_temp.callers() cl;
  FOR x IN SELECT * FROM p4170p2c_md5 WHERE pg_temp.is_agent(lbl) LOOP
    r := r || jsonb_build_object('B0_' || x.lbl || '_unchanged', pg_temp.pass(x.before = x.after, x.before || ' vs ' || x.after));
  END LOOP;

  -- ================= D: requester view payloads differ ONLY by the internal_note event rows =================
  -- for every non-agent view reply: P0 minus M = nothing, or exactly that ticket's 90x (internal_note_deleted)
  -- and 97x (message_added / internal_note) event ids; nothing added
  FOR x IN SELECT m.lbl, m.c, m.f, m.res, p.res AS p0res FROM p4170p2c_m m JOIN p4170p2c_p0 p USING (lbl, c)
            WHERE m.f <> 'support_add_message/5' AND NOT pg_temp.is_agent(m.lbl) AND p.res NOT LIKE 'ERR %' LOOP
    s := (SELECT string_agg(i, ',' ORDER BY i) FROM unnest(pg_temp.ev_ids(x.f, x.p0res)) i WHERE i <> ALL (coalesce(pg_temp.ev_ids(x.f, x.res), '{}')));
    s2 := (SELECT string_agg(i, ',' ORDER BY i) FROM unnest(coalesce(pg_temp.ev_ids(x.f, x.res), '{}')) i WHERE i <> ALL (pg_temp.ev_ids(x.f, x.p0res)));
    r := r || jsonb_build_object('D_' || x.lbl || '_' || x.c || '_removed_only_note_events',
      pg_temp.pass(coalesce(s, '') ~ '^(90([6-9]),97[1-4])?$' AND (s IS NULL OR right(split_part(s, ',', 1), 1)::int - 5 = right(split_part(s, ',', 2), 1)::int) AND s2 IS NULL AND x.res NOT LIKE 'ERR %', coalesce(s, 'none') || ' removed; added ' || coalesce(s2, 'none')));
  END LOOP;
  n := (SELECT count(*) FROM p4170p2c_m m JOIN p4170p2c_p0 p USING (lbl, c)
         WHERE m.f <> 'support_add_message/5' AND NOT pg_temp.is_agent(m.lbl) AND p.res NOT LIKE 'ERR %' AND m.res <> p.res);
  r := r || jsonb_build_object('D_nonvacuous_requester_replies_changed', pg_temp.pass(n >= 6, n::text));
  -- the rows kept: status_changed, message_added/reply and message_added with NULL new_value
  s := pg_temp.m('u_cust', 'le_cust');
  r := r || jsonb_build_object('D_u_cust_le_cust_keeps_961_981_991',
    pg_temp.pass(pg_temp.ev_ids('support_list_events/1', s) = ARRAY['961', '981', '991'], s));
  s := pg_temp.m('anon', 'd_by_email');
  r := r || jsonb_build_object('D_anon_d_by_email_keeps_961_981_991',
    pg_temp.pass(pg_temp.ev_ids('support_get_ticket_detail/2', s) = ARRAY['961', '981', '991'], s));
  s := pg_temp.m('u0', 'd_u0');
  r := r || jsonb_build_object('D_u0_d_u0_keeps_963_983_993',
    pg_temp.pass(pg_temp.ev_ids('support_get_ticket_detail/2', s) = ARRAY['963', '983', '993'], s));
  -- P0 really showed the note event to that requester (the fixture can tell the fix apart)
  s := pg_temp.p0('u_cust', 'le_cust');
  r := r || jsonb_build_object('D_p0_u_cust_saw_971', pg_temp.pass('971' = ANY (pg_temp.ev_ids('support_list_events/1', s)), s));
  r := r || jsonb_build_object('D_p0_u_cust_saw_906', pg_temp.pass('906' = ANY (pg_temp.ev_ids('support_list_events/1', s)), s));
  s := pg_temp.p0('anon', 'd_by_email');
  r := r || jsonb_build_object('D_p0_anon_d_by_email_saw_906', pg_temp.pass('906' = ANY (pg_temp.ev_ids('support_get_ticket_detail/2', s)), s));
  -- agents still see it
  s := pg_temp.m('u_sa', 'd_cust');
  r := r || jsonb_build_object('D_u_sa_d_cust_sees_906_971', pg_temp.pass(pg_temp.ev_ids('support_get_ticket_detail/2', s) = ARRAY['906', '961', '971', '981', '991'], s));
  s := pg_temp.m('u_support.view', 'le_other');
  r := r || jsonb_build_object('D_support.view_le_other_sees_909_974', pg_temp.pass(pg_temp.ev_ids('support_list_events/1', s) = ARRAY['909', '964', '974', '984', '994'], s));

  -- ================= A: support_add_message, named cases =================
  -- refused: error is the function's existing unknown-ticket reply, nothing written, no reopen
  FOR x IN SELECT * FROM (VALUES
      ('A_cust_not_requester_903_refused', 'u_cust', 'm_903_reply', 903, 'resolved'),
      ('A_cust_not_requester_904_refused', 'u_cust', 'm_904_reply', 904, 'new'),
      ('A_cust_passing_requester_email_904_refused', 'u_cust', 'm_904_reply_em8', 904, 'new'),
      ('A_cust_note_904_refused_as_not_found', 'u_cust', 'm_904_note', 904, 'new'),
      ('A_anon_wrong_email_903_refused', 'anon', 'm_903_reply_em7', 903, 'resolved'),
      ('A_anon_wrong_email_904_refused', 'anon', 'm_904_reply_em99', 904, 'new'),
      ('A_nullsub_wrong_email_903_refused', 'u_nullsub', 'm_903_reply_em7', 903, 'resolved'),
      ('A_anon_percent_email_903_refused', 'anon', 'm_903_reply_pct', 903, 'resolved'),
      ('A_anon_requester_email_suffix_903_refused', 'anon', 'm_903_reply_em1pct', 903, 'resolved'),
      ('A_decoy_903_refused', 'u_other_users.view', 'm_903_reply', 903, 'resolved')
    ) v(k, l, cc, t, st) LOOP
    s := pg_temp.m(x.l, x.cc);
    s2 := split_part(s, ' | ', 2);
    ok := split_part(s, ' | ', 1) = 'ERR P0001 Ticket not found: ' || pg_temp.fx(x.t)
      AND (s2::jsonb -> 'new') = 'null'::jsonb AND (s2::jsonb -> 'events') = 'null'::jsonb
      AND s2::jsonb ->> 'status' = x.st AND (s2::jsonb ->> 'reopened')::int = 0;
    r := r || jsonb_build_object(x.k, pg_temp.pass(ok, s));
  END LOOP;
  -- the refusal text is the one a missing ticket gets (no new text)
  s := pg_temp.m('u_cust', 'm_999_reply');
  r := r || jsonb_build_object('A_missing_ticket_reply_unchanged',
    pg_temp.pass(split_part(s, ' | ', 1) = 'ERR P0001 Ticket not found: ' || pg_temp.fx(999) AND s = pg_temp.p0('u_cust', 'm_999_reply'), s));
  -- allowed: the real requester still posts (and a resolved ticket reopens, as before)
  FOR x IN SELECT * FROM (VALUES
      ('A_requester_signed_in_903_posts_and_reopens', 'u0', 'm_903_reply', 'resolved'),
      ('A_requester_by_email_signed_in_902_posts_and_reopens', 'u_cust', 'm_902_reply', 'resolved'),
      ('A_requester_signed_in_901_posts', 'u_cust', 'm_901_reply', 'new'),
      ('A_requester_signed_out_903_posts_and_reopens', 'anon', 'm_903_reply_em1', 'resolved'),
      ('A_requester_signed_out_upper_email_902_posts', 'anon', 'm_902_reply_EM7', 'resolved'),
      ('A_requester_nullsub_904_posts', 'u_nullsub', 'm_904_reply_em8', 'new')
    ) v(k, l, cc, st) LOOP
    s := pg_temp.m(x.l, x.cc);
    s2 := split_part(s, ' | ', 2);
    ok := s NOT LIKE 'ERR %' AND jsonb_array_length(s2::jsonb -> 'new') = 1
      AND CASE WHEN x.st = 'resolved' THEN s2::jsonb ->> 'status' = 'in_progress' AND (s2::jsonb ->> 'reopened')::int = 1
               ELSE s2::jsonb ->> 'status' = x.st END
      AND s = pg_temp.p0(x.l, x.cc);
    r := r || jsonb_build_object(x.k, pg_temp.pass(ok, s));
  END LOOP;
  -- agent posts on a ticket it did not request; no reopen
  s := pg_temp.m('u_support.view', 'm_903_reply');
  r := r || jsonb_build_object('A_agent_support.view_903_posts_no_reopen',
    pg_temp.pass(s NOT LIKE 'ERR %' AND split_part(s, ' | ', 2)::jsonb ->> 'status' = 'resolved' AND s = pg_temp.p0('u_support.view', 'm_903_reply'), s));
  s := pg_temp.m('u_sa', 'm_904_note');
  r := r || jsonb_build_object('A_super_admin_note_904_posts', pg_temp.pass(s NOT LIKE 'ERR %' AND s = pg_temp.p0('u_sa', 'm_904_note'), s));
  -- requester note: the existing refusal, unchanged
  s := pg_temp.m('u0', 'm_903_note');
  r := r || jsonb_build_object('A_requester_note_still_refused', pg_temp.pass(s LIKE 'ERR P0001 Only agents can add internal notes%', s));
  -- the fixture can tell the fix apart: P0 differs from the post matrix on >= 20 add_message cells
  n := (SELECT count(*) FROM p4170p2c_p0 p WHERE p.f = 'support_add_message/5' AND NOT pg_temp.is_agent(p.lbl)
          AND NOT pg_temp.msg_allowed(p.lbl, p.c) AND p.res NOT LIKE 'ERR %');
  r := r || jsonb_build_object('A_p0_fixture_distinguishes_fix', pg_temp.pass(n >= 20, n::text));

  -- ================= K: state =================
  s := pg_temp.state()::text;
  r := r || jsonb_build_object('K_p0_state_is_pr2b', pg_temp.pass((SELECT st FROM p4170p2c_p0_state) = pg_temp.pr2b(), (SELECT st::text FROM p4170p2c_p0_state)));
  r := r || jsonb_build_object('K_touched_bodies_equal_file_after_two_applies',
    pg_temp.pass((SELECT bool_and(s::jsonb -> e.key ->> 'md5' = e.value #>> '{}') FROM jsonb_each(post) e)
                 AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(post) k) = (SELECT array_agg(t ORDER BY t) FROM pg_temp.touched() t), s || ' vs ' || post::text));
  r := r || jsonb_build_object('K_touched_bodies_differ_from_pr2b',
    pg_temp.pass((SELECT bool_and(s::jsonb -> t ->> 'md5' <> pg_temp.pr2b() -> t ->> 'md5') FROM pg_temp.touched() t), s));
  r := r || jsonb_build_object('K_other_six_unchanged',
    pg_temp.pass((SELECT bool_and(s::jsonb -> k = pg_temp.pr2b() -> k) AND count(*) = 6 FROM jsonb_object_keys(pg_temp.pr2b()) k WHERE k NOT IN (SELECT pg_temp.touched())), s));
  r := r || jsonb_build_object('K_grants_config_volatility_unchanged',
    pg_temp.pass((SELECT bool_and(s::jsonb -> t ->> 'acl' = pg_temp.pr2b() -> t ->> 'acl' AND s::jsonb -> t ->> 'config' = pg_temp.pr2b() -> t ->> 'config'
                                  AND s::jsonb -> t ->> 'vol' = pg_temp.pr2b() -> t ->> 'vol') FROM pg_temp.touched() t)
                 AND has_function_privilege('anon', 'public.support_add_message(uuid,text,text,text,text)', 'EXECUTE')
                 AND has_function_privilege('anon', 'public.support_get_ticket_detail(uuid,text)', 'EXECUTE')
                 AND has_function_privilege('anon', 'public.support_list_events(uuid)', 'EXECUTE'), s));

  -- pre-pin stops on a drifted body
  BEGIN
    EXECUTE replace(pg_get_functiondef('public.support_list_events(uuid)'::regprocedure), 'BEGIN', 'BEGIN -- drift');
    EXECUTE $mg$__MIGRATION__$mg$;
    RAISE EXCEPTION 'PIN_DONE' USING DETAIL = 'migration applied over a drifted body';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PIN_DONE' THEN GET STACKED DIAGNOSTICS s2 = PG_EXCEPTION_DETAIL;
    ELSE s2 := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 160); END IF;
  END;
  r := r || jsonb_build_object('K_pin_stops_on_drift', pg_temp.pass(s2 LIKE 'ERR P0001 BACKLOG-4170 PR2c: public.support_list_events(uuid) body changed%', s2));

  -- K0: the rollback file restores the PR2b md5 / ACL / config / volatility on all 9
  BEGIN
    EXECUTE $rb$__ROLLBACK__$rb$;
    s2 := pg_temp.state()::text;
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s2 = PG_EXCEPTION_DETAIL;
    ELSE s2 := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 160); END IF;
  END;
  r := r || jsonb_build_object('K0_rollback_restores_pr2b', pg_temp.pass(pg_temp.js(s2) = pg_temp.pr2b(), s2));

  -- KA (applied mode only): keepr-test state before this call equals the file (touched) and PR2b (others)
  IF to_regclass('pg_temp.p4170p2c_applied') IS NOT NULL THEN
    s2 := (SELECT st::text FROM p4170p2c_applied);
    r := r || jsonb_build_object('KA_applied_state_equals_file', pg_temp.pass(s2::jsonb = s::jsonb, s2 || ' vs ' || s));
  END IF;

  RETURN r;
END $f$;

DO $drv$
DECLARE v_r jsonb;
BEGIN
  v_r := pg_temp.run();
  RAISE EXCEPTION 'P4170_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(v_r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'),
    'payload_md5', (SELECT jsonb_object_agg(lbl, jsonb_build_object('before', before, 'after', after, 'equal', before = after)) FROM p4170p2c_md5));
END
$drv$;
