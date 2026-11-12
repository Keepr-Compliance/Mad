-- BACKLOG-3513 PR-2 DB controls. Venue: keepr-test ONLY. Composed by compose.py after the migration
-- (applied twice) and prelude.sql. ONE call, ONE transaction ending in RAISE: nothing persists.
-- Every control runs as `authenticated` through pg_temp.call_as (SET LOCAL ROLE + jwt claims);
-- C5_current_user asserts that once. Output: RAISE 'P3513B_RESULT {total, pass, fail, reds}'.
-- Controls are order-dependent (state carries forward); comments name the state each one expects.

CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
DECLARE
  r jsonb := '{}'::jsonb;
  s text; n int; t timestamptz; bad text[] := '{}'; nonempty int := 0;
  v record; st text;
  NF text := 'ERR P0001 Report not found';
  OK text := '{"success": true}';
  O1 uuid := pg_temp.fx(101);
  ALL_O1 text := '[301, 303, 304, 306, 308, 310, 311, 312, 313, 315]';
  pub text[] := ARRAY[
    'public.broker_report_scope(uuid,uuid)',
    'public.broker_report_submissions_rows(uuid,uuid,text,uuid,timestamptz,timestamptz,text,integer,integer)',
    'public.broker_report_def_list(uuid)', 'public.broker_report_def_get(uuid)',
    'public.broker_report_def_create(uuid,text,text,text,jsonb,text)',
    'public.broker_report_def_update(uuid,text,text,jsonb,text,timestamptz)',
    'public.broker_report_def_delete(uuid)', 'public.broker_report_share_list(uuid)',
    'public.broker_report_share_candidates(uuid)', 'public.broker_report_share_set(uuid,jsonb,text)',
    'public.broker_report_share_remove(uuid,text,text)', 'public.broker_report_set_general_access(uuid,text)',
    'public.broker_report_transfer(uuid,uuid)', 'public.broker_report_take_over(uuid)'];
  priv text[] := ARRAY[
    'public._broker_report_member_role(uuid,uuid)', 'public._broker_report_level(uuid)',
    'public._broker_report_audit(uuid,uuid,text,text,jsonb)', 'public._broker_report_person_name(uuid)',
    'public._broker_report_definitions_immutable()'];
  sset text := 'SELECT public.broker_report_share_set(%L::uuid, %L::jsonb, %L)';
  srem text := 'SELECT public.broker_report_share_remove(%L::uuid, %L, %L)';
  sgen text := 'SELECT public.broker_report_set_general_access(%L::uuid, %L)';
  sxfer text := 'SELECT public.broker_report_transfer(%L::uuid, %L::uuid)';
  stake text := 'SELECT public.broker_report_take_over(%L::uuid)';
  sdel text := 'SELECT public.broker_report_def_delete(%L::uuid)';
  supd text := 'SELECT public.broker_report_def_update(%L::uuid, %L, NULL, ''{}''::jsonb, %L, %L::timestamptz)';
  sscope text := 'SELECT public.broker_report_scope(%L::uuid, %s)';
