-- BACKLOG-4263 P11 (T-N) controls. Each returns 'PASS' or 'FAIL: <keys that did not hold>' and applies T-N itself
-- (pg_temp.tn(), the variant in force), so a mutant of T-N's text is what the control runs against. The caller runs each
-- control in a block that is undone, so T-N, its lock and every row a control writes go with it.
-- Expected answers, transcribed from the function bodies:
--   mcp_message_access: {ok:true, messages:<bool>} | {ok:false, error:'not_connected'} (20261123140000:599-601, :597)
--   mcp_list_deal_messages without the permission: _mcp_refuse('not_found'), call logged 'refused' (20261123140000:438-441)
--   mcp_authorize_approve on an expired request: _mcp_refuse('request_invalid') (20261118130000:839, :843-845)
--   mcp_authorize_view answers 'notice_version' (20261118170000:70); mcp_disconnect answers {ok:true} (20261112170000:988)
--   mcp_list_my_connection_access: {ok:true, connections:[{id, messages}]} | not_signed_in | impersonating (T-N)

-- C-N1: a connection approved before T-N stays at version 1 and never reads messages
CREATE FUNCTION pg_temp.c_n1_v1_stays() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE r0 bigint := pg_temp.reads('A'); a jsonb; l jsonb; o text;
BEGIN
  PERFORM pg_temp.tn();
  a := pg_temp.access('K1');
  l := pg_temp.lst('K1', 'dA');
  o := pg_temp.last_outcome('K1');
  RETURN pg_temp.verdict(jsonb_build_object(
    'access_false', a = '{"ok":true,"messages":false}'::jsonb,
    'list_not_found', l = '{"ok":false,"error":"not_found"}'::jsonb,
    'logged_refused', o = 'refused',
    'no_read_rows', pg_temp.reads('A') = r0,
    'version_1', pg_temp.conn_version('K1') = 1,
    'setting_2', pg_temp.setting_version() = 2));
END $c$;

-- C-N2: a new approval after T-N is stamped exactly 2 and reads the deal's messages
CREATE FUNCTION pg_temp.c_n2_new_is_2() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE ch jsonb; r0 bigint := pg_temp.reads('A'); a jsonb; l jsonb; n bigint;
BEGIN
  PERFORM pg_temp.tn();
  ch := pg_temp.chain('N2', 'A', 'claude');
  a := pg_temp.access('N2');
  l := pg_temp.lst('N2', 'dA');
  n := pg_temp.reads('A');
  RETURN pg_temp.verdict(jsonb_build_object(
    'view_2', (ch ->> 'view_version')::int = 2,
    'approve_ok', ch ->> 'approve_ok' = 'true',
    'exchange_ok', ch ->> 'exchange_ok' = 'true',
    'stamped_2', pg_temp.conn_version('N2') = 2,
    'access_true', a = '{"ok":true,"messages":true}'::jsonb,
    'list_3', l ->> 'ok' = 'true' AND jsonb_array_length(l -> 'result' -> 'messages') = 3,
    'read_rows_3', n - r0 = 3,
    'old_replaced', pg_temp.conn_version('K1') IS NULL));
END $c$;

-- C-N3: a request viewed at version 1 cannot be approved after T-N (the notice-version change expired it)
CREATE FUNCTION pg_temp.c_n3_viewed_v1_expired() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE b jsonb; v jsonb; ap jsonb;
BEGIN
  b := pg_temp.begin_req('R3', 'chatgpt');
  v := pg_temp.view_req('R3', 'A');
  PERFORM pg_temp.tn();
  ap := pg_temp.approve_req('R3', 'A');
  RETURN pg_temp.verdict(jsonb_build_object(
    'begin_ok', b ->> 'ok' = 'true',
    'viewed_at_1', (v ->> 'notice_version')::int = 1,
    'approve_refused', ap = '{"ok":false,"error":"request_invalid"}'::jsonb,
    'no_code', pg_temp.code_version('R3') IS NULL,
    'expired', pg_temp.req_live('R3') IS FALSE));
