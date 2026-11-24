-- BACKLOG-4265 controls. Each returns 'PASS' or 'FAIL: <detail>' and runs in a subtransaction that is undone.
-- The two pinned ACL strings in c10 are filled in by gen.py.

-- c01: on each relation of blocks A, B and C service_role holds no table privilege of any type, no column privilege,
-- no sequence privilege and no ACL entry. The detail names every relation that still holds one.
CREATE FUNCTION pg_temp.c01_privileges() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE bad text[] := pg_temp.sr_holds65(ARRAY['A', 'B', 'C']);
BEGIN
  RETURN CASE WHEN cardinality(bad) = 0 THEN 'PASS' ELSE 'FAIL: ' || array_to_string(bad, ',') END;
END $c$;

-- c02: as service_role, SELECT, INSERT, UPDATE and DELETE on each table of blocks A and C end in 42501.
CREATE FUNCTION pg_temp.c02_statements_a_c() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE bad text[] := pg_temp.sr_statements65(ARRAY['A', 'C']);
BEGIN
  RETURN CASE WHEN cardinality(bad) = 0 THEN 'PASS' ELSE 'FAIL: ' || array_to_string(bad, ',') END;
END $c$;

-- c03: the migration text runs a second time without error and leaves c01 passing.
CREATE FUNCTION pg_temp.c03_rerun() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE again text[];
BEGIN
  BEGIN
    EXECUTE pg_temp.tx65('migration');
  EXCEPTION WHEN OTHERS THEN
    RETURN 'FAIL: second run ' || SQLSTATE;
  END;
  again := pg_temp.sr_holds65(ARRAY['A', 'B', 'C']);
  RETURN pg_temp.pass(cardinality(again) = 0, array_to_string(again, ','));
END $c$;

-- c04: the erase functions as service_role: claim (dry run) answers, and scrub (live) on user A scrubs the message of
-- A's deal from computer IB (A's active computer is IA).
CREATE FUNCTION pg_temp.c04_erase_as_service_role() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE who text; cl jsonb; sc jsonb; m record;
BEGIN
  who := pg_temp.call_as(NULL, 'SELECT to_jsonb(current_user::text)', 'service_role');
  cl := pg_temp.j(pg_temp.call_as(NULL, 'SELECT to_jsonb(public.cloud_blob_erase_claim(true))', 'service_role'));
  sc := pg_temp.j(pg_temp.call_as(NULL, format('SELECT to_jsonb(public.cloud_blob_erase_scrub(%L::uuid, %L::uuid, false, 1000))',
                                                gen_random_uuid(), pg_temp.s('A')), 'service_role'));
  SELECT x.subject, x.body_text, x.removed_at INTO m FROM public.cloud_deal_messages x WHERE x.id = pg_temp.f('m_inact');
  -- the claim covers the whole database: its detail is its JSON type and top-level keys only, never a value
  RETURN pg_temp.pass(who = '"service_role"' AND jsonb_typeof(cl) = 'object' AND sc ->> 'state' = 'scrubbed'
                      AND m.subject IS NULL AND m.body_text IS NULL AND m.removed_at IS NOT NULL,
                      jsonb_build_object('who', pg_temp.short65(who), 'claim_type', jsonb_typeof(cl), 'claim_keys', pg_temp.keys65(cl),
                                         'claim_sqlstate', pg_temp.state65(cl), 'scrub_state', sc ->> 'state', 'scrub_sqlstate', pg_temp.state65(sc),
                                         'scrub_counts', jsonb_build_object('scrubbed', sc -> 'scrubbed', 'files', sc -> 'files', 'messages', sc -> 'messages'),
                                         'scrubbed_row', m.removed_at IS NOT NULL AND m.subject IS NULL)::text);
END $c$;

-- c05: the message tools as anon return user A's message to A's approval-page-2 connection.
CREATE FUNCTION pg_temp.c05_tools_as_anon() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE who text; g jsonb; l jsonb;
BEGIN
  who := pg_temp.call_as(NULL, 'SELECT to_jsonb(current_user::text)', 'anon');
  l := pg_temp.lst('K2', pg_temp.s('dA'), NULL, NULL, 20, NULL);
  g := pg_temp.getm('K2', pg_temp.s('m_lin'), 1);
  RETURN pg_temp.pass(who = '"anon"' AND l ->> 'ok' = 'true' AND g ->> 'ok' = 'true'
                      AND g -> 'result' -> 'message' ->> 'body_text' = E'Line 1\nLine 2',
                      jsonb_build_object('who', pg_temp.short65(who), 'list_ok', l ->> 'ok', 'list_error', l ->> 'error', 'list_sqlstate', pg_temp.state65(l),
                                         'get_ok', g ->> 'ok', 'get_error', g ->> 'error', 'get_sqlstate', pg_temp.state65(g),
                                         'body_equal', g -> 'result' -> 'message' ->> 'body_text' = E'Line 1\nLine 2')::text);