BEGIN
  PERFORM pg_temp.setup();

  -- ===== K0 fixtures sane =====
  r := r || jsonb_build_object('K0_fixtures', pg_temp.pass(
    public._org_feature_allowed(O1, 'broker_reports')
    AND public._org_feature_allowed(O1, 'broker_portal_access')
    AND NOT public._org_feature_allowed(pg_temp.fx(105), 'broker_reports')
    AND public._org_feature_allowed(pg_temp.fx(106), 'broker_reports')
    AND NOT public._org_feature_allowed(pg_temp.fx(106), 'broker_portal_access')
    AND (SELECT count(*) FROM public.transaction_submissions WHERE id::text LIKE '00000000-0000-3513-8200-%') = 19,
    format('reports %s/%s portal %s/%s team %s org4 %s/%s staff %s subs %s',
      public._org_feature_allowed(O1, 'broker_reports'), public._org_feature_allowed(O1, 'broker_portal_access'),
      public._org_feature_allowed(pg_temp.fx(106), 'broker_reports'), public._org_feature_allowed(pg_temp.fx(106), 'broker_portal_access'),
      public._org_feature_allowed(pg_temp.fx(105), 'broker_reports'), public._org_feature_allowed(pg_temp.fx(106), 'broker_reports'),
      public._org_feature_allowed(pg_temp.fx(106), 'broker_portal_access'), public.has_permission(pg_temp.fx(16), 'organizations.view'),
      (SELECT count(*) FROM public.transaction_submissions WHERE id::text LIKE '00000000-0000-3513-8200-%'))));

  -- ===== C5 =====
  r := r || jsonb_build_object('C5_current_user', pg_temp.pass(
    pg_temp.call_as(1, 'SELECT to_jsonb(current_user::text)') = 'authenticated', 'not authenticated'));
  s := pg_temp.call_as(1, format('SELECT to_jsonb(public._broker_report_level(%L::uuid))', pg_temp.fx(401)));
  r := r || jsonb_build_object('C5_level_private', pg_temp.pass(s LIKE 'ERR 42501%', s));
  s := pg_temp.call_as(1, format('SELECT to_jsonb(public._org_feature_allowed(%L::uuid, ''broker_reports''))', O1));
  r := r || jsonb_build_object('C5_feature_private', pg_temp.pass(s LIKE 'ERR 42501%', s));
  s := pg_temp.call_as(1, pg_temp.q_rows(101, NULL));
  r := r || jsonb_build_object('C5_rows_callable', pg_temp.pass(s NOT LIKE 'ERR%', s));

  -- ===== D8 catalog =====
  SELECT count(*) INTO n FROM unnest(pub) x JOIN pg_proc p ON p.oid = to_regprocedure(x)
   WHERE has_function_privilege('authenticated', p.oid, 'EXECUTE')
     AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
     AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0);
  r := r || jsonb_build_object('D8_public_grants', pg_temp.pass(n = 14, n || ' of 14'));
  SELECT count(*) INTO n FROM unnest(priv) x JOIN pg_proc p ON p.oid = to_regprocedure(x)
   WHERE NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
     AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
     AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0);
  r := r || jsonb_build_object('D8_private_revoked', pg_temp.pass(n = 5, n || ' of 5'));
  SELECT count(*) INTO n FROM unnest(ARRAY['public.broker_report_definitions', 'public.broker_report_definition_grants']) tb
   WHERE (SELECT relrowsecurity FROM pg_class WHERE oid = tb::regclass)
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname || '.' || tablename = tb)
     AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated']) ro,
                       unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) pr
                     WHERE has_table_privilege(ro, tb, pr));
  r := r || jsonb_build_object('D8_tables_locked', pg_temp.pass(n = 2, n || ' of 2'));
  -- every SECURITY DEFINER function among the new ones checks auth.uid() first; F6 is INVOKER and no
  -- DEFINER function reads transaction_submissions
  SELECT count(*) INTO n FROM unnest(pub || priv) x JOIN pg_proc p ON p.oid = to_regprocedure(x)
   WHERE p.prosecdef AND (p.prosrc NOT LIKE '%v_uid IS NULL THEN%' OR p.prosrc ILIKE '%transaction_submissions%');
  r := r || jsonb_build_object('D1_catalog_invoker', pg_temp.pass(
    n = 0 AND NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(pub[2])), n || ' definer violations'));

  -- ===== D1 / D2 / D3: scope comes from the VIEWER; heads exact =====
  r := r || jsonb_build_object('D1_agent_owner_own_rows', pg_temp.pass(pg_temp.call_as(5, pg_temp.q_rows(101, 401)) = '[301, 303, 304]',
    pg_temp.call_as(5, pg_temp.q_rows(101, 401))));
  r := r || jsonb_build_object('D1_agent_viewer_own_rows', pg_temp.pass(pg_temp.call_as(6, pg_temp.q_rows(101, 401)) = '[306, 307, 315]',
    pg_temp.call_as(6, pg_temp.q_rows(101, 401))));
  r := r || jsonb_build_object('D2_broker_views_agent_report_all', pg_temp.pass(pg_temp.call_as(1, pg_temp.q_rows(101, 401)) = ALL_O1,
    pg_temp.call_as(1, pg_temp.q_rows(101, 401))));
  r := r || jsonb_build_object('D3_own_viewer_B2', pg_temp.pass(pg_temp.call_as(2, pg_temp.q_rows(101, 402)) = '[309]',
    pg_temp.call_as(2, pg_temp.q_rows(101, 402))));
  r := r || jsonb_build_object('D3_own_owner_B1_all', pg_temp.pass(pg_temp.call_as(1, pg_temp.q_rows(101, 402)) = ALL_O1,
    pg_temp.call_as(1, pg_temp.q_rows(101, 402))));
  r := r || jsonb_build_object('D3_own_editor_A1_all', pg_temp.pass(pg_temp.call_as(3, pg_temp.q_rows(101, 402)) = ALL_O1,
    pg_temp.call_as(3, pg_temp.q_rows(101, 402))));
  r := r || jsonb_build_object('D3_own_agent_editor_G2_own', pg_temp.pass(pg_temp.call_as(6, pg_temp.q_rows(101, 402)) = '[306, 307, 315]',
    pg_temp.call_as(6, pg_temp.q_rows(101, 402))));

  -- ===== D4: canceled organization (service off) =====
  s := pg_temp.call_as(11, format(sscope, pg_temp.fx(103), 'NULL'));
  r := r || jsonb_build_object('D4_scope_service_off', pg_temp.pass(
    s NOT LIKE 'ERR%' AND s::jsonb ->> 'effective_scope' = 'own' AND (s::jsonb ->> 'service_off')::boolean, s));
  r := r || jsonb_build_object('D4_code_report_own_rows', pg_temp.pass(pg_temp.call_as(11, pg_temp.q_rows(103, NULL)) = '[320]',
    pg_temp.call_as(11, pg_temp.q_rows(103, NULL))));
  s := pg_temp.call_as(11, format(sscope, pg_temp.fx(103), quote_literal(pg_temp.fx(403)) || '::uuid'));
  r := r || jsonb_build_object('D4_def_all_scope_own', pg_temp.pass(
    s NOT LIKE 'ERR%' AND s::jsonb ->> 'effective_scope' = 'own' AND s::jsonb ->> 'level' = 'owner', s));
  r := r || jsonb_build_object('D4_def_rows_own', pg_temp.pass(pg_temp.call_as(11, pg_temp.q_rows(103, 403)) = '[320]',
    pg_temp.call_as(11, pg_temp.q_rows(103, 403))));
  r := r || jsonb_build_object('D4_agent_positive', pg_temp.pass(pg_temp.call_as(12, pg_temp.q_rows(103, NULL)) = '[321, 322]',
    pg_temp.call_as(12, pg_temp.q_rows(103, NULL))));

  -- ===== D16: parity with the page's algorithm, every status filter x every viewer =====
  FOR v IN SELECT * FROM (VALUES (1, 101, NULL::int, false), (5, 101, NULL, true), (6, 101, NULL, true),
                                 (3, 101, NULL, false), (4, 101, NULL, false), (2, 101, 402, true),
                                 (6, 101, 402, true), (1, 101, 402, false), (11, 103, NULL, true),
                                 (12, 103, NULL, true)) AS x(u, o, d, own) LOOP
    FOREACH st IN ARRAY ARRAY['all', 'submitted', 'new', 'pending', 'resubmitted', 'under_review',
                              'needs_changes', 'approved', 'rejected'] LOOP
      IF pg_temp.call_as(v.u, pg_temp.q_rows(v.o, v.d, st)) IS DISTINCT FROM pg_temp.call_as(v.u, pg_temp.q_oracle(v.o, v.own, st)) THEN
        bad := bad || format('u%s/d%s/%s:%s<>%s', v.u, v.d, st, pg_temp.call_as(v.u, pg_temp.q_rows(v.o, v.d, st)),
                             pg_temp.call_as(v.u, pg_temp.q_oracle(v.o, v.own, st)));
      END IF;
      IF pg_temp.call_as(v.u, pg_temp.q_oracle(v.o, v.own, st)) <> '[]' THEN nonempty := nonempty + 1; END IF;
    END LOOP;
  END LOOP;
  r := r || jsonb_build_object('D16_parity_sweep', pg_temp.pass(cardinality(bad) = 0 AND nonempty >= 40,
    'nonempty=' || nonempty || ' ' || array_to_string(bad[1:4], ' ; ')));
  s := pg_temp.call_as(1, format('SELECT jsonb_build_object(''n'', count(*), ''total'', max(total_count)) '
         'FROM public.broker_report_submissions_rows(%L::uuid, NULL, NULL, NULL, NULL, NULL, ''oldest'', 3, 0)', O1));
  r := r || jsonb_build_object('D16_total_count', pg_temp.pass(s = '{"n": 3, "total": 10}', s));

  -- ===== D18 (V2): F5 refuses first =====
  s := pg_temp.call_as(14, format(sscope, O1, 'NULL'));
  r := r || jsonb_build_object('D18_nonmember_refused', pg_temp.pass(s = NF, s));
  s := pg_temp.call_as(15, format(sscope, pg_temp.fx(106), 'NULL'));
  r := r || jsonb_build_object('D18_portal_access_off_refused', pg_temp.pass(s = NF, s));
  s := pg_temp.call_as(15, pg_temp.q_rows(106, NULL));
  r := r || jsonb_build_object('D18_portal_access_off_rows_refused', pg_temp.pass(s = NF, s));
  s := pg_temp.call_as(1, format(sscope, O1, quote_literal(pg_temp.fx(403)) || '::uuid'));
  r := r || jsonb_build_object('D18_def_other_org_refused', pg_temp.pass(s = NF, s));

  -- ===== D11: feature off, non-member, inactive member, other org =====
  r := r || jsonb_build_object('D11_feature_off_get', pg_temp.pass(pg_temp.lvl(13, 413) = NF, pg_temp.lvl(13, 413)));
  s := pg_temp.call_as(13, pg_temp.q_rows(105, NULL));
  r := r || jsonb_build_object('D11_feature_off_rows', pg_temp.pass(s = NF, s));
  s := pg_temp.call_as(13, format('SELECT public.broker_report_def_list(%L::uuid)', pg_temp.fx(105)));
  r := r || jsonb_build_object('D11_feature_off_list', pg_temp.pass(s = NF, s));
  s := pg_temp.call_as(13, format('SELECT public.broker_report_share_list(%L::uuid)', pg_temp.fx(413)));
  r := r || jsonb_build_object('D11_feature_off_share_list', pg_temp.pass(s = NF, s));
  r := r || jsonb_build_object('D11_feature_off_create', pg_temp.ctl(13,
    format('SELECT to_jsonb(public.broker_report_def_create(%L::uuid, ''submissions'', ''x'', NULL, ''{}'', ''all''))', pg_temp.fx(105)),
    NF, '[]'));
  r := r || jsonb_build_object('D11_nonmember_get', pg_temp.pass(pg_temp.lvl(14, 407) = NF, pg_temp.lvl(14, 407)));
  s := pg_temp.call_as(14, format('SELECT public.broker_report_def_list(%L::uuid)', O1));
  r := r || jsonb_build_object('D11_nonmember_list', pg_temp.pass(s = NF, s));
  r := r || jsonb_build_object('D11_inactive_get', pg_temp.pass(pg_temp.lvl(8, 407) = NF, pg_temp.lvl(8, 407)));
  r := r || jsonb_build_object('D11_other_org_get', pg_temp.pass(pg_temp.lvl(10, 407) = NF, pg_temp.lvl(10, 407)));
  -- list positive: G3 sees exactly the organization-wide X7 and the agent-role X6
  s := pg_temp.call_as(7, format('SELECT (SELECT jsonb_agg(pg_temp.nx((e->>''id'')::uuid) ORDER BY pg_temp.nx((e->>''id'')::uuid)) FROM jsonb_array_elements(public.broker_report_def_list(%L::uuid)) e)', O1));
  r := r || jsonb_build_object('D11_list_positive_G3', pg_temp.pass(s = '[406, 407]', s));

  -- ===== D10: integer rank =====
  r := r || jsonb_build_object('D10_editor_beats_org_viewer', pg_temp.pass(pg_temp.lvl(2, 407) = 'editor', pg_temp.lvl(2, 407)));
  r := r || jsonb_build_object('D10_org_viewer', pg_temp.pass(pg_temp.lvl(7, 407) = 'viewer', pg_temp.lvl(7, 407)));

  -- ===== D7 (V6): role grants match the exact stored role =====
  r := r || jsonb_build_object('D7_agent_role_admits_G3', pg_temp.pass(pg_temp.lvl(7, 406) = 'viewer', pg_temp.lvl(7, 406)));
  r := r || jsonb_build_object('D7_broker_grant_not_agent', pg_temp.pass(pg_temp.lvl(5, 406) = 'viewer', pg_temp.lvl(5, 406)));
  r := r || jsonb_build_object('D7_broker_grant_broker', pg_temp.pass(pg_temp.lvl(2, 406) = 'editor', pg_temp.lvl(2, 406)));
  r := r || jsonb_build_object('D7_admin_grant_admin', pg_temp.pass(pg_temp.lvl(3, 406) = 'viewer', pg_temp.lvl(3, 406)));
  r := r || jsonb_build_object('D7_admin_grant_not_it_admin', pg_temp.pass(pg_temp.lvl(4, 406) = NF, pg_temp.lvl(4, 406)));
  r := r || jsonb_build_object('D7_role_viewer_own_rows', pg_temp.pass(pg_temp.call_as(7, pg_temp.q_rows(101, 406)) = '[313]',
    pg_temp.call_as(7, pg_temp.q_rows(101, 406))));

  -- ===== RA: "All admins" target = admin AND it_admin (founder ruling) =====
  r := r || jsonb_build_object('RA_it_admin_before', pg_temp.pass(pg_temp.lvl(4, 412) = NF, pg_temp.lvl(4, 412)));
  r := r || jsonb_build_object('RA_share_admins', pg_temp.ctl(1, format(sset, pg_temp.fx(412), '[{"kind":"role","id":"admins"}]', 'viewer'), OK,
    jsonb_build_array(pg_temp.ar(1, 'report_shared', 412, 'Report twelve', '{"role":"admin","from":null,"to":"viewer"}'),
                      pg_temp.ar(1, 'report_shared', 412, 'Report twelve', '{"role":"it_admin","from":null,"to":"viewer"}'))));
  r := r || jsonb_build_object('RA_it_admin_sees', pg_temp.pass(pg_temp.lvl(4, 412) = 'viewer', pg_temp.lvl(4, 412)));
  r := r || jsonb_build_object('RA_admin_sees', pg_temp.pass(pg_temp.lvl(3, 412) = 'viewer', pg_temp.lvl(3, 412)));
  r := r || jsonb_build_object('RA_agent_not', pg_temp.pass(pg_temp.lvl(5, 412) = NF, pg_temp.lvl(5, 412)));
  s := pg_temp.call_as(1, format('SELECT public.broker_report_share_candidates(%L::uuid) -> ''roles''', pg_temp.fx(412)));
  r := r || jsonb_build_object('RA_candidates_three_targets', pg_temp.pass(
    s NOT LIKE 'ERR%' AND (SELECT jsonb_agg(e ->> 'id') FROM jsonb_array_elements(s::jsonb) e) = '["agent", "broker", "admins"]'
    AND (SELECT e ->> 'detail' FROM jsonb_array_elements(s::jsonb) e WHERE e ->> 'id' = 'admins') = '2 people', s));

  -- ===== D9 (V5): candidates =====
  s := pg_temp.call_as(3, format('SELECT public.broker_report_share_candidates(%L::uuid)', pg_temp.fx(405)));
  r := r || jsonb_build_object('D9_people_active_same_org', pg_temp.pass(s NOT LIKE 'ERR%' AND
    (SELECT jsonb_agg(pg_temp.nx((e ->> 'id')::uuid) ORDER BY pg_temp.nx((e ->> 'id')::uuid)) FROM jsonb_array_elements(s::jsonb -> 'people') e)
      = '[1, 2, 3, 4, 5, 6, 7]', s));
  r := r || jsonb_build_object('D9_no_email', pg_temp.pass(s NOT LIKE '%"email"%' AND s NOT LIKE '%@%', s));
  s := pg_temp.call_as(6, format('SELECT public.broker_report_share_candidates(%L::uuid)', pg_temp.fx(405)));
  r := r || jsonb_build_object('D9_agent_editor_sees_people', pg_temp.pass(s NOT LIKE 'ERR%' AND
    jsonb_array_length(s::jsonb -> 'people') = 7 AND s NOT LIKE '%@%', s));
  s := pg_temp.call_as(4, format('SELECT public.broker_report_share_candidates(%L::uuid)', pg_temp.fx(405)));
  r := r || jsonb_build_object('D9_viewer_refused', pg_temp.pass(s = NF, s));

  -- ===== D6 (Q5) + D12 audit on X5 (owner B1; A1 editor, G2 editor, I1 viewer, B2 viewer) =====
  r := r || jsonb_build_object('D6_editor_grants_can_edit', pg_temp.ctl(3,
    format(sset, pg_temp.fx(405), format('[{"kind":"person","id":"%s"}]', pg_temp.fx(7)), 'editor'), OK,
    jsonb_build_array(pg_temp.ar(3, 'report_shared', 405, 'Pipeline five', '{"from":null,"to":"editor","member":7}'))));
  r := r || jsonb_build_object('D6_editor_changes_level', pg_temp.ctl(3,
    format(sset, pg_temp.fx(405), format('[{"kind":"person","id":"%s"}]', pg_temp.fx(2)), 'editor'), OK,
    jsonb_build_array(pg_temp.ar(3, 'report_share_changed', 405, 'Pipeline five', '{"from":"viewer","to":"editor","member":2}'))));
  r := r || jsonb_build_object('D12_unchanged_no_row', pg_temp.ctl(3,
    format(sset, pg_temp.fx(405), format('[{"kind":"person","id":"%s"}]', pg_temp.fx(2)), 'editor'), OK, '[]'));
  r := r || jsonb_build_object('D6_agent_editor_shares', pg_temp.ctl(6,
    format(sset, pg_temp.fx(405), format('[{"kind":"person","id":"%s"}]', pg_temp.fx(5)), 'viewer'), OK,
    jsonb_build_array(pg_temp.ar(6, 'report_shared', 405, 'Pipeline five', '{"from":null,"to":"viewer","member":5}'))));
  -- a grantee valid in every other respect (G1, an active member holding viewer), so only the level gate refuses
  r := r || jsonb_build_object('D6_viewer_share_refused', pg_temp.ctl(4,
    format(sset, pg_temp.fx(405), format('[{"kind":"person","id":"%s"}]', pg_temp.fx(5)), 'editor'), NF, '[]'));
  r := r || jsonb_build_object('D6_viewer_remove_refused', pg_temp.ctl(4, format(srem, pg_temp.fx(405), 'person', pg_temp.fx(2)), NF, '[]'));
  r := r || jsonb_build_object('D6_viewer_general_refused', pg_temp.ctl(4, format(sgen, pg_temp.fx(405), 'organization'), NF, '[]'));
  r := r || jsonb_build_object('D6_editor_delete_refused', pg_temp.ctl(3, format(sdel, pg_temp.fx(405)), NF, '[]'));
  -- whole-call refusals
  r := r || jsonb_build_object('D6_whole_call_refused_other_org', pg_temp.ctl(3,
    format(sset, pg_temp.fx(405), format('[{"kind":"person","id":"%s"},{"kind":"person","id":"%s"}]', pg_temp.fx(7), pg_temp.fx(10)), 'viewer'),
    NF, '[]'));
  r := r || jsonb_build_object('D6_whole_call_left_G3', pg_temp.pass(pg_temp.lvl(7, 405) = 'editor', pg_temp.lvl(7, 405)));
  r := r || jsonb_build_object('D6_owner_not_grantee', pg_temp.ctl(3,
    format(sset, pg_temp.fx(405), format('[{"kind":"person","id":"%s"}]', pg_temp.fx(1)), 'viewer'), NF, '[]'));
  r := r || jsonb_build_object('D6_inactive_not_grantee', pg_temp.ctl(3,
    format(sset, pg_temp.fx(405), format('[{"kind":"person","id":"%s"}]', pg_temp.fx(8)), 'viewer'), NF, '[]'));
  r := r || jsonb_build_object('D6_unknown_role_refused', pg_temp.ctl(3,
    format(sset, pg_temp.fx(405), '[{"kind":"role","id":"owner"}]', 'viewer'), NF, '[]'));
  r := r || jsonb_build_object('D6_over_50_refused', pg_temp.ctl(3,
    format(sset, pg_temp.fx(405), (SELECT jsonb_agg(jsonb_build_object('kind', 'role', 'id', 'agent')) FROM generate_series(1, 51))::text, 'viewer'),
    NF, '[]'));
  -- remove, general access, self-remove
  r := r || jsonb_build_object('D12_remove', pg_temp.ctl(1, format(srem, pg_temp.fx(405), 'person', pg_temp.fx(5)), OK,
    jsonb_build_array(pg_temp.ar(1, 'report_unshared', 405, 'Pipeline five', '{"from":"viewer","to":null,"member":5}'))));
  r := r || jsonb_build_object('D12_general_access', pg_temp.ctl(3, format(sgen, pg_temp.fx(405), 'organization'), OK,
    jsonb_build_array(pg_temp.ar(3, 'report_general_access_changed', 405, 'Pipeline five', '{"from":"restricted","to":"organization"}'))));
  r := r || jsonb_build_object('D12_general_unchanged_no_row', pg_temp.ctl(3, format(sgen, pg_temp.fx(405), 'organization'), OK, '[]'));
  r := r || jsonb_build_object('D12_self_remove', pg_temp.ctl(4, format(srem, pg_temp.fx(405), 'person', pg_temp.fx(4)), OK,
    jsonb_build_array(pg_temp.ar(4, 'report_unshared', 405, 'Pipeline five', '{"from":"viewer","to":null,"member":4}'))));
  -- the READER's output (V4): the staff Activity reader carries report_name, from, to and the grantee's name
  s := pg_temp.call_as(16, format('SELECT public.admin_get_org_activity(%L::uuid, 200)', O1));
  r := r || jsonb_build_object('D12_reader_output', pg_temp.pass(s NOT LIKE 'ERR%' AND
    (SELECT count(*) FROM jsonb_array_elements(s::jsonb) e
      WHERE e ->> 'action' = 'report_share_changed' AND e -> 'detail' ->> 'report_name' = 'Pipeline five'
        AND e -> 'detail' ->> 'from' = 'viewer' AND e -> 'detail' ->> 'to' = 'editor'
        AND e ->> 'subject_name' = 'P3513B user 2' AND e ->> 'actor_name' = 'P3513B user 3') = 1, left(s, 250)));

  -- ===== Row scope (founder ruling: owner or editor) + D15 stale, on X14 (owner B1, A1 editor) =====
  INSERT INTO public.broker_report_definition_grants (definition_id, principal_type, principal_user_id, level)
  VALUES (pg_temp.fx(414), 'user', pg_temp.fx(2), 'viewer');
  t := (SELECT updated_at FROM public.broker_report_definitions WHERE id = pg_temp.fx(414));
  r := r || jsonb_build_object('RS_viewer_refused', pg_temp.ctl(2, format(supd, pg_temp.fx(414), 'Report fourteen', 'own', t), NF, '[]'));
  s := pg_temp.call_as(3, format(supd, pg_temp.fx(414), 'Report fourteen', 'own', t));
  r := r || jsonb_build_object('RS_editor_changes_scope', pg_temp.pass(s NOT LIKE 'ERR%'
    AND (SELECT row_scope FROM public.broker_report_definitions WHERE id = pg_temp.fx(414)) = 'own'
    AND (SELECT count(*) FROM public.billing_change_log c WHERE c.source = 'report' AND c.action = 'report_row_scope_changed'
          AND c.detail ->> 'definition_id' = pg_temp.fx(414)::text AND c.actor_id = pg_temp.fx(3)
          AND c.detail ->> 'from' = 'all' AND c.detail ->> 'to' = 'own') = 1, s));
  r := r || jsonb_build_object('D15_stale_refused', pg_temp.ctl(3, format(supd, pg_temp.fx(414), 'Report fourteen', 'all', t),
    'ERR 40001 Report changed', '[]'));
  t := (SELECT updated_at FROM public.broker_report_definitions WHERE id = pg_temp.fx(414));
  r := r || jsonb_build_object('RS_remove_editor', pg_temp.ctl(1, format(srem, pg_temp.fx(414), 'person', pg_temp.fx(3)), OK,
    jsonb_build_array(pg_temp.ar(1, 'report_unshared', 414, 'Report fourteen', '{"from":"editor","to":null,"member":3}'))));
  r := r || jsonb_build_object('RS_removed_editor_refused', pg_temp.ctl(3, format(supd, pg_temp.fx(414), 'Report fourteen', 'all', t), NF, '[]'));

  -- ===== D5: transfer (X4 owner B1; A1 editor; B2 viewer) =====
  r := r || jsonb_build_object('D5_editor_refused', pg_temp.ctl(3, format(sxfer, pg_temp.fx(404), pg_temp.fx(5)), NF, '[]'));
  r := r || jsonb_build_object('D5_viewer_refused', pg_temp.ctl(2, format(sxfer, pg_temp.fx(404), pg_temp.fx(5)), NF, '[]'));
  r := r || jsonb_build_object('D5_to_inactive_refused', pg_temp.ctl(1, format(sxfer, pg_temp.fx(404), pg_temp.fx(8)), NF, '[]'));
  r := r || jsonb_build_object('D5_to_other_org_refused', pg_temp.ctl(1, format(sxfer, pg_temp.fx(404), pg_temp.fx(10)), NF, '[]'));
  r := r || jsonb_build_object('D5_to_nonmember_refused', pg_temp.ctl(1, format(sxfer, pg_temp.fx(404), pg_temp.fx(14)), NF, '[]'));
  r := r || jsonb_build_object('D5_to_self_refused', pg_temp.ctl(1, format(sxfer, pg_temp.fx(404), pg_temp.fx(1)), NF, '[]'));
  r := r || jsonb_build_object('D5_owner_to_agent', pg_temp.ctl(1, format(sxfer, pg_temp.fx(404), pg_temp.fx(5)), OK,
    jsonb_build_array(pg_temp.ar(1, 'report_owner_changed', 404, 'Report four', '{"member":5}'))));
  r := r || jsonb_build_object('D5_after_state', pg_temp.pass(
    (SELECT owner_user_id FROM public.broker_report_definitions WHERE id = pg_temp.fx(404)) = pg_temp.fx(5)
    AND NOT EXISTS (SELECT 1 FROM public.broker_report_definition_grants WHERE definition_id = pg_temp.fx(404) AND principal_user_id = pg_temp.fx(5))
    AND (SELECT level FROM public.broker_report_definition_grants WHERE definition_id = pg_temp.fx(404) AND principal_user_id = pg_temp.fx(1)) = 'editor'
    AND pg_temp.lvl(5, 404) = 'owner' AND pg_temp.lvl(1, 404) = 'editor', 'state'));

  -- ===== D13: take-over =====
  r := r || jsonb_build_object('D13_owner_active_refused', pg_temp.ctl(2, format(stake, pg_temp.fx(408)), NF, '[]'));
  r := r || jsonb_build_object('D13_agent_refused', pg_temp.ctl(6, format(stake, pg_temp.fx(409)), NF, '[]'));
  r := r || jsonb_build_object('D13_it_admin_refused', pg_temp.ctl(4, format(stake, pg_temp.fx(409)), NF, '[]'));
  r := r || jsonb_build_object('D13_broker_owner_gone', pg_temp.ctl(2, format(stake, pg_temp.fx(409)), OK,
    jsonb_build_array(pg_temp.ar(2, 'report_owner_changed', 409, 'Report nine', '{"via":"take_over","member":2}'))));
  r := r || jsonb_build_object('D13_admin_owner_null', pg_temp.ctl(3, format(stake, pg_temp.fx(410)), OK,
    jsonb_build_array(pg_temp.ar(3, 'report_owner_changed', 410, 'Report ten', '{"via":"take_over","member":3}'))));

  -- ===== D14: delete removes the d-<id> saved views =====
  r := r || jsonb_build_object('D14_delete', pg_temp.ctl(1, format(sdel, pg_temp.fx(411)), OK,
    jsonb_build_array(pg_temp.ar(1, 'report_deleted', 411, 'Report eleven', '{}'))));
  r := r || jsonb_build_object('D14_views_gone', pg_temp.pass(
    NOT EXISTS (SELECT 1 FROM public.broker_report_saved_views WHERE id IN (pg_temp.fx(901), pg_temp.fx(902)))
    AND EXISTS (SELECT 1 FROM public.broker_report_saved_views WHERE id = pg_temp.fx(903))
    AND NOT EXISTS (SELECT 1 FROM public.broker_report_definitions WHERE id = pg_temp.fx(411)), 'views'));

  -- ===== D17: an agent creates a report (Q2) =====
  s := pg_temp.call_as(5, format('SELECT to_jsonb(public.broker_report_def_create(%L::uuid, ''submissions'', '' Agent report '', NULL, ''{}'', ''all''))', O1));
  r := r || jsonb_build_object('D17_agent_creates', pg_temp.pass(s NOT LIKE 'ERR%'
    AND (SELECT owner_user_id = pg_temp.fx(5) AND name = 'Agent report' FROM public.broker_report_definitions WHERE id::text = s)
    AND (SELECT count(*) FROM public.billing_change_log c WHERE c.source = 'report' AND c.action = 'report_created'
          AND c.detail ->> 'definition_id' = s AND c.actor_id = pg_temp.fx(5)) = 1, s));

  -- ===== K2: the pin refuses a third reader body =====
  BEGIN
    EXECUTE $q$CREATE OR REPLACE FUNCTION public.admin_get_org_activity(p_org uuid, p_limit integer DEFAULT 100) RETURNS jsonb
             LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS 'SELECT NULL::jsonb'$q$;
    EXECUTE $mg$__MIGRATION__$mg$;
    s := 'applied';
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL; ELSE s := SQLERRM; END IF;
  END;
  r := r || jsonb_build_object('K2_pin_refuses_third_reader_body', pg_temp.pass(s LIKE '%admin_get_org_activity(uuid,integer) body changed%', s));

  -- ===== K4: the rollback drops everything new and restores the 20261107160000 reader =====
  BEGIN
    EXECUTE $rb$__ROLLBACK__$rb$;
    s := (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.admin_get_org_activity(uuid,integer)'))
         || '/' || (SELECT count(*) FROM unnest(pub || priv) x WHERE to_regprocedure(x) IS NOT NULL)
         || '/' || (SELECT count(*) FROM pg_class WHERE relname IN ('broker_report_definitions', 'broker_report_definition_grants'))
         || '/' || (SELECT count(*) FROM public.billing_change_log WHERE source = 'report' AND organization_id = O1);
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL; ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
  END;
  r := r || jsonb_build_object('K4_rollback', pg_temp.pass(s LIKE '93ee729f73f23ecd90ffe49ca6d60704/0/0/%' AND split_part(s, '/', 4)::int > 0, s));

  RETURN r;
END $b$;

DO $drv$
DECLARE v_r jsonb;
BEGIN
  v_r := pg_temp.run();
  RAISE EXCEPTION 'P3513B_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(v_r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'));
END
$drv$;