END $c$;

-- C-N4: after T-N's text this session holds EXCLUSIVE on mcp_authorization_requests
CREATE FUNCTION pg_temp.c_n4_lock_held() RETURNS text LANGUAGE plpgsql AS $c$
BEGIN
  PERFORM pg_temp.tn();
  RETURN pg_temp.verdict(jsonb_build_object('exclusive', EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks l
     WHERE l.locktype = 'relation' AND l.relation = 'public.mcp_authorization_requests'::regclass
       AND l.pid = pg_catalog.pg_backend_pid() AND l.mode = 'ExclusiveLock' AND l.granted)));
END $c$;

-- C-N5: a second run changes nothing (a request begun between the runs stays approvable, stamped 2); at version 3 it refuses
CREATE FUNCTION pg_temp.c_n5_rerun() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE v jsonb; second text; ap jsonb; third text;
BEGIN
  PERFORM pg_temp.tn();
  PERFORM pg_temp.begin_req('R5', 'chatgpt');
  v := pg_temp.view_req('R5', 'A');
  second := pg_temp.try('tn');
  ap := pg_temp.approve_req('R5', 'A');
  UPDATE public.mcp_settings SET notice_version = 3 WHERE id;
  third := pg_temp.try('tn');
  RETURN pg_temp.verdict(jsonb_build_object(
    'viewed_at_2', (v ->> 'notice_version')::int = 2,
    'second_ok', second = 'ok',
    'approve_ok', ap ->> 'ok' = 'true',
    'stamped_2', pg_temp.code_version('R5') = 2,
    'at_3_refused', third LIKE 'ERR P0001 BACKLOG-4263 T-N: mcp_settings.notice_version is 3, expected 1 or 2%',
    'stays_3', pg_temp.setting_version() = 3));
END $c$;

-- C-N6 (regression, no mutant of its own): no other path changes a version-1 connection's version
CREATE FUNCTION pg_temp.c_n6_other_paths() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE rf jsonb; d jsonb; ch jsonb; acc jsonb;
BEGIN
  PERFORM pg_temp.tn();
  rf := pg_temp.refresh('K1');
  PERFORM pg_temp.access('K1');
  PERFORM pg_temp.lst('K1', 'dA');
  acc := pg_temp.as_user0('A', 'mcp_list_my_connection_access');
  ch := pg_temp.chain('N6', 'A', 'chatgpt');
  d := pg_temp.as_user('A', 'mcp_disconnect', '%L::uuid', pg_temp.s('N6'));
  RETURN pg_temp.verdict(jsonb_build_object(
    'refresh_ok', rf ->> 'ok' = 'true',
    'other_stamped_2', ch ->> 'exchange_ok' = 'true',
    'disconnect_ok', d = '{"ok":true}'::jsonb,
    'list_ok', acc ->> 'ok' = 'true',
    'still_1', pg_temp.conn_version('K1') = 1));
END $c$;

-- C-N7: approval while messages_upload is off: stamped 2, no access until the switch is on, no new approval needed
CREATE FUNCTION pg_temp.c_n7_switch_off() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE ch jsonb; a0 jsonb; a1 jsonb;
BEGIN
  UPDATE public.cloud_release_switches SET messages_upload = false WHERE id;
  PERFORM pg_temp.tn();
  ch := pg_temp.chain('N7', 'A', 'chatgpt');
  a0 := pg_temp.access('N7');
  UPDATE public.cloud_release_switches SET messages_upload = true WHERE id;
  a1 := pg_temp.access('N7');
  RETURN pg_temp.verdict(jsonb_build_object(
    'approve_ok', ch ->> 'approve_ok' = 'true',
    'stamped_2', pg_temp.conn_version('N7') = 2,
    'off_false', a0 = '{"ok":true,"messages":false}'::jsonb,
    'on_true', a1 = '{"ok":true,"messages":true}'::jsonb));
