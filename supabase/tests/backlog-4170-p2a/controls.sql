-- BACKLOG-4170 PR2a controls. compose.py order: [applied state] -> rollback -> prelude (fixtures + P0)
-- -> migration TWICE -> this file. Fixtures: see prelude.sql.
-- The rollback, migration and post-md5 placeholders are filled in by compose.py.
-- Output: RAISE 'P4170_RESULT {total, pass, fail, reds}'.

-- production md5(prosrc) / proacl / proconfig / provolatile, read 2026-11-09 (equal on keepr-test)
CREATE FUNCTION pg_temp.prod() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $b$
  SELECT '{"support_add_participant/4": {"acl": "{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "ab0ebdddf278d4cd42189c1108a9b424", "vol": "v"}, "support_agent_analytics/1": {"acl": "{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "04e8b2ac36c410123ffcaba2831a0dbd", "vol": "v"}, "support_assign_ticket/2": {"acl": "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "cdc27dba988c5cd2e2e1e05361372e3c", "vol": "v"}, "support_bulk_update_tickets/3": {"acl": "{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "acdd7bf7ee40bc6ba872554438045906", "vol": "v"}, "support_bulk_update_tickets/5": {"acl": "{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "b33cb66459a64d4f3074ead0abbdfb61", "vol": "v"}, "support_bulk_update_tickets/6": {"acl": "{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "51a032512a9aa2952b1e44b5de9f5514", "vol": "v"}, "support_create_template/3": {"acl": "{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "a9583ac82fb77119ab5c655602961f1a", "vol": "v"}, "support_delete_template/1": {"acl": "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "e49a16a0652947c77e1a938ebf613f3f", "vol": "v"}, "support_get_related_tickets/1": {"acl": "{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "f07af0dc30c78077ec0f92aec548cc15", "vol": "v"}, "support_get_ticket_stats/0": {"acl": "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "143268d8467069815725b63d46321c0f", "vol": "v"}, "support_link_tickets/3": {"acl": "{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "670b5c231766c25c08f138fb326b4068", "vol": "v"}, "support_list_agents/0": {"acl": "{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "c43c764d2e8774598ca42178b6278494", "vol": "v"}, "support_list_all_templates/0": {"acl": "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "9b7aab726245c7d79f4f51fc830f46a1", "vol": "v"}, "support_list_templates/0": {"acl": "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "e0b516b7e4fa7f31d3069689bd3c8c34", "vol": "v"}, "support_remove_participant/1": {"acl": "{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "5bf202181373c0a7b5263b489bdc874e", "vol": "v"}, "support_requester_recent_tickets/1": {"acl": "{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "386d6f8045eb6cbdcaa745354851bac3", "vol": "v"}, "support_search_requesters/1": {"acl": "{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "3ede1502ca6eaa20350f3eb6ee2b4620", "vol": "v"}, "support_search_tickets_for_link/2": {"acl": "{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "ff5ea5c11488dea9623d050de194a0eb", "vol": "v"}, "support_unlink_tickets/2": {"acl": "{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "471f1d402dd9eccd4f13500d75d74fdd", "vol": "v"}, "support_update_template/5": {"acl": "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "faa1972e45968cabb372a7c19f083e26", "vol": "v"}, "support_update_ticket_category/2": {"acl": "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "6d72b79f3ab18e4184ae5a6f1bebdc43", "vol": "v"}, "support_update_ticket_priority/2": {"acl": "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "e05219f24e3214566285f714ea4c575b", "vol": "v"}, "support_update_ticket_status/3": {"acl": "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}", "config": "{search_path=public}", "md5": "ca21d75b52989bb088da077908989bf3", "vol": "v"}}'::jsonb
$b$;

