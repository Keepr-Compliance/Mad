-- BACKLOG-4170 PR2b controls. compose.py order: [applied state] -> rollback -> prelude (fixtures + P0)
-- -> migration TWICE -> this file. Fixtures: see prelude.sql.
-- The rollback, migration and post-md5 placeholders are filled in by compose.py.
-- Output: RAISE 'P4170_RESULT {total, pass, fail, reds, payload_md5}'.

-- production md5(prosrc) / proacl / proconfig / provolatile, read 2026-11-10 (equal on keepr-test)
CREATE FUNCTION pg_temp.prod() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $b$
  SELECT jsonb_object_agg(k, jsonb_build_object('md5', m, 'acl', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}',
                                                'config', '{search_path=public}', 'vol', 'v'))
    FROM (VALUES
      ('support_add_message/5', 'e3e727b1bfe3b691d9dfabf42cfbd1f3'),
      ('support_get_ticket_detail/2', 'b928028c9f9593a1f93969f4b8369cf7'),
      ('support_list_tickets/10', '5766828b06209e1eea2bddbe9b2fde50'),
      ('support_add_attachment/6', 'aa3a50264023fc32fee00d6d4143fc45'),
      ('support_add_diagnostic_attachment/6', 'a297e2cf5e4d12477635396471a394b5'),
      ('support_delete_own_attachment/1', '2b572da7a34406c679369645cb11eb4f'),
      ('support_list_attachments/1', '38d3854b45e5280ceb12e1bdc92e273f'),
      ('support_list_events/1', 'c1d3c37c7eccf1ef9fc87e584f5cce97'),
      ('support_record_attachment_access/1', '6dd6d0b646e5787ef3bf65e6d19848ef')
    ) v(k, m)
$b$;

-- the one production line each body changes, and its replacement (K5: nothing else differs)
CREATE FUNCTION pg_temp.swap() RETURNS TABLE (k text, old text, new text) LANGUAGE sql IMMUTABLE AS $b$
  VALUES
    ('support_add_message/5', $l$    v_is_agent := EXISTS (SELECT 1 FROM internal_roles WHERE user_id = auth.uid());$l$,
                              $l$    v_is_agent := public.has_permission(auth.uid(), 'support.view');$l$),
    ('support_get_ticket_detail/2', $l$  v_is_agent := EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id);$l$,
                                    $l$  v_is_agent := public.has_permission(v_caller_id, 'support.view');$l$),
    ('support_list_tickets/10', $l$  v_is_agent := EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id);$l$,
                                $l$  v_is_agent := public.has_permission(v_caller_id, 'support.view');$l$),
    ('support_add_attachment/6', $l$    OR EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_uploader_id)$l$,
                                 $l$    OR public.has_permission(v_uploader_id, 'support.view')$l$),
    ('support_add_diagnostic_attachment/6', $l$    OR EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller)$l$,
                                            $l$    OR public.has_permission(v_caller, 'support.view')$l$),
    ('support_delete_own_attachment/1', $l$    OR EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller)$l$,
                                        $l$    OR public.has_any_permission(v_caller, ARRAY['support.manage', 'support.admin'])$l$),
    ('support_list_attachments/1', $l$  v_is_internal := EXISTS (
    SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller
  );$l$, $l$  v_is_internal := public.has_permission(v_caller, 'support.view');$l$),
    ('support_list_events/1', $l$  v_is_internal := EXISTS (
    SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller
  );$l$, $l$  v_is_internal := public.has_permission(v_caller, 'support.view');$l$),
    ('support_record_attachment_access/1', $l$  v_is_internal := EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller);$l$,
                                           $l$  v_is_internal := public.has_permission(v_caller, 'support.view');$l$)
$b$;

-- P0 reply for (caller, case)
CREATE FUNCTION pg_temp.p0(l text, cc text) RETURNS text LANGUAGE sql AS $b$
  SELECT res FROM p4170p2b_p0 WHERE lbl = l AND c = cc
$b$;

-- M reply for (caller, case)
CREATE FUNCTION pg_temp.m(l text, cc text) RETURNS text LANGUAGE plpgsql AS $b$
BEGIN RETURN (SELECT res FROM p4170p2b_m WHERE lbl = l AND c = cc); END
$b$;