END $c$;

-- C-N8 (regression): disconnecting a version-2 connection ends access at once; its read rows stay
CREATE FUNCTION pg_temp.c_n8_revoke() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE l0 jsonb; n0 bigint; d jsonb; a jsonb; l1 jsonb;
BEGIN
  PERFORM pg_temp.tn();
  PERFORM pg_temp.chain('N8', 'A', 'chatgpt');
  l0 := pg_temp.lst('N8', 'dA');
  n0 := pg_temp.reads('A');
  d := pg_temp.as_user('A', 'mcp_disconnect', '%L::uuid', pg_temp.s('N8'));
  a := pg_temp.access('N8');
  l1 := pg_temp.lst('N8', 'dA');
  RETURN pg_temp.verdict(jsonb_build_object(
    'read_before', l0 ->> 'ok' = 'true',
    'disconnect_ok', d = '{"ok":true}'::jsonb,
    'access_gone', a = '{"ok":false,"error":"not_connected"}'::jsonb,
    'list_gone', l1 = '{"ok":false,"error":"not_connected"}'::jsonb,
    'rows_kept', pg_temp.reads('A') = n0 AND n0 > 0));
END $c$;

-- C-N9: the AI-apps reader: own active connections only, the permission per connection, caller checks inside
CREATE FUNCTION pg_temp.c_n9_reader() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE ra jsonb; rb jsonb; so text; an text; sup jsonb;
BEGIN
  PERFORM pg_temp.tn();
  PERFORM pg_temp.chain('N9', 'A', 'chatgpt');
  ra := pg_temp.as_user0('A', 'mcp_list_my_connection_access');
  rb := pg_temp.as_user0('B', 'mcp_list_my_connection_access');
  so := pg_temp.call_as(NULL, 'SELECT public.mcp_list_my_connection_access()', 'authenticated');
  an := pg_temp.call_as(NULL, 'SELECT public.mcp_list_my_connection_access()', 'anon');
  INSERT INTO public.impersonation_sessions (admin_user_id, target_user_id, status, expires_at, session_expires_at)
  VALUES (pg_temp.f('A'), pg_temp.f('B'), 'active', now() + interval '1 hour', now() + interval '1 hour');
  sup := pg_temp.as_user0('A', 'mcp_list_my_connection_access');
  RETURN pg_temp.verdict(jsonb_build_object(
    'a_two', jsonb_array_length(ra -> 'connections') = 2,
    'a_keys', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(ra -> 'connections') e
                           WHERE (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k) IS DISTINCT FROM ARRAY['id', 'messages']),
    'a_k1_false', ra -> 'connections' @> jsonb_build_array(jsonb_build_object('id', pg_temp.s('K1'), 'messages', false)),
    'a_n9_true', ra -> 'connections' @> jsonb_build_array(jsonb_build_object('id', pg_temp.s('N9'), 'messages', true)),
    'b_own_only', rb = jsonb_build_object('ok', true, 'connections', jsonb_build_array(jsonb_build_object('id', pg_temp.s('KB1'), 'messages', false))),
    'signed_out', pg_temp.j(so) = '{"ok":false,"error":"not_signed_in"}'::jsonb,
    'anon_denied', an LIKE 'ERR 42501 %',
    'support', sup = '{"ok":false,"error":"impersonating"}'::jsonb));
END $c$;

-- C-N9b: the reader follows the permission, not the switch
CREATE FUNCTION pg_temp.c_n9b_not_switch() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE r jsonb;
BEGIN
  PERFORM pg_temp.tn();
  PERFORM pg_temp.chain('N9b', 'A', 'chatgpt');
  UPDATE public.cloud_release_switches SET messages_upload = false WHERE id;
  r := pg_temp.as_user0('A', 'mcp_list_my_connection_access');
  RETURN pg_temp.verdict(jsonb_build_object(
    'true_while_off', r -> 'connections' @> jsonb_build_array(jsonb_build_object('id', pg_temp.s('N9b'), 'messages', true)),
    'access_false_while_off', pg_temp.access('N9b') = '{"ok":true,"messages":false}'::jsonb));
