-- BACKLOG-3511 broker half controls. Run with compose.py controls --with-migration (rollback first,
-- then the migration TWICE), or with no flag once 20261108190000 is applied. Fixtures: prelude.sql.
-- Every read runs through call_as (SELECT only), so each control sees the same fixture state.
-- Output: RAISE 'P3511_RESULT {total, pass, fail, reds}'.

CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
  r jsonb := '{}'::jsonb;
  s text; ok boolean;
  O1 text := 'o1-a13,o1-a4-1,o1-a4-2,o1-a4-3,o1-a5-1,o1-a5-2,o1-a6,o1-a7,o1-a8,o1-a9,o1-none';
  scope_q text := 'SELECT to_jsonb(public.org_report_scope(%L))';
  fn text := 'public.org_report_scope(uuid)';
  u int; st text;
BEGIN
  PERFORM pg_temp.setup();

  -- ================= full roles read every row of their own organization =================
  s := pg_temp.call_as(pg_temp.fx(1), pg_temp.read_q());
  r := r || jsonb_build_object('R1_broker_reads_all_of_org', pg_temp.pass(s = O1, s));
  s := pg_temp.call_as(pg_temp.fx(2), pg_temp.read_q());
  r := r || jsonb_build_object('R2_admin_reads_all_of_org', pg_temp.pass(s = O1, s));
  s := pg_temp.call_as(pg_temp.fx(3), pg_temp.read_q());
  r := r || jsonb_build_object('R3_it_admin_reads_all_of_org', pg_temp.pass(s = O1, s));

  -- ================= active agents read their own rows only =================
  s := pg_temp.call_as(pg_temp.fx(4), pg_temp.read_q());
  r := r || jsonb_build_object('R4_agent_A_reads_own_only', pg_temp.pass(s = 'o1-a4-1,o1-a4-2,o1-a4-3', s));
  s := pg_temp.call_as(pg_temp.fx(5), pg_temp.read_q());
  r := r || jsonb_build_object('R5_agent_B_reads_own_only', pg_temp.pass(s = 'o1-a5-1,o1-a5-2', s));

  -- ================= inactive members read nothing (every non-active status) =================
  FOR u, st IN SELECT * FROM (VALUES (6, 'pending'), (7, 'suspended'), (8, 'expired'), (9, 'unassigned')) v LOOP
    s := pg_temp.call_as(pg_temp.fx(u), pg_temp.read_q());
    r := r || jsonb_build_object('R6_inactive_agent_' || st || '_reads_0', pg_temp.pass(s = '', s));
  END LOOP;
  s := pg_temp.call_as(pg_temp.fx(13), pg_temp.read_q());
  r := r || jsonb_build_object('R7_suspended_broker_reads_0', pg_temp.pass(s = '', s));

  -- ================= another organization's broker =================
  s := pg_temp.call_as(pg_temp.fx(10), pg_temp.read_q());
  r := r || jsonb_build_object('R8_other_org_broker_reads_0_of_O1', pg_temp.pass(s = 'o2-a10,o2-a4', s));

  -- ================= personal-organization owners (both shapes on keepr-test) =================
  s := pg_temp.call_as(pg_temp.fx(11), pg_temp.read_q());
  r := r || jsonb_build_object('R9_personal_owner_admin_reads_0', pg_temp.pass(s = '', s));
  s := pg_temp.call_as(pg_temp.fx(12), pg_temp.read_q());
  r := r || jsonb_build_object('R10_personal_owner_agent_reads_0', pg_temp.pass(s = '', s));

  -- ================= no membership, no session =================
  s := pg_temp.call_as(pg_temp.fx(14), pg_temp.read_q());
  r := r || jsonb_build_object('R11_non_member_reads_0', pg_temp.pass(s = '', s));
  s := pg_temp.call_as(NULL, pg_temp.read_q());
  r := r || jsonb_build_object('R12_no_uid_reads_0', pg_temp.pass(s = '', s));
  s := pg_temp.call_as(NULL, pg_temp.read_q(), 'anon');
  r := r || jsonb_build_object('R13_anon_reads_refused', pg_temp.pass(s LIKE 'ERR 42501%', s));

  -- ================= helper answers, swept over every fixture x every org =================
  s := (SELECT string_agg(x.u || '@' || x.o || '=' || pg_temp.call_as(pg_temp.fx(x.u), format(scope_q, pg_temp.fx(x.o))), ' '
                          ORDER BY x.u, x.o)
          FROM (SELECT u0 AS u, o0 AS o FROM generate_series(1, 14) u0 CROSS JOIN generate_series(101, 104) o0) x
         WHERE x.u IN (1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14));
  ok := s = '1@101=all 1@102=null 1@103=null 1@104=null 2@101=all 2@102=null 2@103=null 2@104=null '
            '3@101=all 3@102=null 3@103=null 3@104=null 4@101=own 4@102=null 4@103=null 4@104=null '
            '5@101=own 5@102=null 5@103=null 5@104=null 6@101=null 6@102=null 6@103=null 6@104=null '
            '9@101=null 9@102=null 9@103=null 9@104=null 10@101=null 10@102=all 10@103=null 10@104=null '
            '11@101=null 11@102=null 11@103=null 11@104=null 12@101=null 12@102=null 12@103=null 12@104=null '
            '13@101=null 13@102=null 13@103=null 13@104=null 14@101=null 14@102=null 14@103=null 14@104=null';
  r := r || jsonb_build_object('H1_helper_sweep', pg_temp.pass(ok, s));

  -- ================= catalog =================
  r := r || jsonb_build_object('G1_anon_no_execute', pg_temp.pass(NOT has_function_privilege('anon', fn::regprocedure, 'EXECUTE'), 'anon has EXECUTE'));
  r := r || jsonb_build_object('G2_public_no_execute', pg_temp.pass(NOT EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = fn::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'), 'PUBLIC has EXECUTE'));
  r := r || jsonb_build_object('G3_authenticated_has_execute', pg_temp.pass(has_function_privilege('authenticated', fn::regprocedure, 'EXECUTE'), 'authenticated lacks EXECUTE'));
  s := pg_temp.call_as(NULL, format(scope_q, pg_temp.fx(101)), 'anon');
  r := r || jsonb_build_object('G4_anon_call_refused', pg_temp.pass(s LIKE 'ERR 42501%', s));
  s := (SELECT p.prosecdef::text || '/' || p.provolatile::text || '/' || coalesce(array_to_string(p.proconfig, ';'), '-')
          FROM pg_proc p WHERE p.oid = fn::regprocedure);
  r := r || jsonb_build_object('G5_definer_stable_search_path', pg_temp.pass(s = 'true/s/search_path=public', s));

  -- ================= rollback restores (inside a subtransaction that always rolls back) =================
  BEGIN
    DROP TABLE public.p3511_scratch_report;
    EXECUTE $rb$__ROLLBACK__$rb$;
    s := CASE WHEN to_regprocedure(fn) IS NULL
               AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261108190000')
          THEN 'restored' ELSE 'not restored' END;
    -- re-apply on top of the rolled-back state: the migration runs from scratch
    EXECUTE $mg$__MIGRATION__$mg$;
    s := s || '/' || CASE WHEN to_regprocedure(fn) IS NOT NULL
                          AND NOT has_function_privilege('anon', fn::regprocedure, 'EXECUTE') THEN 'reapplied' ELSE 'not reapplied' END;
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
    ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
  END;
  r := r || jsonb_build_object('K1_rollback_restores_and_reapplies', pg_temp.pass(s = 'restored/reapplied', s));

  RETURN r;
END $f$;

DO $drv$
DECLARE v_r jsonb;
BEGIN
  v_r := pg_temp.run();
  RAISE EXCEPTION 'P3511_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(v_r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'));
END
$drv$;