END $c$;

-- c06: as user A (authenticated): a message upload is applied, and A reads A's own rows.
CREATE FUNCTION pg_temp.c06_upload_as_authenticated() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE who text; r jsonb; n_own text; n_all bigint;
BEGIN
  who := pg_temp.call_as(pg_temp.f('A'), 'SELECT to_jsonb(current_user::text)', 'authenticated');
  r := pg_temp.as_user('A', 'cloud_upsert_messages', '%L::uuid, %L::uuid, %L::uuid, %L::jsonb', pg_temp.s('A'), pg_temp.s('IA'), pg_temp.s('dA'),
         jsonb_build_array(pg_temp.mrow('m_c06', 'email', 'Upload', 'x', '{"from":"a@example.test","to":["b@example.test"]}',
                                        '2026-04-01T10:00:00.000Z', NULL, NULL, false, 'thr-c06'))::text);
  n_own := pg_temp.call_as(pg_temp.f('A'), 'SELECT to_jsonb(count(*)) FROM public.cloud_deal_messages', 'authenticated');
  n_all := (SELECT count(*) FROM public.cloud_deal_messages WHERE owner_user_id = pg_temp.f('A'));
  RETURN pg_temp.pass(who = '"authenticated"' AND r ->> 'ok' = 'true' AND r -> 'results' -> 0 ->> 'status' = 'applied'
                      AND n_own = n_all::text,
                      jsonb_build_object('who', pg_temp.short65(who), 'upload_ok', r ->> 'ok', 'upload_status', r -> 'results' -> 0 ->> 'status',
                                         'upload_error', r ->> 'error', 'upload_sqlstate', pg_temp.state65(r), 'own', pg_temp.short65(n_own), 'rows', n_all)::text);
END $c$;