END $c$;

-- C-N10: grants of every new function
CREATE FUNCTION pg_temp.c_n10_grants() RETURNS text LANGUAGE plpgsql AS $c$
BEGIN
  PERFORM pg_temp.tn();
  RETURN pg_temp.verdict(jsonb_build_object(
    'reader_acl', pg_temp.fn_acl('public.mcp_list_my_connection_access()') = 'authenticated=X/postgres,postgres=X/postgres',
    'reader_no_anon', NOT has_function_privilege('anon', 'public.mcp_list_my_connection_access()', 'EXECUTE'),
    'reader_no_service', NOT has_function_privilege('service_role', 'public.mcp_list_my_connection_access()', 'EXECUTE'),
    'expire_acl', pg_temp.fn_acl('public._mcp_notice_change_expires_requests()') = 'postgres=X/postgres',
    'fixed_acl', pg_temp.fn_acl('public._mcp_connection_version_fixed()') = 'postgres=X/postgres'));
END $c$;

-- C-N11: the rollback refuses while a version-2 connection exists; afterwards it restores version-1 behaviour
CREATE FUNCTION pg_temp.c_n11_rollback() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE first text; second text; ch jsonb; v jsonb := '{}';
BEGIN
  PERFORM pg_temp.tn();
  PERFORM pg_temp.chain('N11', 'A', 'chatgpt');
  first := pg_temp.try('rb');
  v := v || jsonb_build_object(
    -- the rollback counts every connection at version 2 or later (by design); only the refusal is asserted here
    'refused', first LIKE 'ERR P0001 ROLLBACK 20261123150000: % connection(s) hold approval page version 2 or later%',
    'refused_count', coalesce(substring(first FROM 'ROLLBACK 20261123150000: ([0-9]+) connection\(s\)')::int > 0, false),
    'unchanged', pg_temp.setting_version() = 2 AND pg_temp.has_trigger('mcp_connections_version_fixed'));
  DELETE FROM public.mcp_connections WHERE id = pg_temp.f('N11');
  second := pg_temp.try('rb');
  ch := pg_temp.chain('N11b', 'A', 'chatgpt');
  RETURN pg_temp.verdict(v || jsonb_build_object(
    'second_ok', second = 'ok',
    'setting_1', pg_temp.setting_version() = 1,
    'reader_gone', pg_catalog.to_regprocedure('public.mcp_list_my_connection_access()') IS NULL,
    'triggers_gone', NOT pg_temp.has_trigger('mcp_connections_version_fixed') AND NOT pg_temp.has_trigger('mcp_settings_notice_change_expires_requests'),
    'new_is_1', (ch ->> 'view_version')::int = 1 AND pg_temp.conn_version('N11b') = 1,
    'new_no_access', pg_temp.access('N11b') = '{"ok":true,"messages":false}'::jsonb));
END $c$;

-- C-N13: a notice-version change made outside T-N (a plain UPDATE) also expires a request viewed before it
CREATE FUNCTION pg_temp.c_n13_out_of_band() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE v jsonb; ap jsonb;
BEGIN
  PERFORM pg_temp.tn();
  PERFORM pg_temp.begin_req('R13', 'chatgpt');
  v := pg_temp.view_req('R13', 'A');
  UPDATE public.mcp_settings SET notice_version = 3 WHERE id;
  ap := pg_temp.approve_req('R13', 'A');
  RETURN pg_temp.verdict(jsonb_build_object(
    'viewed_at_2', (v ->> 'notice_version')::int = 2,
    'approve_refused', ap = '{"ok":false,"error":"request_invalid"}'::jsonb,
    'expired', pg_temp.req_live('R13') IS FALSE));
END $c$;

