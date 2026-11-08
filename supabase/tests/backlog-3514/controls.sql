-- BACKLOG-3514 controls. Run with compose.py controls --with-migration (rollback first, then the
-- migration TWICE), or with no flag once 20261108220000 is applied. Fixtures: prelude.sql.
-- Every RPC call runs through call_as. Controls run in order; later ones see earlier writes.
-- Output: RAISE 'P3514_RESULT {total, pass, fail, reds}'.

CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
  r jsonb := '{}'::jsonb;
  s text; a text; b text; c text; d text; ok boolean;
  nf text := 'ERR P0001 Saved view not found%';
  fn text; k bigint; i int;
  rpcs text[] := ARRAY['public.broker_report_list_views(uuid,text)',
                       'public.broker_report_save_view(uuid,text,text,jsonb,jsonb,boolean,uuid)',
                       'public.broker_report_delete_view(uuid,uuid)',
                       'public.broker_report_set_default_view(uuid,text,uuid)'];
  helpers text[] := ARRAY['public._broker_report_views_gate(uuid)', 'public._broker_report_views_key_ok(text)',
                          'public._broker_report_views_immutable()'];
BEGIN
  PERFORM pg_temp.setup();

  -- ================= C1 cross-portal: one user, same key, both portals =================
  s := pg_temp.call_as(pg_temp.fx(16), pg_temp.q_list(101, 'iphone-sync'));
  r := r || jsonb_build_object('C1a_broker_list_has_no_admin_view', pg_temp.pass(s LIKE '%broker16 view%' AND s NOT LIKE '%admin16%', s));
  s := pg_temp.call_as(pg_temp.fx(16), 'SELECT public.report_list_saved_views(''iphone-sync'')');
  r := r || jsonb_build_object('C1b_admin_list_has_no_broker_view', pg_temp.pass(s LIKE '%admin16 view%' AND s NOT LIKE '%broker16%', s));

  -- ================= C2 the row's organization, never the argument =================
  -- (a) user 15 LEFT O1 (suspended), ACTIVE in O2, passes O2 with their own hidden O1 view
  s := pg_temp.call_as(pg_temp.fx(15), pg_temp.q_save(102, 'pipeline', 'hijack', false, 903));
  r := r || jsonb_build_object('C2a_leaver_update_via_other_org', pg_temp.pass(s LIKE nf AND pg_temp.row_of(903) = 'O1/pipeline/leaver view', s || ' ' || pg_temp.row_of(903)));
  s := pg_temp.call_as(pg_temp.fx(15), pg_temp.q_del(102, 903));
  r := r || jsonb_build_object('C2a_leaver_remove_via_other_org', pg_temp.pass(s LIKE nf AND pg_temp.row_of(903) <> 'gone', s));
  s := pg_temp.call_as(pg_temp.fx(15), pg_temp.q_def(102, 'pipeline', 903));
  r := r || jsonb_build_object('C2a_leaver_default_via_other_org', pg_temp.pass(s LIKE nf
    AND NOT (SELECT is_default FROM public.broker_report_saved_views WHERE id = pg_temp.fx(903)), s));
  -- (b) user 18 ACTIVE in both T (feature off) and O2 (feature on), passes O2 with their T view
  s := pg_temp.call_as(pg_temp.fx(18), pg_temp.q_save(102, 'pipeline', 'hijack', false, 906));
  r := r || jsonb_build_object('C2b_dual_member_update_via_other_org', pg_temp.pass(s LIKE nf AND pg_temp.row_of(906) = 'T/pipeline/team view', s || ' ' || pg_temp.row_of(906)));
  s := pg_temp.call_as(pg_temp.fx(18), pg_temp.q_del(102, 906));
  r := r || jsonb_build_object('C2b_dual_member_remove_via_other_org', pg_temp.pass(s LIKE nf AND pg_temp.row_of(906) <> 'gone', s));
  -- (c) outsider: O2 broker edits an O1 broker's view via O2 (refused by ownership as well)
  s := pg_temp.call_as(pg_temp.fx(10), pg_temp.q_save(102, 'pipeline', 'hijack', false, 901));
  r := r || jsonb_build_object('C2c_outsider_update', pg_temp.pass(s LIKE nf AND pg_temp.row_of(901) = 'O1/pipeline/broker view', s));

  -- ================= C3 agents and brokers see their own views only =================
  s := pg_temp.call_as(pg_temp.fx(4), pg_temp.q_list(101, 'pipeline'));
  r := r || jsonb_build_object('C3a_agent_lists_own_only', pg_temp.pass(s LIKE '%agent view%' AND s NOT LIKE '%broker view%' AND s NOT LIKE '%leaver%', s));
  s := pg_temp.call_as(pg_temp.fx(1), pg_temp.q_list(101, 'pipeline'));
  r := r || jsonb_build_object('C3b_broker_lists_own_only', pg_temp.pass(s LIKE '%broker view%' AND s NOT LIKE '%agent view%' AND s NOT LIKE '%leaver%', s));
  s := pg_temp.call_as(pg_temp.fx(4), pg_temp.q_save(101, 'pipeline', 'x', false, 901));
  r := r || jsonb_build_object('C3c_agent_updates_broker_view', pg_temp.pass(s LIKE nf AND pg_temp.row_of(901) = 'O1/pipeline/broker view', s));
  s := pg_temp.call_as(pg_temp.fx(4), pg_temp.q_del(101, 901));
  r := r || jsonb_build_object('C3d_agent_removes_broker_view', pg_temp.pass(s LIKE nf AND pg_temp.row_of(901) <> 'gone', s));
  s := pg_temp.call_as(pg_temp.fx(1), pg_temp.q_del(101, 902));
  r := r || jsonb_build_object('C3e_broker_removes_agent_view', pg_temp.pass(s LIKE nf AND pg_temp.row_of(902) <> 'gone', s));
  s := pg_temp.call_as(pg_temp.fx(4), pg_temp.q_save(101, 'pipeline', 'agent second', false, NULL));
  r := r || jsonb_build_object('C3f_agent_saves_own_view', pg_temp.pass(s LIKE '{"id"%', s));

  -- ================= C5 feature off =================
  s := pg_temp.call_as(pg_temp.fx(17), pg_temp.q_save(105, 'pipeline', 'x', false, NULL));
  r := r || jsonb_build_object('C5a_feature_off_save', pg_temp.pass(s LIKE nf, s));
  s := pg_temp.call_as(pg_temp.fx(18), pg_temp.q_list(105, 'pipeline'));
  r := r || jsonb_build_object('C5b_feature_off_list', pg_temp.pass(s LIKE nf, s));
  s := pg_temp.call_as(pg_temp.fx(18), pg_temp.q_save(105, 'pipeline', 'x', false, 906));
  r := r || jsonb_build_object('C5c_feature_off_update_own', pg_temp.pass(s LIKE nf AND pg_temp.row_of(906) = 'T/pipeline/team view', s));
  s := pg_temp.call_as(pg_temp.fx(18), pg_temp.q_def(105, 'pipeline', 906));
  r := r || jsonb_build_object('C5d_feature_off_default_own', pg_temp.pass(s LIKE nf
    AND NOT (SELECT is_default FROM public.broker_report_saved_views WHERE id = pg_temp.fx(906)), s));
  s := pg_temp.call_as(pg_temp.fx(18), pg_temp.q_def(105, 'pipeline', NULL));
  r := r || jsonb_build_object('C5e_feature_off_clear_default', pg_temp.pass(s LIKE nf, s));
  s := pg_temp.call_as(pg_temp.fx(18), pg_temp.q_del(105, 906));
  r := r || jsonb_build_object('C5f_feature_off_remove_own', pg_temp.pass(s LIKE nf AND pg_temp.row_of(906) <> 'gone', s));

  -- ================= C6 who may not use it at all; it_admin may =================
  s := pg_temp.call_as(pg_temp.fx(11), pg_temp.q_save(103, 'pipeline', 'x', false, NULL));
  r := r || jsonb_build_object('C6a_personal_owner_refused', pg_temp.pass(s LIKE nf, s));
  s := pg_temp.call_as(pg_temp.fx(14), pg_temp.q_save(101, 'pipeline', 'x', false, NULL));
  r := r || jsonb_build_object('C6b_non_member_refused', pg_temp.pass(s LIKE nf, s));
  s := pg_temp.call_as(NULL, pg_temp.q_list(101, 'pipeline'));
  r := r || jsonb_build_object('C6c_no_uid_refused', pg_temp.pass(s LIKE nf, s));
  s := pg_temp.call_as(pg_temp.fx(3), pg_temp.q_save(101, 'pipeline', 'itadm', false, NULL));
  r := r || jsonb_build_object('C6d_it_admin_saves', pg_temp.pass(s LIKE '{"id"%', s));

  -- ================= C9 a leaver's views: hidden, back on reinstatement =================
  s := pg_temp.call_as(pg_temp.fx(15), pg_temp.q_list(101, 'pipeline'));
  r := r || jsonb_build_object('C9a_leaver_list_hidden', pg_temp.pass(s LIKE nf AND pg_temp.row_of(903) = 'O1/pipeline/leaver view', s));
  UPDATE public.organization_members SET license_status = 'active' WHERE organization_id = pg_temp.fx(101) AND user_id = pg_temp.fx(15);
  s := pg_temp.call_as(pg_temp.fx(15), pg_temp.q_list(101, 'pipeline'));
  r := r || jsonb_build_object('C9b_reinstated_list_returns', pg_temp.pass(s LIKE '%leaver view%' AND s NOT LIKE '%broker view%', s));
  UPDATE public.organization_members SET license_status = 'suspended' WHERE organization_id = pg_temp.fx(101) AND user_id = pg_temp.fx(15);
  s := pg_temp.call_as(pg_temp.fx(15), pg_temp.q_list(101, 'pipeline'));
  r := r || jsonb_build_object('C9c_suspended_again_hidden', pg_temp.pass(s LIKE nf, s));

  -- ================= C10 organization, owner and report never move =================
  BEGIN
    UPDATE public.broker_report_saved_views SET organization_id = pg_temp.fx(102) WHERE id = pg_temp.fx(901);
    s := 'updated: ' || pg_temp.row_of(901);
  EXCEPTION WHEN OTHERS THEN s := 'ERR ' || SQLSTATE || ' ' || SQLERRM; END;
  r := r || jsonb_build_object('C10a_org_immutable', pg_temp.pass(s LIKE nf AND pg_temp.row_of(901) = 'O1/pipeline/broker view', s));
  BEGIN
    UPDATE public.broker_report_saved_views SET report_key = 'other' WHERE id = pg_temp.fx(901);
    s := 'updated: ' || pg_temp.row_of(901);
  EXCEPTION WHEN OTHERS THEN s := 'ERR ' || SQLSTATE || ' ' || SQLERRM; END;
  r := r || jsonb_build_object('C10b_key_immutable', pg_temp.pass(s LIKE nf AND pg_temp.row_of(901) = 'O1/pipeline/broker view', s));
  BEGIN
    UPDATE public.broker_report_saved_views SET user_id = pg_temp.fx(2) WHERE id = pg_temp.fx(901);
    s := 'updated';
  EXCEPTION WHEN OTHERS THEN s := 'ERR ' || SQLSTATE || ' ' || SQLERRM; END;
  r := r || jsonb_build_object('C10c_owner_immutable', pg_temp.pass(s LIKE nf, s));
  -- an accepted update with a different org and key in the arguments changes the name only
  s := pg_temp.call_as(pg_temp.fx(1), pg_temp.q_save(102, 'other', 'renamed', false, 901));
  r := r || jsonb_build_object('C10d_accepted_update_stays_put', pg_temp.pass(s LIKE '{"id"%' AND pg_temp.row_of(901) = 'O1/pipeline/renamed', s || ' ' || pg_temp.row_of(901)));

  -- ================= C11 pins: metric required, cap 5, counted under the lock =================
  s := pg_temp.call_as(pg_temp.fx(2), pg_temp.q_save(101, 'pipeline', 'nometric', true, NULL, NULL));
  r := r || jsonb_build_object('C11a_pin_needs_metric', pg_temp.pass(s LIKE nf, s));
  k := hashtextextended('broker_report_saved_views:' || pg_temp.fx(101)::text || ':' || pg_temp.fx(2)::text || ':pipeline', 3514);
  a := (SELECT count(*)::text FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'
          AND classid = ((k >> 32) & 4294967295)::oid AND objid = (k & 4294967295)::oid AND objsubid = 1);
  s := pg_temp.call_as(pg_temp.fx(2), pg_temp.q_save(101, 'pipeline', 'p1', true, NULL));
  b := (SELECT count(*)::text FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'
          AND classid = ((k >> 32) & 4294967295)::oid AND objid = (k & 4294967295)::oid AND objsubid = 1);
  r := r || jsonb_build_object('C11b_pin_count_takes_owner_lock', pg_temp.pass(s LIKE '{"id"%' AND a = '0' AND b = '1', s || ' before=' || a || ' after=' || b));
  FOR i IN 2..5 LOOP
    PERFORM pg_temp.call_as(pg_temp.fx(2), pg_temp.q_save(101, 'pipeline', 'p' || i, true, NULL));
  END LOOP;
  s := pg_temp.call_as(pg_temp.fx(2), pg_temp.q_save(101, 'pipeline', 'p6', true, NULL));
  c := (SELECT count(*)::text FROM public.broker_report_saved_views WHERE user_id = pg_temp.fx(2) AND pinned);
  r := r || jsonb_build_object('C11c_sixth_pin_refused', pg_temp.pass(s LIKE 'ERR P0001 At most 5%' AND c = '5', s || ' pinned=' || c));
  s := pg_temp.call_as(pg_temp.fx(2), pg_temp.q_save(101, 'pipeline', 'plain', false, NULL));
  r := r || jsonb_build_object('C11d_unpinned_save_at_cap_ok', pg_temp.pass(s LIKE '{"id"%', s));
  s := pg_temp.call_as(pg_temp.fx(2), format('SELECT public.broker_report_save_view(%L::uuid, %L, %L, %L::jsonb, %L::jsonb, true, %L::uuid)',
         pg_temp.fx(101), 'pipeline', 'plain', '{}', '{"col":"x","fn":"count"}',
         (SELECT id FROM public.broker_report_saved_views WHERE user_id = pg_temp.fx(2) AND name = 'plain')));
  r := r || jsonb_build_object('C11e_pin_by_update_at_cap_refused', pg_temp.pass(s LIKE 'ERR P0001 At most 5%', s));
  -- another report of the same owner has its own cap
  s := pg_temp.call_as(pg_temp.fx(2), pg_temp.q_save(101, 'other-report', 'q1', true, NULL));
  r := r || jsonb_build_object('C11f_cap_is_per_report', pg_temp.pass(s LIKE '{"id"%', s));

  -- ================= C12 inputs, and one refusal text =================
  s := pg_temp.call_as(pg_temp.fx(1), pg_temp.q_save(101, 'Bad Key', 'x', false, NULL));
  r := r || jsonb_build_object('C12a_key_regex', pg_temp.pass(s LIKE nf, s));
  s := pg_temp.call_as(pg_temp.fx(1), pg_temp.q_save(101, 'pipeline', 'big', false, NULL, '{"col":"x","fn":"count"}',
         jsonb_build_object('q', (SELECT string_agg(md5(g::text), '') FROM generate_series(1, 2000) g))));
  r := r || jsonb_build_object('C12b_filters_size_cap', pg_temp.pass(s LIKE nf, s));
  s := pg_temp.call_as(pg_temp.fx(1), pg_temp.q_save(101, 'pipeline', repeat('n', 121), false, NULL));
  r := r || jsonb_build_object('C12c_name_length_cap', pg_temp.pass(s LIKE nf, s));
  s := pg_temp.call_as(pg_temp.fx(1), pg_temp.q_save(101, 'pipeline', '   ', false, NULL));
  r := r || jsonb_build_object('C12d_blank_name', pg_temp.pass(s LIKE nf, s));
  s := pg_temp.call_as(pg_temp.fx(1), pg_temp.q_save(101, 'pipeline', 'arr', false, NULL, '{"col":"x","fn":"count"}', '[1,2]'));
  r := r || jsonb_build_object('C12e_filters_not_object', pg_temp.pass(s LIKE nf, s));
  a := pg_temp.call_as(pg_temp.fx(4), pg_temp.q_save(101, 'pipeline', 'x', false, 901));
  b := pg_temp.call_as(pg_temp.fx(4), pg_temp.q_save(101, 'pipeline', 'x', false, 999));
  c := pg_temp.call_as(pg_temp.fx(15), pg_temp.q_save(101, 'pipeline', 'x', false, 903));
  d := pg_temp.call_as(pg_temp.fx(14), pg_temp.q_del(101, 902));
  r := r || jsonb_build_object('C12f_one_refusal_text', pg_temp.pass(a = b AND b = c AND c = d AND a LIKE nf, a || ' | ' || b || ' | ' || c || ' | ' || d));

  -- ================= C13 default: one per owner and report =================
  -- set-default takes the pin lock for (org, user, report); user 1 has taken no lock on it so far
  k := hashtextextended('broker_report_saved_views:' || pg_temp.fx(101)::text || ':' || pg_temp.fx(1)::text || ':pipeline', 3514);
  a := (SELECT count(*)::text FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'
          AND classid = ((k >> 32) & 4294967295)::oid AND objid = (k & 4294967295)::oid AND objsubid = 1);
  s := pg_temp.call_as(pg_temp.fx(1), pg_temp.q_def(101, 'pipeline', 901));
  b := (SELECT count(*)::text FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'
          AND classid = ((k >> 32) & 4294967295)::oid AND objid = (k & 4294967295)::oid AND objsubid = 1);
  r := r || jsonb_build_object('C13d_default_takes_owner_lock', pg_temp.pass(s LIKE '{"success"%' AND a = '0' AND b = '1', s || ' before=' || a || ' after=' || b));
  a := pg_temp.call_as(pg_temp.fx(1), pg_temp.q_save(101, 'pipeline', 'second', false, NULL));
  b := pg_temp.call_as(pg_temp.fx(1), format('SELECT public.broker_report_set_default_view(%L::uuid, %L, %L::uuid)',
         pg_temp.fx(101), 'pipeline', (a::jsonb) ->> 'id'));
  c := (SELECT string_agg(name, ',') FROM public.broker_report_saved_views WHERE user_id = pg_temp.fx(1) AND is_default);
  r := r || jsonb_build_object('C13a_default_moves', pg_temp.pass(s LIKE '{"success"%' AND b LIKE '{"success"%' AND c = 'second', s || ' ' || b || ' ' || coalesce(c, 'none')));
  s := pg_temp.call_as(pg_temp.fx(1), pg_temp.q_def(101, 'pipeline', NULL));
  c := (SELECT count(*)::text FROM public.broker_report_saved_views WHERE user_id = pg_temp.fx(1) AND is_default);
  r := r || jsonb_build_object('C13b_default_cleared', pg_temp.pass(s LIKE '{"success"%' AND c = '0', s || ' ' || c));
  s := pg_temp.call_as(pg_temp.fx(4), pg_temp.q_def(101, 'pipeline', 901));
  r := r || jsonb_build_object('C13c_default_on_others_view_refused', pg_temp.pass(s LIKE nf
    AND NOT (SELECT is_default FROM public.broker_report_saved_views WHERE id = pg_temp.fx(901)), s));

  -- ================= C14 the owner removes their own view =================
  s := pg_temp.call_as(pg_temp.fx(1), pg_temp.q_del(101, 901));
  r := r || jsonb_build_object('C14_owner_removes_own', pg_temp.pass(s LIKE '{"success"%' AND pg_temp.row_of(901) = 'gone', s));

  -- ================= C4 catalog and direct access =================
  FOREACH fn IN ARRAY rpcs LOOP
    ok := NOT has_function_privilege('anon', fn::regprocedure, 'EXECUTE')
      AND has_function_privilege('authenticated', fn::regprocedure, 'EXECUTE')
      AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                       WHERE p.oid = fn::regprocedure AND x.grantee = 0 AND x.privilege_type = 'EXECUTE')
      AND (SELECT p.prosecdef AND array_to_string(p.proconfig, ';') = 'search_path=public' FROM pg_proc p WHERE p.oid = fn::regprocedure);
    r := r || jsonb_build_object('C4_rpc_grants_' || split_part(split_part(fn, '.', 2), '(', 1), pg_temp.pass(ok, fn));
  END LOOP;
  FOREACH fn IN ARRAY helpers LOOP
    ok := NOT has_function_privilege('anon', fn::regprocedure, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', fn::regprocedure, 'EXECUTE');
    r := r || jsonb_build_object('C4_helper_closed_' || split_part(split_part(fn, '.', 2), '(', 1), pg_temp.pass(ok, fn));
  END LOOP;
  ok := (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.broker_report_saved_views'::regclass)
    AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated']) ro, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) pr
                     WHERE has_table_privilege(ro, 'public.broker_report_saved_views', pr));
  r := r || jsonb_build_object('C4_table_closed_incl_truncate', pg_temp.pass(ok, 'table privilege or RLS'));
  s := pg_temp.call_as(NULL, pg_temp.q_list(101, 'pipeline'), 'anon');
  r := r || jsonb_build_object('C4_anon_call_refused', pg_temp.pass(s LIKE 'ERR 42501%', s));
  s := pg_temp.call_as(pg_temp.fx(1), 'SELECT to_jsonb(count(*)) FROM public.broker_report_saved_views');
  r := r || jsonb_build_object('C4_direct_table_read_refused', pg_temp.pass(s LIKE 'ERR 42501%', s));

  -- ================= K1 rollback restores (inside a subtransaction that always rolls back) =================
  BEGIN
    EXECUTE $rb$__ROLLBACK__$rb$;
    s := CASE WHEN to_regclass('public.broker_report_saved_views') IS NULL
               AND to_regprocedure('public.broker_report_save_view(uuid,text,text,jsonb,jsonb,boolean,uuid)') IS NULL
               AND to_regprocedure('public._broker_report_views_gate(uuid)') IS NULL
               AND NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261108220000')
          THEN 'restored' ELSE 'not restored' END;
    EXECUTE $mg$__MIGRATION__$mg$;
    s := s || '/' || CASE WHEN to_regclass('public.broker_report_saved_views') IS NOT NULL
                          AND NOT has_function_privilege('anon', 'public.broker_report_list_views(uuid,text)'::regprocedure, 'EXECUTE')
                     THEN 'reapplied' ELSE 'not reapplied' END;
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
  RAISE EXCEPTION 'P3514_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(v_r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'));
END
$drv$;
