-- BACKLOG-4145 M1 controls. Run with compose.py controls --with-migration (migration applied TWICE in
-- front), or after 20261108150000 is applied. Fixtures: see prelude.sql. M1 changes no policy, so
-- every control reads function output or the catalog, never a table through RLS.
-- Output: RAISE 'P4145_RESULT {total, pass, fail, reds}'.

CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
  r jsonb := '{}'::jsonb;
  s text; s2 text; s3 text; n int; ok boolean; d0 text; a0 text;
  u1 uuid := pg_temp.fx(1); u2 uuid := pg_temp.fx(2); u3 uuid := pg_temp.fx(3); u4 uuid := pg_temp.fx(4);
  u10 uuid := pg_temp.fx(10); u11 uuid := pg_temp.fx(11); u12 uuid := pg_temp.fx(12);
  NP text := 'ERR 42501 Not permitted';
  MP text := 'ERR P0001 Missing permission: users.view';
  canq text := 'SELECT to_jsonb(public.support_can_view_requester(%L::uuid))';
  devq text := 'SELECT to_jsonb(jsonb_array_length(public.admin_list_user_devices(%L)))';
  pmq text := 'SELECT jsonb_agg(to_jsonb(x) ORDER BY x.ticket_number) FROM public.pm_list_backlog_ticket_links(%L) x';
  newf text[] := ARRAY['public.support_my_requester_ids()', 'public.support_can_view_requester(uuid)',
                       'public.pm_list_backlog_ticket_links(uuid)'];
  devf text := 'public.admin_list_user_devices(uuid)';
  allf text[];