-- the four template-management functions (support.manage | support.admin); every other case is support.view
CREATE FUNCTION pg_temp.is_manage(c text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $b$
  SELECT c IN ('support_create_template/3', 'support_update_template/5', 'support_delete_template/1', 'support_list_all_templates/0')
$b$;

-- who is allowed each case after PR2a
CREATE FUNCTION pg_temp.allowed(c text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $b$
  SELECT CASE WHEN pg_temp.is_manage(c) THEN ARRAY['u_support.manage', 'u_support.admin', 'u_sa']
              ELSE ARRAY['u_support.view', 'u_sa'] END
$b$;

-- the reply a caller past the guard gets (read from the production body as Super Admin, P0)
CREATE FUNCTION pg_temp.expect(c text) RETURNS text LANGUAGE sql IMMUTABLE AS $b$
  SELECT CASE c
    WHEN 'support_agent_analytics/1' THEN '7'
    WHEN 'support_assign_ticket/2' THEN 'ERR P0001 Ticket not found: ' || pg_temp.fx(990)
    WHEN 'support_bulk_update_tickets/3' THEN 'ERR P0001 At least one ticket ID is required'
    WHEN 'support_bulk_update_tickets/5' THEN 'ERR P0001 At least one ticket ID is required'
    WHEN 'support_bulk_update_tickets/6' THEN 'ERR P0001 At least one ticket ID is required'
    WHEN 'support_create_template/3' THEN '"P4170p2a tpl new"'
    WHEN 'support_delete_template/1' THEN jsonb_build_object('id', pg_temp.fx(991), 'deleted', true)::text
    WHEN 'support_update_template/5' THEN jsonb_build_object('id', pg_temp.fx(991), 'updated', true)::text
    WHEN 'support_list_all_templates/0' THEN '2'
    WHEN 'support_list_templates/0' THEN '1'
    WHEN 'support_get_related_tickets/1' THEN 'ERR P0001 Ticket not found'
    WHEN 'support_get_ticket_stats/0' THEN '"object"'
    WHEN 'support_link_tickets/3' THEN 'ERR P0001 One or both tickets not found'
    WHEN 'support_unlink_tickets/2' THEN 'ERR 23503 insert or update on table "support_ticket_events" violates foreign key constraint "support_ticket_ev'
    WHEN 'support_list_agents/0' THEN '6'
    WHEN 'support_add_participant/4' THEN 'ERR 23503 insert or update on table "support_ticket_participants" violates foreign key constraint "support_tic'
    WHEN 'support_remove_participant/1' THEN jsonb_build_object('id', pg_temp.fx(993), 'removed', true)::text
    WHEN 'support_requester_recent_tickets/1' THEN '0'
    WHEN 'support_search_requesters/1' THEN '7'
    WHEN 'support_search_tickets_for_link/2' THEN '0'
    WHEN 'support_update_ticket_category/2' THEN 'ERR P0001 Ticket not found: ' || pg_temp.fx(990)
    WHEN 'support_update_ticket_priority/2' THEN 'ERR P0001 Ticket not found: ' || pg_temp.fx(990)
    WHEN 'support_update_ticket_status/3' THEN 'ERR P0001 Ticket not found: ' || pg_temp.fx(990)
  END
$b$;

-- the refusal literal in each body (exactly as the source spells it)
CREATE FUNCTION pg_temp.refusal_src(c text) RETURNS text LANGUAGE sql IMMUTABLE AS $b$
  SELECT CASE c
    WHEN 'support_assign_ticket/2' THEN 'Only authenticated agents can assign tickets'
    WHEN 'support_bulk_update_tickets/3' THEN 'Only authenticated agents can bulk update tickets'
    WHEN 'support_bulk_update_tickets/5' THEN 'Only authenticated agents can bulk update tickets'
    WHEN 'support_bulk_update_tickets/6' THEN 'Only authenticated agents can bulk update tickets'
    WHEN 'support_create_template/3' THEN 'Only authenticated agents can create templates'
    WHEN 'support_delete_template/1' THEN 'Only authenticated agents can delete templates'
    WHEN 'support_link_tickets/3' THEN 'Only authenticated agents can link tickets'
    WHEN 'support_unlink_tickets/2' THEN 'Only authenticated agents can unlink tickets'
    WHEN 'support_list_agents/0' THEN 'Access denied: only internal users can list agents'
    WHEN 'support_add_participant/4' THEN 'Only agents can add participants'
    WHEN 'support_remove_participant/1' THEN 'Only agents can remove participants'
    WHEN 'support_update_ticket_category/2' THEN 'Only authenticated agents can update ticket category'
    WHEN 'support_update_ticket_priority/2' THEN 'Only authenticated agents can update ticket priority'
    WHEN 'support_update_ticket_status/3' THEN 'Only authenticated agents can update ticket status'
    ELSE 'Support agent access required'
  END
$b$;

-- the exact refusal before PR2a for a signed-in caller without access (SQLSTATE + text)
CREATE FUNCTION pg_temp.refusal(c text) RETURNS text LANGUAGE sql IMMUTABLE AS $b$
  SELECT 'ERR ' || CASE WHEN c IN ('support_assign_ticket/2', 'support_bulk_update_tickets/3', 'support_bulk_update_tickets/5',
                                   'support_bulk_update_tickets/6', 'support_list_agents/0', 'support_add_participant/4',
                                   'support_remove_participant/1', 'support_update_ticket_category/2',
                                   'support_update_ticket_priority/2', 'support_update_ticket_status/3')
                        THEN 'P0001 ' ELSE '42501 ' END || pg_temp.refusal_src(c)
$b$;

-- five functions check for a signed-in caller before the guard; a NULL sub stops there
CREATE FUNCTION pg_temp.nullref(c text) RETURNS text LANGUAGE sql IMMUTABLE AS $b$
  SELECT CASE WHEN c IN ('support_agent_analytics/1', 'support_get_related_tickets/1', 'support_requester_recent_tickets/1',
                         'support_search_requesters/1', 'support_search_tickets_for_link/2')
              THEN 'ERR P0001 Authentication required' ELSE pg_temp.refusal(c) END
$b$;

-- the 14 signatures where PUBLIC and anon held EXECUTE
CREATE FUNCTION pg_temp.was_public(c text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $b$
  SELECT pg_temp.prod() -> c ->> 'acl' LIKE '{=X/postgres,%'
$b$;

CREATE FUNCTION pg_temp.anon_denied(c text) RETURNS text LANGUAGE sql IMMUTABLE AS $b$
  SELECT 'ERR 42501 permission denied for function ' || split_part(c, '/', 1)
$b$;

-- the guard IF condition: text between the last IF before the refusal and the refusal
CREATE FUNCTION pg_temp.guard(k text) RETURNS text LANGUAGE sql AS $b$
  WITH p AS (SELECT p.prosrc AS src FROM pg_temp.sigs() s JOIN pg_proc p ON p.oid = to_regprocedure(s.sig) WHERE s.k = $1),
       f AS (SELECT 'RAISE EXCEPTION ''' || pg_temp.refusal_src($1) || '''' AS refusal)
  SELECT substring(left(p.src, strpos(p.src, f.refusal) - 1) FROM '.*\mIF\M(.*)$') FROM p, f WHERE strpos(p.src, f.refusal) > 0
$b$;

CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
  r jsonb := '{}'::jsonb;
  s text; s2 text; g text; x record; ok boolean; want text;
  post jsonb := '__POSTMD5__'::jsonb;
  acl_after text := '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
BEGIN
  -- ================= P0: the state before PR2a (same transaction, same fixtures) =================
  s := (SELECT st::text FROM p4170p2a_p0_state);
  r := r || jsonb_build_object('P0_pre_state_is_prod', pg_temp.pass(s::jsonb = pg_temp.prod(), s));
  s := (SELECT string_agg(c || '=' || res, ' ; ') FROM p4170p2a_p0 WHERE lbl = 'u_sa' AND res IS DISTINCT FROM pg_temp.expect(c));
  r := r || jsonb_build_object('P0_super_admin_replies_are_the_pinned_body_replies',
    pg_temp.pass(s IS NULL AND (SELECT count(*) FROM p4170p2a_p0 WHERE lbl = 'u_sa') = 23, s));
  s := (SELECT string_agg(c || '=' || res, ' ; ') FROM p4170p2a_p0 WHERE lbl = 'u0_none' AND res IS DISTINCT FROM pg_temp.expect(c));
  r := r || jsonb_build_object('P0_zero_key_internal_reached_all_23_before',
    pg_temp.pass(s IS NULL AND (SELECT count(*) FROM p4170p2a_p0 WHERE lbl = 'u0_none') = 23, s));
  s := (SELECT string_agg(c || '=' || res, ' ; ') FROM p4170p2a_p0 WHERE lbl = 'anon'
         AND (res = pg_temp.anon_denied(c)) = pg_temp.was_public(c));
  r := r || jsonb_build_object('P0_anon_reached_the_14_public_bodies_before', pg_temp.pass(s IS NULL, s));

  -- ================= M: every caller x every case, after PR2a =================
  CREATE TEMP TABLE p4170p2a_m AS SELECT * FROM pg_temp.matrix();
  FOR x IN SELECT m.lbl, m.c, m.res FROM p4170p2a_m m LOOP
    want := CASE WHEN x.lbl = ANY (pg_temp.allowed(x.c)) THEN pg_temp.expect(x.c)
                 WHEN x.lbl = 'anon' THEN pg_temp.anon_denied(x.c)
                 WHEN x.lbl = 'u_nullsub' THEN pg_temp.nullref(x.c)
                 ELSE pg_temp.refusal(x.c) END;
    r := r || jsonb_build_object('M_' || x.lbl || '_' || x.c,
      pg_temp.pass(x.res = want, 'expected ' || want || ', got ' || x.res));
  END LOOP;
  r := r || jsonb_build_object('M_count_207', pg_temp.pass((SELECT count(*) FROM p4170p2a_m) = 207, (SELECT count(*) FROM p4170p2a_m)::text));

  -- ================= B0: Super Admin, customer and NULL-sub replies identical before and after =================
  FOR x IN SELECT unnest(ARRAY['u_sa', 'u_cust', 'u_nullsub']) AS lbl LOOP
    s := (SELECT string_agg(a.c || ': ' || a.res || ' -> ' || b.res, ' ; ') FROM p4170p2a_p0 a JOIN p4170p2a_m b USING (lbl, c)
           WHERE a.lbl = x.lbl AND a.res IS DISTINCT FROM b.res);
    r := r || jsonb_build_object('B0_' || x.lbl || '_unchanged',
      pg_temp.pass(s IS NULL AND (SELECT count(*) FROM p4170p2a_m WHERE lbl = x.lbl) = 23, s));
  END LOOP;

  -- ================= K1: the guard IF line holds the internal check AND the key =================
  FOR x IN SELECT k FROM pg_temp.sigs() LOOP
    g := pg_temp.guard(x.k);
    ok := g IS NOT NULL
      AND g ~ 'internal_roles'
      AND NOT g ~ '\mAND\s+NOT\M'
      AND CASE WHEN pg_temp.is_manage(x.k)
               THEN g ~ '\)\s+OR\s+NOT\s+public\.has_any_permission\((auth\.uid\(\)|v_caller_id), ARRAY\[''support\.manage'', ''support\.admin''\]\)\s+THEN\s*$'
                    AND NOT g ~ 'support\.view'
               ELSE g ~ '\)\s+OR\s+NOT\s+public\.has_permission\((auth\.uid\(\)|v_caller_id|v_adder_id), ''support\.view''\)\s+THEN\s*$' END;
    r := r || jsonb_build_object('K1_guard_' || x.k, pg_temp.pass(ok, coalesce(g, 'no guard found')));
  END LOOP;

  -- ================= K2: grants =================
  FOR x IN SELECT k, sig FROM pg_temp.sigs() LOOP
    ok := NOT has_function_privilege('anon', x.sig, 'EXECUTE')
      AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = to_regprocedure(x.sig) AND a.grantee = 0)
      AND has_function_privilege('authenticated', x.sig, 'EXECUTE')
      AND has_function_privilege('service_role', x.sig, 'EXECUTE')
      AND (SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure(x.sig)) = acl_after;
    r := r || jsonb_build_object('K2_grants_' || x.k, pg_temp.pass(ok, (SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure(x.sig))));
  END LOOP;

  -- ================= K3: applied twice; bodies equal the file; config and volatility unchanged =================
  s := pg_temp.state()::text;
  r := r || jsonb_build_object('K3_bodies_equal_file_after_two_applies',
    pg_temp.pass((SELECT bool_and(s::jsonb -> e.key ->> 'md5' = e.value #>> '{}') FROM jsonb_each(post) e) AND (SELECT count(*) FROM jsonb_object_keys(post)) = 23, s || ' vs ' || post::text));
  r := r || jsonb_build_object('K3_bodies_differ_from_prod',
    pg_temp.pass((SELECT bool_and(s::jsonb -> k ->> 'md5' <> pg_temp.prod() -> k ->> 'md5') FROM jsonb_object_keys(pg_temp.prod()) k), s));
  r := r || jsonb_build_object('K3_config_volatility_unchanged',
    pg_temp.pass((SELECT bool_and(s::jsonb -> k ->> 'config' = pg_temp.prod() -> k ->> 'config' AND s::jsonb -> k ->> 'vol' = pg_temp.prod() -> k ->> 'vol')
                    FROM jsonb_object_keys(pg_temp.prod()) k) AND (SELECT count(*) FROM jsonb_object_keys(s::jsonb)) = 23, s));

  -- ================= K4: the pre-pin stops on a changed body =================
  BEGIN
    EXECUTE replace(pg_get_functiondef('public.support_list_agents()'::regprocedure), 'BEGIN', 'BEGIN -- drift');
    EXECUTE $mg$__MIGRATION__$mg$;
    RAISE EXCEPTION 'PIN_DONE' USING DETAIL = 'migration applied over a drifted body';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'PIN_DONE' THEN GET STACKED DIAGNOSTICS s2 = PG_EXCEPTION_DETAIL;
    ELSE s2 := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 160); END IF;
  END;
  r := r || jsonb_build_object('K4_pin_stops_on_drift', pg_temp.pass(s2 LIKE 'ERR P0001 BACKLOG-4170 PR2a: public.support_list_agents() body changed%', s2));

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
  IF to_regclass('pg_temp.p4170p2a_applied') IS NOT NULL THEN
    s2 := (SELECT st::text FROM p4170p2a_applied);
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
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'));
END
$drv$;