-- C-N14: an UPDATE of a connection's version is refused (as postgres and as service_role); other columns still change
CREATE FUNCTION pg_temp.c_n14_fixed() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE pg_err text := 'none'; sr text; sr_other text;
BEGIN
  PERFORM pg_temp.tn();
  BEGIN
    UPDATE public.mcp_connections SET notice_version = 2 WHERE id = pg_temp.f('K1');
  EXCEPTION WHEN OTHERS THEN
    pg_err := SQLSTATE || ' ' || SQLERRM;
  END;
  sr := pg_temp.call_as(NULL, format('WITH u AS (UPDATE public.mcp_connections SET notice_version = 2 WHERE id = %L::uuid RETURNING 1) SELECT to_jsonb(count(*)) FROM u', pg_temp.s('K1')), 'service_role');
  sr_other := pg_temp.call_as(NULL, format('WITH u AS (UPDATE public.mcp_connections SET last_used_at = now() WHERE id = %L::uuid RETURNING 1) SELECT to_jsonb(count(*)) FROM u', pg_temp.s('K1')), 'service_role');
  RETURN pg_temp.verdict(jsonb_build_object(
    'postgres_refused', pg_err LIKE 'P0001 mcp_connections.notice_version cannot be changed%',
    'service_refused', sr LIKE 'ERR P0001 mcp_connections.notice_version cannot be changed%',
    'service_other_column', sr_other = '1',
    'still_1', pg_temp.conn_version('K1') = 1));
END $c$;

-- C-N15: T-N applies with its own trigger present; the trigger is what expires the pending requests (viewed or not)
CREATE FUNCTION pg_temp.c_n15_apply_expires() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE res text; lb boolean;
BEGIN
  PERFORM pg_temp.begin_req('R15a', 'chatgpt');
  PERFORM pg_temp.begin_req('R15b', 'chatgpt');
  PERFORM pg_temp.view_req('R15b', 'A');
  lb := pg_temp.req_live('R15a') AND pg_temp.req_live('R15b');
  res := pg_temp.try('tn');
  RETURN pg_temp.verdict(jsonb_build_object(
    'live_before', lb,
    'applied', res = 'ok',
    'setting_2', pg_temp.setting_version() = 2,
    'unviewed_expired', pg_temp.req_live('R15a') IS FALSE,
    'viewed_expired', pg_temp.req_live('R15b') IS FALSE,
    'trigger_present', pg_temp.has_trigger('mcp_settings_notice_change_expires_requests')));
END $c$;

-- C-N16: the value written is '-infinity' (earlier than the start of every transaction, so no approve or view whose
-- transaction began before the bump can accept the request); it covers a pending request whose expiry time has already
-- passed by the bump's clock, and a change made outside T-N writes the same value
CREATE FUNCTION pg_temp.c_n16_expiry_value() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE ea timestamptz; eb timestamptz;
BEGIN
  PERFORM pg_temp.begin_req('R16a', 'chatgpt');
  PERFORM pg_temp.view_req('R16a', 'A');
  PERFORM pg_temp.begin_req('R16b', 'chatgpt');
  UPDATE public.mcp_authorization_requests SET expires_at = now() - interval '1 second' WHERE id = pg_temp.tx('rid:R16b');
  PERFORM pg_temp.tn();
  -- read before the next begin: mcp_authorize_begin deletes requests whose expires_at < now() (20261118130000:563-564)
  ea := pg_temp.req_expires('R16a');
  eb := pg_temp.req_expires('R16b');
  PERFORM pg_temp.begin_req('R16c', 'chatgpt');
  UPDATE public.mcp_settings SET notice_version = 3 WHERE id;
  RETURN pg_temp.verdict(jsonb_build_object(
    'viewed_neg_infinity', ea = '-infinity'::timestamptz,
    'lapsed_neg_infinity', eb = '-infinity'::timestamptz,
    'out_of_band_neg_infinity', pg_temp.req_expires('R16c') = '-infinity'::timestamptz));
END $c$;