-- c07: the EXECUTE grants of the functions naming these relations are as before the apply.
CREATE FUNCTION pg_temp.c07_function_execute() RETURNS text LANGUAGE plpgsql AS $c$
BEGIN
  RETURN pg_temp.pass(pg_temp.fn_exec65() = (SELECT v #>> '{}' FROM pg_temp.t_out WHERE k = 'fn_exec_before'),
                      'functions service_role can execute: ' || jsonb_array_length(pg_temp.fn_sr65()));
END $c$;

-- c08: default privileges are as before the apply.
CREATE FUNCTION pg_temp.c08_default_privileges() RETURNS text LANGUAGE plpgsql AS $c$
BEGIN
  RETURN pg_temp.pass(pg_temp.default_acl65() = (SELECT v #>> '{}' FROM pg_temp.t_out WHERE k = 'default_acl_before'), pg_temp.default_acl65());
END $c$;

-- c10: the rollback file restores, on each relation, exactly the service_role ACL items it held before the apply, and
-- leaves every other role's items as before the apply.
CREATE FUNCTION pg_temp.c10_rollback() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE bad text := '';
BEGIN
  BEGIN
    EXECUTE pg_temp.tx65('rollback');
  EXCEPTION WHEN OTHERS THEN
    RETURN 'FAIL: rollback ' || SQLSTATE || CASE WHEN SQLERRM LIKE 'ROLLBACK%' THEN ' (its own check)' ELSE '' END;
  END;
  SELECT coalesce(string_agg(x.name, ',' ORDER BY x.name COLLATE "C"), '') INTO bad
    FROM pg_temp.t65_rel x
   WHERE pg_temp.sr_acl65(x.name) IS DISTINCT FROM CASE x.kind WHEN 'S' THEN '@@SEQ_ACL@@' ELSE '@@TABLE_ACL@@' END;
  IF pg_temp.other_acl65() IS DISTINCT FROM (SELECT v #>> '{}' FROM pg_temp.t_out WHERE k = 'other_acl_before') THEN
    bad := bad || ' other roles changed';
  END IF;
  IF (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261123160000') <> 0 THEN
    bad := bad || ' ledger row kept';
  END IF;
  RETURN pg_temp.pass(bad = '', bad);
END $c$;

-- c13: the ACL items of anon, authenticated, PUBLIC and mcp_reader are as before the apply, and are: authenticated
-- SELECT on blocks A and C, nothing else.
CREATE FUNCTION pg_temp.c13_other_roles() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE bad text;
BEGIN
  SELECT coalesce(string_agg(x.name || '=' || pg_temp.api_acl65(x.name), ',' ORDER BY x.name COLLATE "C"), '') INTO bad
    FROM pg_temp.t65_rel x
   WHERE pg_temp.api_acl65(x.name) IS DISTINCT FROM CASE WHEN x.blk IN ('A', 'C') THEN 'authenticated:SELECT' ELSE '' END;
  RETURN pg_temp.pass(bad = '' AND pg_temp.other_acl65() = (SELECT v #>> '{}' FROM pg_temp.t_out WHERE k = 'other_acl_before'),
                      'differs: ' || bad || ' fingerprint ' || CASE WHEN pg_temp.other_acl65() = (SELECT v #>> '{}' FROM pg_temp.t_out WHERE k = 'other_acl_before')
                                                                    THEN 'same' ELSE 'changed' END);
END $c$;

-- c14: as service_role, SELECT, INSERT, UPDATE and DELETE on each table of block B end in 42501.
CREATE FUNCTION pg_temp.c14_statements_b() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE bad text[] := pg_temp.sr_statements65(ARRAY['B']);
BEGIN
  RETURN CASE WHEN cardinality(bad) = 0 THEN 'PASS' ELSE 'FAIL: ' || array_to_string(bad, ',') END;
END $c$;

-- c15: service_role holds no privilege on mcp_call_log_id_seq.
CREATE FUNCTION pg_temp.c15_sequence() RETURNS text LANGUAGE plpgsql AS $c$
BEGIN
  RETURN pg_temp.pass(NOT has_sequence_privilege('service_role', 'public.mcp_call_log_id_seq'::regclass, 'USAGE')
                      AND NOT has_sequence_privilege('service_role', 'public.mcp_call_log_id_seq'::regclass, 'SELECT')
                      AND NOT has_sequence_privilege('service_role', 'public.mcp_call_log_id_seq'::regclass, 'UPDATE'), pg_temp.sr_acl65('mcp_call_log_id_seq'));
END $c$;

-- c18: the migration's pre-check, run as mcp_reader, refuses with its current_user message.
CREATE FUNCTION pg_temp.c18_precheck_role() RETURNS text LANGUAGE plpgsql AS $c$
DECLARE who text; q text := pg_temp.tx65('precheck');
BEGIN
  BEGIN
    SET LOCAL ROLE mcp_reader;
    who := current_user;
    IF who IS DISTINCT FROM 'mcp_reader' THEN
      RAISE EXCEPTION 'ROLE %', who;
    END IF;
    EXECUTE q;
    RESET ROLE;
    RETURN 'FAIL: the pre-check ran to its end as ' || who;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    RETURN pg_temp.pass(SQLERRM LIKE '4265 pre-check: current_user is mcp_reader, not postgres%',
                        SQLSTATE || CASE WHEN SQLERRM LIKE '4265 pre-check:%' THEN ' (another pre-check refusal)' ELSE '' END);
  END;
END $c$;

-- report only, never a control: user B removed (as postgres), then B's rows left in blocks A and C
CREATE FUNCTION pg_temp.r16_cascade() RETURNS jsonb LANGUAGE plpgsql AS $c$
DECLARE o jsonb;
BEGIN
  BEGIN
    DELETE FROM auth.users WHERE id = pg_temp.f('B');
    o := jsonb_build_object('messages', (SELECT count(*) FROM public.cloud_deal_messages WHERE owner_user_id = pg_temp.f('B')),
                            'deals', (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = pg_temp.f('B')),
                            'settings', (SELECT count(*) FROM public.cloud_autosave_settings WHERE user_id = pg_temp.f('B')));
    RAISE EXCEPTION 'undo-r16';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'undo-r16' THEN o := jsonb_build_object('error', SQLSTATE); END IF;
  END;
  RETURN o;
END $c$;