-- the reply each caller must get after PR2b, read from the production body in P0:
--   requesters, signed-out callers, Super Admin and support.view + support.manage: their own P0 reply;
--   u0 and the users.view decoy: their twin (same id, no internal role) = the requester path;
--   u_support.view: its own P0 reply, except deleting an attachment on a ticket it did not request,
--   where it now takes the requester path (support.manage | support.admin override);
--   u_support.manage / u_support.admin alone (no support.view): the requester path, except the
--   delete override, which they keep.
CREATE FUNCTION pg_temp.is_del(cc text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $b$
  SELECT cc IN ('x_cust', 'x_u0', 'x_other', 'x_missing')
$b$;
CREATE FUNCTION pg_temp.want(l text, cc text) RETURNS text LANGUAGE sql AS $b$
  SELECT CASE
    WHEN l IN ('u0', 'u_other_users.view') THEN pg_temp.p0(l || '_as_cust', cc)
    WHEN l = 'u_support.view' AND pg_temp.is_del(cc) THEN pg_temp.p0('u_support.view_as_cust', cc)
    WHEN l IN ('u_support.manage', 'u_support.admin') AND NOT pg_temp.is_del(cc) THEN pg_temp.p0(l || '_as_cust', cc)
    ELSE pg_temp.p0(l, cc) END
$b$;

-- message / attachment counts in a support_get_ticket_detail reply
CREATE FUNCTION pg_temp.notes(s text) RETURNS int LANGUAGE sql AS $b$
  SELECT count(*)::int FROM jsonb_array_elements(pg_temp.js(split_part(s, ' | ', 1)) -> 'messages') e WHERE e ->> 'message_type' = 'internal_note'
$b$;
CREATE FUNCTION pg_temp.nmsg(s text) RETURNS int LANGUAGE sql AS $b$
  SELECT jsonb_array_length(pg_temp.js(s) -> 'messages')
$b$;
CREATE FUNCTION pg_temp.natt(s text) RETURNS int LANGUAGE sql AS $b$
  SELECT jsonb_array_length(pg_temp.js(s) -> 'attachments')
$b$;
CREATE FUNCTION pg_temp.total(s text) RETURNS int LANGUAGE sql AS $b$
  SELECT (pg_temp.js(s) ->> 'total_count')::int
$b$;
CREATE FUNCTION pg_temp.alen(s text) RETURNS int LANGUAGE sql AS $b$
  SELECT jsonb_array_length(pg_temp.js(s))
$b$;

CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
  r jsonb := '{}'::jsonb;
  s text; s2 text; x record; ok boolean; want text; src text;
  post jsonb := '__POSTMD5__'::jsonb;
BEGIN
  -- ================= P0: the state before PR2b (same transaction, same fixtures) =================
  s := (SELECT st::text FROM p4170p2b_p0_state);
  r := r || jsonb_build_object('P0_pre_state_is_prod', pg_temp.pass(s::jsonb = pg_temp.prod(), s));
  r := r || jsonb_build_object('P0_count_510', pg_temp.pass((SELECT count(*) FROM p4170p2b_p0) = 510, (SELECT count(*) FROM p4170p2b_p0)::text));
  -- the fixtures tell agent from requester in the production body (twins are not vacuous)
  r := r || jsonb_build_object('P0_u0_agent_sees_note_on_own_ticket',
    pg_temp.pass(pg_temp.notes(pg_temp.p0('u0', 'd_u0')) = 1 AND pg_temp.notes(pg_temp.p0('u0_as_cust', 'd_u0')) = 0
                 AND pg_temp.nmsg(pg_temp.p0('u0_as_cust', 'd_u0')) = 1, pg_temp.p0('u0_as_cust', 'd_u0')));
  r := r || jsonb_build_object('P0_u0_agent_reads_other_ticket',
    pg_temp.pass(pg_temp.p0('u0', 'd_other') NOT LIKE 'ERR%', left(pg_temp.p0('u0', 'd_other'), 120)));
  r := r || jsonb_build_object('P0_u0_agent_adds_note',
    pg_temp.pass(pg_temp.p0('u0', 'm_u0_note') NOT LIKE 'ERR%', pg_temp.p0('u0', 'm_u0_note')));
  s := (SELECT string_agg(c, ',') FROM p4170p2b_p0 a WHERE a.lbl = 'u0'
          AND a.res IS NOT DISTINCT FROM pg_temp.p0('u0_as_cust', a.c));
  r := r || jsonb_build_object('P0_u0_differs_from_twin_on_every_function',
    pg_temp.pass((SELECT count(DISTINCT a.f) FROM p4170p2b_p0 a WHERE a.lbl = 'u0'
                    AND a.res IS DISTINCT FROM pg_temp.p0('u0_as_cust', a.c)) = 9, 'same on: ' || coalesce(s, '')));
  r := r || jsonb_build_object('P0_view_deletes_other_attachment',
    pg_temp.pass(pg_temp.p0('u_support.view', 'x_other') LIKE '{"deleted": true, "already_absent": false}%'
                 AND pg_temp.p0('u_support.view_as_cust', 'x_other') = 'ERR P0001 Not authorised to delete this attachment',
                 pg_temp.p0('u_support.view', 'x_other') || ' / ' || pg_temp.p0('u_support.view_as_cust', 'x_other')));

  -- ================= M: every caller x every case, after PR2b =================
  CREATE TEMP TABLE p4170p2b_m AS SELECT * FROM pg_temp.matrix(false);
  FOR x IN SELECT m.lbl, m.c, m.res FROM p4170p2b_m m LOOP
    want := pg_temp.want(x.lbl, x.c);
    r := r || jsonb_build_object('M_' || x.lbl || '_' || x.c,
      pg_temp.pass(x.res IS NOT DISTINCT FROM want AND want IS NOT NULL, 'expected ' || left(coalesce(want, 'null'), 180) || ', got ' || left(coalesce(x.res, 'null'), 180)));
  END LOOP;
  r := r || jsonb_build_object('M_count_340', pg_temp.pass((SELECT count(*) FROM p4170p2b_m) = 340, (SELECT count(*) FROM p4170p2b_m)::text));

  -- ================= B0: signed-out, customer, NULL-sub, Super Admin and view+manage byte-identical =================
  FOR x IN SELECT unnest(ARRAY['anon', 'u_nullsub', 'u_cust', 'u_sa', 'u_view+manage']) AS lbl LOOP
    s := (SELECT string_agg(a.c, ',') FROM p4170p2b_p0 a JOIN p4170p2b_m b USING (lbl, c)
           WHERE a.lbl = x.lbl AND a.res IS DISTINCT FROM b.res);
    r := r || jsonb_build_object('B0_' || x.lbl || '_unchanged_34',
      pg_temp.pass(s IS NULL AND (SELECT count(*) FROM p4170p2b_m WHERE lbl = x.lbl) = 34
                   AND (SELECT count(DISTINCT f) FROM p4170p2b_m WHERE lbl = x.lbl) = 9, s));
  END LOOP;
  -- u_support.view: exactly the delete-on-another-ticket cases differ
  s := (SELECT string_agg(a.c, ',' ORDER BY a.c) FROM p4170p2b_p0 a JOIN p4170p2b_m b USING (lbl, c)
         WHERE a.lbl = 'u_support.view' AND a.res IS DISTINCT FROM b.res);
  r := r || jsonb_build_object('B0_support.view_only_delete_differs', pg_temp.pass(s = 'x_cust,x_other,x_u0', s));

  -- ================= D: explicit outcomes (not read from P0) =================
  -- u0 (zero-key internal, requester of 903): no internal note anywhere, cannot add one
  r := r || jsonb_build_object('D_u0_own_ticket_no_note',
    pg_temp.pass(pg_temp.m('u0', 'd_u0') NOT LIKE 'ERR%' AND pg_temp.notes(pg_temp.m('u0', 'd_u0')) = 0
                 AND pg_temp.nmsg(pg_temp.m('u0', 'd_u0')) = 1 AND pg_temp.natt(pg_temp.m('u0', 'd_u0')) = 2, left(pg_temp.m('u0', 'd_u0'), 200)));
  r := r || jsonb_build_object('D_u0_add_note_refused',
    pg_temp.pass(pg_temp.m('u0', 'm_u0_note') = 'ERR P0001 Only agents can add internal notes', pg_temp.m('u0', 'm_u0_note')));
  r := r || jsonb_build_object('D_u0_reply_reopens_as_requester',
    pg_temp.pass(pg_temp.m('u0', 'm_u0_reply') LIKE '%"status": "in_progress"%' AND pg_temp.m('u0', 'm_u0_reply') LIKE '%"first_response": false%', pg_temp.m('u0', 'm_u0_reply')));
  r := r || jsonb_build_object('D_u0_search_note_0',
    pg_temp.pass(pg_temp.total(pg_temp.m('u0', 'l_note')) = 0 AND pg_temp.total(pg_temp.p0('u0', 'l_note')) = 4, pg_temp.m('u0', 'l_note')));
  r := r || jsonb_build_object('D_u0_list_own_only',
    pg_temp.pass(pg_temp.total(pg_temp.m('u0', 'l_subj')) = 1 AND pg_temp.total(pg_temp.m('u0', 'l_email')) = 0, left(pg_temp.m('u0', 'l_subj'), 120)));
  r := r || jsonb_build_object('D_u0_attachments_own_no_note',
    pg_temp.pass(pg_temp.alen(pg_temp.m('u0', 'la_u0')) = 2 AND pg_temp.m('u0', 'la_u0') NOT LIKE '%p4170p2b-note.txt%', left(pg_temp.m('u0', 'la_u0'), 120)));
  r := r || jsonb_build_object('D_u0_read_logged_as_requester',
    pg_temp.pass(pg_temp.m('u0', 'r_u0') = '{"logged": true} | ["attachment_read:p4170p2b-plain.txt:requester"]'
                 AND pg_temp.p0('u0', 'r_u0') = '{"logged": true} | ["attachment_read:p4170p2b-plain.txt:internal"]', pg_temp.m('u0', 'r_u0')));
  FOR x IN SELECT * FROM (VALUES
      ('d_other', 'ERR P0001 Access denied: you can only view your own tickets'),
      ('m_other_note', 'ERR P0001 Only agents can add internal notes'),
      ('a_other', 'ERR 42501 Not authorised to attach to this ticket'),
      ('g_other', 'ERR P0001 Not authorised to attach to this ticket'),
      ('x_other', 'ERR P0001 Not authorised to delete this attachment'),
      ('la_other', '[]'),
      ('le_other', '[]'),
      ('r_other', 'ERR P0001 Not authorised to read this attachment')) v(cc, w) LOOP
    FOR s2 IN SELECT unnest(ARRAY['u0', 'u_other_users.view']) LOOP
      r := r || jsonb_build_object('D_' || s2 || '_refused_' || x.cc, pg_temp.pass(pg_temp.m(s2, x.cc) = x.w, pg_temp.m(s2, x.cc)));
    END LOOP;
  END LOOP;
  r := r || jsonb_build_object('D_other_users.view_lists_nothing',
    pg_temp.pass(pg_temp.total(pg_temp.m('u_other_users.view', 'l_subj')) = 0 AND pg_temp.total(pg_temp.m('u_other_users.view', 'l_email')) = 0, pg_temp.m('u_other_users.view', 'l_subj')));
  -- agents keep the agent view
  r := r || jsonb_build_object('D_view_sees_note_on_any_ticket',
    pg_temp.pass(pg_temp.notes(pg_temp.m('u_support.view', 'd_other')) = 1 AND pg_temp.total(pg_temp.m('u_support.view', 'l_note')) = 4
                 AND pg_temp.total(pg_temp.m('u_support.view', 'l_email')) = 2 AND pg_temp.alen(pg_temp.m('u_support.view', 'la_other')) = 3, left(pg_temp.m('u_support.view', 'd_other'), 120)));
  r := r || jsonb_build_object('D_view_adds_note',
    pg_temp.pass(pg_temp.m('u_support.view', 'm_other_note') LIKE '{"ticket_id": %"message_type": "internal_note"%', pg_temp.m('u_support.view', 'm_other_note')));
  r := r || jsonb_build_object('D_view_read_logged_as_internal',
    pg_temp.pass(pg_temp.m('u_support.view', 'r_other') = '{"logged": true} | ["attachment_read:p4170p2b-plain.txt:internal"]', pg_temp.m('u_support.view', 'r_other')));
  -- delete override: support.manage | support.admin (reversible default, PR2b-d)
  r := r || jsonb_build_object('D_view_delete_other_refused',
    pg_temp.pass(pg_temp.m('u_support.view', 'x_other') = 'ERR P0001 Not authorised to delete this attachment', pg_temp.m('u_support.view', 'x_other')));
  FOR s2 IN SELECT unnest(ARRAY['u_support.manage', 'u_support.admin', 'u_sa', 'u_view+manage']) LOOP
    r := r || jsonb_build_object('D_' || s2 || '_delete_other_allowed',
      pg_temp.pass(pg_temp.m(s2, 'x_other') LIKE '{"deleted": true, "already_absent": false} | {"events": ["attachment_deleted_by_requester:p4170p2b-plain.txt"], "row_left": false}', pg_temp.m(s2, 'x_other')));
  END LOOP;
  -- support.manage / support.admin without support.view: requester path (no note, no other ticket)
  FOR s2 IN SELECT unnest(ARRAY['u_support.manage', 'u_support.admin']) LOOP
    r := r || jsonb_build_object('D_' || s2 || '_alone_is_requester',
      pg_temp.pass(pg_temp.m(s2, 'd_other') = 'ERR P0001 Access denied: you can only view your own tickets'
                   AND pg_temp.m(s2, 'm_other_note') = 'ERR P0001 Only agents can add internal notes'
                   AND pg_temp.total(pg_temp.m(s2, 'l_note')) = 0 AND pg_temp.m(s2, 'la_other') = '[]',
                   pg_temp.m(s2, 'd_other')));
  END LOOP;
  -- requester and signed-out paths
  r := r || jsonb_build_object('D_cust_reads_email_only_ticket',
    pg_temp.pass(pg_temp.m('u_cust', 'd_cust_email') NOT LIKE 'ERR%' AND pg_temp.notes(pg_temp.m('u_cust', 'd_cust_email')) = 0
                 AND pg_temp.total(pg_temp.m('u_cust', 'l_subj')) = 2, left(pg_temp.m('u_cust', 'd_cust_email'), 120)));
  r := r || jsonb_build_object('D_cust_other_denied',
    pg_temp.pass(pg_temp.m('u_cust', 'd_other') = 'ERR P0001 Access denied: you can only view your own tickets', pg_temp.m('u_cust', 'd_other')));
  r := r || jsonb_build_object('D_anon_reads_by_email',
    pg_temp.pass(pg_temp.m('anon', 'd_by_email') NOT LIKE 'ERR%' AND pg_temp.notes(pg_temp.m('anon', 'd_by_email')) = 0, left(pg_temp.m('anon', 'd_by_email'), 120)));
  r := r || jsonb_build_object('D_anon_bad_email_denied',
    pg_temp.pass(pg_temp.m('anon', 'd_bad_email') = 'ERR P0001 Access denied: email does not match ticket requester', pg_temp.m('anon', 'd_bad_email')));
  r := r || jsonb_build_object('D_anon_replies_by_email',
    pg_temp.pass(pg_temp.m('anon', 'm_by_email_reply') LIKE '%"sender_set": false%' AND pg_temp.m('anon', 'm_by_email_reply') LIKE '%"status": "in_progress"%', pg_temp.m('anon', 'm_by_email_reply')));
  r := r || jsonb_build_object('D_anon_list_attachments_events_empty',
    pg_temp.pass(pg_temp.m('anon', 'la_cust') = '[]' AND pg_temp.m('anon', 'le_cust') = '[]', pg_temp.m('anon', 'la_cust') || pg_temp.m('anon', 'le_cust')));

  -- ================= payload md5 per caller (all 34 replies, case order), before vs after =================
  CREATE TEMP TABLE p4170p2b_md5 AS
    SELECT cl.lbl,
           (SELECT md5(string_agg(a.c || '=' || a.res, E'\n' ORDER BY a.c)) FROM p4170p2b_p0 a WHERE a.lbl = cl.lbl) AS before,
           (SELECT md5(string_agg(b.c || '=' || b.res, E'\n' ORDER BY b.c)) FROM p4170p2b_m b WHERE b.lbl = cl.lbl) AS after
      FROM pg_temp.callers() cl;

  -- ================= K1: no internal_roles; the helper and key per function =================
  FOR x IN SELECT k, sig FROM pg_temp.sigs() LOOP
    src := (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(x.sig));
    ok := src IS NOT NULL AND src !~ 'internal_roles'
      AND CASE WHEN x.k = 'support_delete_own_attachment/1'
               THEN src ~ 'OR public\.has_any_permission\(v_caller, ARRAY\[''support\.manage'', ''support\.admin''\]\)' AND src !~ 'support\.view'
               ELSE (SELECT count(*) FROM regexp_matches(src, 'public\.has_permission\((auth\.uid\(\)|v_caller_id|v_caller|v_uploader_id), ''support\.view''\)', 'g')) = 1
                    AND src !~ 'has_any_permission' END;
    r := r || jsonb_build_object('K1_key_' || x.k, pg_temp.pass(ok, left(coalesce(src, 'not found'), 200)));
  END LOOP;
  r := r || jsonb_build_object('K1_internal_0_of_9_helper_9_of_9',
    pg_temp.pass((SELECT count(*) FILTER (WHERE p.prosrc ~ 'internal_roles') = 0 AND count(*) FILTER (WHERE p.prosrc ~ 'public\.has_(any_)?permission\(') = 9
                    FROM pg_temp.sigs() s JOIN pg_proc p ON p.oid = to_regprocedure(s.sig)), NULL));

  -- ================= K5: only the one line changed (requester branches byte-for-byte) =================
  FOR x IN SELECT w.k, w.old, w.new, s.sig FROM pg_temp.swap() w JOIN pg_temp.sigs() s USING (k) LOOP
    src := (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(x.sig));
    r := r || jsonb_build_object('K5_only_line_changed_' || x.k,
      pg_temp.pass((length(src) - length(replace(src, x.new, ''))) / length(x.new) = 1
                   AND md5(replace(src, x.new, x.old)) = pg_temp.prod() -> x.k ->> 'md5', md5(replace(src, x.new, x.old))));
  END LOOP;

  -- ================= K2: grants unchanged (production ACL on all 9) =================
  FOR x IN SELECT k, sig FROM pg_temp.sigs() LOOP
    ok := has_function_privilege('anon', x.sig, 'EXECUTE')
      AND has_function_privilege('authenticated', x.sig, 'EXECUTE')
      AND has_function_privilege('service_role', x.sig, 'EXECUTE')
      AND (SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure(x.sig)) = pg_temp.prod() -> x.k ->> 'acl';
    r := r || jsonb_build_object('K2_grants_unchanged_' || x.k, pg_temp.pass(ok, (SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure(x.sig))));
  END LOOP;

  -- ================= K3: applied twice; bodies equal the file; config and volatility unchanged =================
  s := pg_temp.state()::text;
  r := r || jsonb_build_object('K3_bodies_equal_file_after_two_applies',
    pg_temp.pass((SELECT bool_and(s::jsonb -> e.key ->> 'md5' = e.value #>> '{}') FROM jsonb_each(post) e) AND (SELECT count(*) FROM jsonb_object_keys(post)) = 9, s || ' vs ' || post::text));
  r := r || jsonb_build_object('K3_bodies_differ_from_prod',
    pg_temp.pass((SELECT bool_and(s::jsonb -> k ->> 'md5' <> pg_temp.prod() -> k ->> 'md5') FROM jsonb_object_keys(pg_temp.prod()) k), s));
  r := r || jsonb_build_object('K3_config_volatility_unchanged',
    pg_temp.pass((SELECT bool_and(s::jsonb -> k ->> 'config' = pg_temp.prod() -> k ->> 'config' AND s::jsonb -> k ->> 'vol' = pg_temp.prod() -> k ->> 'vol')
                    FROM jsonb_object_keys(pg_temp.prod()) k) AND (SELECT count(*) FROM jsonb_object_keys(s::jsonb)) = 9, s));

  -- ================= K4: the pre-pin stops on a changed body =================
  BEGIN
    EXECUTE replace(pg_get_functiondef('public.support_list_events(uuid)'::regprocedure), 'BEGIN', 'BEGIN -- drift');
    EXECUTE $mg$__MIGRATION__$mg$;
    RAISE EXCEPTION 'PIN_DONE' USING DETAIL = 'migration applied over a drifted body';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PIN_DONE' THEN GET STACKED DIAGNOSTICS s2 = PG_EXCEPTION_DETAIL;
    ELSE s2 := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 160); END IF;
  END;
  r := r || jsonb_build_object('K4_pin_stops_on_drift', pg_temp.pass(s2 LIKE 'ERR P0001 BACKLOG-4170 PR2b: public.support_list_events(uuid) body changed%', s2));

  -- ================= K0: the rollback file restores production md5 / ACL / config / volatility =================
  BEGIN
    EXECUTE $rb$__ROLLBACK__$rb$;
    s2 := pg_temp.state()::text;
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s2 = PG_EXCEPTION_DETAIL;
    ELSE s2 := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 160); END IF;
  END;
  r := r || jsonb_build_object('K0_rollback_restores_prod', pg_temp.pass(pg_temp.js(s2) = pg_temp.prod(), s2));

  -- ================= KA (applied mode only): keepr-test state before this call equals the file =================
  IF to_regclass('pg_temp.p4170p2b_applied') IS NOT NULL THEN
    s2 := (SELECT st::text FROM p4170p2b_applied);
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
    'payload_md5', (SELECT jsonb_object_agg(lbl, jsonb_build_object('before', before, 'after', after, 'equal', before = after)) FROM p4170p2b_md5));
END
$drv$;