BEGIN
  allf := newf || devf;
  PERFORM pg_temp.setup();

  -- positive control on the fixtures themselves
  n := (SELECT count(*) FROM public.users WHERE id IN (SELECT pg_temp.fx(x) FROM generate_series(1, 12) x))
     + (SELECT count(*) FROM public.support_tickets WHERE id IN (SELECT pg_temp.fx(x) FROM generate_series(301, 305) x));
  r := r || jsonb_build_object('F0_fixtures_present', pg_temp.pass(n = 17, n::text));

  -- ================= support_my_requester_ids / support_can_view_requester =================
  s := pg_temp.ids_of(u1);
  s2 := (SELECT coalesce(jsonb_agg(x ORDER BY x), '[]'::jsonb)::text
           FROM (SELECT DISTINCT requester_id x FROM public.support_tickets WHERE requester_id IS NOT NULL) d);
  ok := s = s2 AND s::jsonb @> pg_temp.ids(5, 6, 8, 9)::jsonb;
  r := r || jsonb_build_object('H1_support_admin_every_requester', pg_temp.pass(ok, left(s, 120) || ' vs ' || left(s2, 120)));

  s := pg_temp.ids_of(u2);
  r := r || jsonb_build_object('H2_support_view_assigned_requesters_only', pg_temp.pass(s = pg_temp.ids(5, 8), s));

  s := pg_temp.ids_of(u3);
  r := r || jsonb_build_object('H3_support_view_nothing_assigned_empty', pg_temp.pass(s = '[]', s));

  -- reassignment in the same transaction moves access at once
  BEGIN
    s := pg_temp.call_as(u2, format(canq, pg_temp.fx(5)));
    UPDATE public.support_tickets SET assignee_id = u3 WHERE id = pg_temp.fx(301);
    s := s || '/' || pg_temp.call_as(u2, format(canq, pg_temp.fx(5)))
           || '/' || pg_temp.call_as(u3, format(canq, pg_temp.fx(5)))
           || '/' || pg_temp.ids_of(u2);
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
    ELSE s := 'ERRRB ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
  END;
  r := r || jsonb_build_object('H4_reassignment_moves_access_same_transaction',
    pg_temp.pass(s = 'true/false/true/' || pg_temp.ids(8), s));

  s := pg_temp.call_as(u2, format(canq, pg_temp.fx(7)));
  s2 := pg_temp.call_as(u2, format(canq, pg_temp.fx(8)));
  r := r || jsonb_build_object('H5_requester_email_match_gives_nothing', pg_temp.pass(s = 'false' AND s2 = 'true', s || '/' || s2));

  s := pg_temp.ids_of(u4);
  s2 := pg_temp.call_as(u4, format(canq, pg_temp.fx(9)));
  r := r || jsonb_build_object('H6_self_assigned_without_support_view_empty', pg_temp.pass(s = '[]' AND s2 = 'false', s || '/' || s2));

  s := pg_temp.ids_of(u12) || '/' || pg_temp.ids_of(u10) || '/' || pg_temp.ids_of(u11);
  r := r || jsonb_build_object('H7_other_callers_empty', pg_temp.pass(s = '[]/[]/[]', s));

  s := pg_temp.call_as(u2, 'SELECT to_jsonb(public.support_can_view_requester(NULL))');
  s2 := pg_temp.call_as(u1, format(canq, pg_temp.fx(6)));
  r := r || jsonb_build_object('H8_can_view_null_false_admin_true', pg_temp.pass(s = 'false' AND s2 = 'true', s || '/' || s2));

  s := pg_temp.ids_of(NULL, 'anon');
  s2 := pg_temp.call_as(NULL, format(canq, pg_temp.fx(5)), 'anon');
  r := r || jsonb_build_object('H9_anon_refused', pg_temp.pass(s LIKE 'ERR 42501 permission denied%' AND s2 LIKE 'ERR 42501 permission denied%', s || '/' || s2));

  s := pg_temp.ids_of(NULL);
  r := r || jsonb_build_object('H10_no_uid_empty', pg_temp.pass(s = '[]', s));

  -- ================= pm_list_backlog_ticket_links =================
  s := pg_temp.call_as(u10, format(pmq, pg_temp.fx(401)));
  s2 := (SELECT jsonb_agg(jsonb_build_object('ticket_number', t.ticket_number, 'subject', t.subject, 'status', t.status) ORDER BY t.ticket_number)::text
           FROM public.support_tickets t WHERE t.id IN (pg_temp.fx(301), pg_temp.fx(302)));
  r := r || jsonb_build_object('P1_pm_reads_three_fields', pg_temp.pass(s = s2, s || ' vs ' || s2));

  s := pg_temp.call_as(u10, format(pmq, pg_temp.fx(402)));
  r := r || jsonb_build_object('P2_pm_item_without_links_empty', pg_temp.pass(s = 'null', s));

  s := (SELECT array_agg(a.n ORDER BY a.o)::text FROM pg_proc p,
          unnest(p.proargnames, p.proargmodes::text[]) WITH ORDINALITY a(n, m, o)
         WHERE p.oid = 'public.pm_list_backlog_ticket_links(uuid)'::regprocedure AND a.m = 't');
  r := r || jsonb_build_object('P3_rpc_output_columns', pg_temp.pass(s = '{ticket_number,subject,status}', s));

  s := pg_temp.call_as(u2, format(pmq, pg_temp.fx(401))) || '|' || pg_temp.call_as(u1, format(pmq, pg_temp.fx(401)))
    || '|' || pg_temp.call_as(u4, format(pmq, pg_temp.fx(401))) || '|' || pg_temp.call_as(u12, format(pmq, pg_temp.fx(401)))
    || '|' || pg_temp.call_as(u11, format(pmq, pg_temp.fx(401))) || '|' || pg_temp.call_as(NULL, format(pmq, pg_temp.fx(401)));
  r := r || jsonb_build_object('P4_callers_without_pm_view_refused',
    pg_temp.pass(s = NP || '|' || NP || '|' || NP || '|' || NP || '|' || NP || '|' || NP, s));

  s := pg_temp.call_as(NULL, format(pmq, pg_temp.fx(401)), 'anon');
  r := r || jsonb_build_object('P5_anon_refused', pg_temp.pass(s LIKE 'ERR 42501 permission denied%', s));

  -- ================= admin_list_user_devices =================
  s := pg_temp.call_as(u12, format(devq, pg_temp.fx(5))) || '/' || pg_temp.call_as(u12, format(devq, pg_temp.fx(11)));
  r := r || jsonb_build_object('D1_users_view_reads_any_user', pg_temp.pass(s = '1/1', s));

  s := pg_temp.call_as(u2, format(devq, pg_temp.fx(5))) || '/' || pg_temp.call_as(u2, format(devq, pg_temp.fx(8)));
  r := r || jsonb_build_object('D2_support_view_reads_assigned_requester', pg_temp.pass(s = '1/0', s));

  s := pg_temp.call_as(u2, format(devq, pg_temp.fx(6))) || '/' || pg_temp.call_as(u2, format(devq, pg_temp.fx(9)))
    || '/' || pg_temp.call_as(u2, format(devq, pg_temp.fx(11)));
  r := r || jsonb_build_object('D3_support_view_other_users_refused', pg_temp.pass(s = MP || '/' || MP || '/' || MP, s));

  s := pg_temp.call_as(u1, format(devq, pg_temp.fx(6))) || '/' || pg_temp.call_as(u1, format(devq, pg_temp.fx(11)));
  r := r || jsonb_build_object('D4_support_admin_reads_requester_not_others', pg_temp.pass(s = '1/' || MP, s));

  s := pg_temp.call_as(u2, format(devq, pg_temp.fx(7)));
  r := r || jsonb_build_object('D5_requester_email_match_refused', pg_temp.pass(s = MP, s));

  s := pg_temp.call_as(u4, format(devq, pg_temp.fx(9)));
  r := r || jsonb_build_object('D6_self_assigned_without_support_view_refused', pg_temp.pass(s = MP, s));

  s := pg_temp.call_as(u10, format(devq, pg_temp.fx(5)));
  r := r || jsonb_build_object('D7_pm_only_refused', pg_temp.pass(s = MP, s));

  s := pg_temp.call_as(u11, format(devq, pg_temp.fx(11))) || '/' || pg_temp.call_as(NULL, format(devq, pg_temp.fx(5)));
  r := r || jsonb_build_object('D8_non_internal_unauthorized', pg_temp.pass(s = 'ERR P0001 Unauthorized/ERR P0001 Unauthorized', s));

  s := pg_temp.call_as(NULL, format(devq, pg_temp.fx(5)), 'anon');
  r := r || jsonb_build_object('D9_anon_refused', pg_temp.pass(s LIKE 'ERR 42501 permission denied%', s));

  -- ================= catalog =================
  n := (SELECT count(*) FROM unnest(newf) f JOIN pg_proc p ON p.oid = f::regprocedure
         WHERE p.prosecdef AND p.proconfig = ARRAY['search_path=public']
           AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
           AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
           AND has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  n := n + (SELECT count(*) FROM pg_proc p
         WHERE p.oid = devf::regprocedure AND p.prosecdef AND p.prorettype = 'jsonb'::regtype
           AND p.proconfig = ARRAY['search_path=public, extensions']
           AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
           AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
           AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
           AND has_function_privilege('service_role', p.oid, 'EXECUTE'));
  r := r || jsonb_build_object('Z1_execute_grants', pg_temp.pass(n = 4,
    n || ' of 4 compliant; ' || (SELECT string_agg(f || '=' || coalesce(p.proacl::text, 'null'), ' ') FROM unnest(allf) f JOIN pg_proc p ON p.oid = f::regprocedure)));

  s := (SELECT ps.n || '/' || ps.digest FROM p4145_policy_snapshot ps);
  s2 := (SELECT count(*) || '/' || md5(string_agg(tablename || policyname || cmd || coalesce(qual, '') || coalesce(with_check, ''), ','
           ORDER BY tablename, policyname)) FROM pg_policies WHERE schemaname = 'public');
  r := r || jsonb_build_object('Z2_no_policy_changed', pg_temp.pass(s = s2, s || ' vs ' || s2));

  -- ================= re-apply changes nothing =================
  d0 := (SELECT string_agg(md5(p.prosrc), ',' ORDER BY f) FROM unnest(allf) f JOIN pg_proc p ON p.oid = f::regprocedure);
  a0 := (SELECT string_agg(coalesce(p.proacl::text, 'null'), ',' ORDER BY f) FROM unnest(allf) f JOIN pg_proc p ON p.oid = f::regprocedure);
  BEGIN
    EXECUTE $mg$__MIGRATION__$mg$;
    s := CASE WHEN (SELECT string_agg(md5(p.prosrc), ',' ORDER BY f) FROM unnest(allf) f JOIN pg_proc p ON p.oid = f::regprocedure) = d0
               AND (SELECT string_agg(coalesce(p.proacl::text, 'null'), ',' ORDER BY f) FROM unnest(allf) f JOIN pg_proc p ON p.oid = f::regprocedure) = a0
          THEN 'same' ELSE 'changed' END;
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
    ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
  END;
  r := r || jsonb_build_object('K1_reapply_idempotent', pg_temp.pass(s = 'same', s));

  -- ================= rollback restores the pre-migration state =================
  BEGIN
    EXECUTE $rb$__ROLLBACK__$rb$;
    s := CASE WHEN (SELECT md5(prosrc) FROM pg_proc WHERE oid = devf::regprocedure) = '37208d52da7d6bc50307173b6a104422'
               AND (SELECT proconfig FROM pg_proc WHERE oid = devf::regprocedure) = ARRAY['search_path=public, extensions']
               AND has_function_privilege('anon', devf::regprocedure, 'EXECUTE')
               AND EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = devf::regprocedure AND a.grantee = 0)
               AND NOT EXISTS (SELECT 1 FROM unnest(newf) x WHERE to_regprocedure(x) IS NOT NULL)
               AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261108150000')
          THEN 'restored' ELSE 'not restored' END;
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
    ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
  END;
  r := r || jsonb_build_object('K2_rollback_restores', pg_temp.pass(s = 'restored', s));

  RETURN r;
END $f$;

DO $drv$
DECLARE v_r jsonb;
BEGIN
  v_r := pg_temp.run();
  RAISE EXCEPTION 'P4145_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(v_r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'));
END
$drv$;
