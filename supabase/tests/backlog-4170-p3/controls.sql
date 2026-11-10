-- BACKLOG-4170 PR3 controls. compose.py order: [applied digest] -> rollback -> prelude (B0, fixtures, P0)
-- -> migration TWICE -> this file. Fixtures: see prelude.sql.
-- Vectors are per-table counts of fixture rows (whole table for admin_roles / admin_permissions /
-- admin_role_permissions); 'all' = every such row, as read with RLS bypassed.
-- Output: RAISE 'P4170_RESULT {total, pass, fail, reds}'.

-- expected post-PR3 vector per caller (keys absent = 0). anon is checked separately.
CREATE FUNCTION pg_temp.post_expect() RETURNS TABLE (lbl text, p jsonb) LANGUAGE sql AS $b$
  SELECT v.l, v.p::jsonb FROM (VALUES
    ('u0', '{"admin_roles":1}'),
    ('support.view_assigned', '{"admin_roles":1,"credit_ledger":2,"transaction_unlocks":1,"account_suspensions":1,"email_delivery_log":"all","email_delivery_queue":"all","organization_plans":"all","support_response_templates":"all"}'),
    ('support.view_unassigned', '{"admin_roles":1,"email_delivery_log":"all","email_delivery_queue":"all","organization_plans":"all","support_response_templates":"all"}'),
    ('support.admin', '{"admin_roles":1,"credit_ledger":3,"transaction_unlocks":2,"account_suspensions":2,"support_response_templates":"all"}'),
    ('users.view', '{"admin_roles":1,"credit_ledger":"all","transaction_unlocks":"all","account_suspensions":"all","organization_plans":"all"}'),
    ('users.edit', '{"admin_roles":1,"individual_invitations":"all"}'),
    ('billing.view', '{"admin_roles":1,"payment_intents":"all","stripe_customers":"all"}'),
    ('audit.view', '{"admin_roles":1,"admin_audit_logs":"all"}'),
    ('roles.view', '{"admin_roles":"all","admin_permissions":"all","admin_role_permissions":"all"}'),
    ('roles.manage', '{"admin_roles":"all","admin_permissions":"all","admin_role_permissions":"all"}'),
    ('internal_users.view', '{"admin_roles":"all","pending_internal_invitations":"all"}'),
    ('internal_users.manage', '{"admin_roles":"all","pending_internal_invitations":"all"}'),
    ('analytics.view', '{"admin_roles":1,"app_lifecycle_events":"all"}'),
    ('organizations.view', '{"admin_roles":1,"organization_plans":"all"}'),
    ('plans.view', '{"admin_roles":1,"organization_plans":"all"}'),
    ('support.manage', '{"admin_roles":1,"support_response_templates":"all"}'),
    ('u_sa', NULL),
    ('u_cust', '{"credit_ledger":2,"transaction_unlocks":1,"payment_intents":1,"stripe_customers":1,"organization_plans":1,"pending_internal_invitations":1}'),
    ('u_cust2', '{"credit_ledger":1,"transaction_unlocks":1,"payment_intents":1,"stripe_customers":1}')
  ) v(l, p)
$b$;

CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
  r jsonb := '{}'::jsonb;
  s text; s2 text; n int; p0 record; c record; e text; got text;
  ALLT text[] := pg_temp.targets();
  every text := pg_temp.expect(pg_temp.everything());
  embedq text := format('SELECT to_jsonb(count(*)) FROM public.organization_members om'
           || ' JOIN public.organizations o ON o.id = om.organization_id JOIN public.organization_plans op ON op.organization_id = o.id'
           || ' JOIN public.plans p ON p.id = op.plan_id WHERE om.user_id = %L', pg_temp.fx(5));
BEGIN
  SELECT * INTO p0 FROM p4170p3_p0;

  -- ================= B0 / P0: baseline before PR3 (same transaction, same fixtures) =================
  r := r || jsonb_build_object('B0_pre_fixture_counts_equal_plan_baseline', pg_temp.pass(
    (SELECT b0 FROM p4170p3_b0) = '{"account_suspensions":0,"admin_audit_logs":33,"admin_permissions":36,"admin_role_permissions":128,"admin_roles":9,"app_lifecycle_events":0,"credit_ledger":5,"email_delivery_log":43,"email_delivery_queue":0,"individual_invitations":0,"organization_plans":8,"payment_intents":0,"pending_internal_invitations":0,"stripe_customers":2,"support_response_templates":0,"transaction_unlocks":0}'::jsonb,
    (SELECT b0::text FROM p4170p3_b0)));
  r := r || jsonb_build_object('P0_pre_state_is_prod_text', pg_temp.pass(p0.tdigest = '36/801af2214b81aebad5e5c7831547727a', p0.tdigest));
  -- the fixtures can tell the keys apart: before PR3, u0 (zero keys) reads every fixture row of all 16
  s := (p0.m -> 'u0')::text;
  r := r || jsonb_build_object('P0_u0_reads_all_16_before', pg_temp.pass(pg_temp.js(s) = every::jsonb, s || ' vs ' || every));
  s := (p0.m -> 'u_cust')::text;
  r := r || jsonb_build_object('P0_customer_reads_all_templates_before', pg_temp.pass(
    (pg_temp.js(s) ->> 'support_response_templates') = '2', s));
  r := r || jsonb_build_object('P0_sa_full_equals_bypass', pg_temp.pass(pg_temp.js(p0.sa_full) = pg_temp.allfull(), p0.sa_full));

  -- ================= M: every caller x every table =================
  FOR c IN SELECT pc.lbl, pc.u, pc.r, pe.p FROM pg_temp.callers() pc JOIN pg_temp.post_expect() pe ON pe.lbl = pc.lbl LOOP
    got := pg_temp.vec(c.u, c.r);
    e := pg_temp.expect(coalesce(c.p, pg_temp.everything()));
    r := r || jsonb_build_object('M_' || c.lbl, pg_temp.pass(pg_temp.js(got) = pg_temp.js(e), 'got ' || got || ' want ' || e));
  END LOOP;
  -- anon: nothing readable, before or after (a table without an anon SELECT grant answers ERR 42501)
  got := pg_temp.vec(NULL, 'anon');
  s := (SELECT string_agg(k || '=' || v::text, ',') FROM jsonb_each(pg_temp.js(got)) e2(k, v)
         WHERE NOT (v::text = '0' OR v::text LIKE '"ERR 42501 permission denied for table%'));
  r := r || jsonb_build_object('M_anon_reads_nothing', pg_temp.pass(s IS NULL AND pg_temp.js(got) = p0.m -> 'anon'
    AND (SELECT count(*) FROM jsonb_object_keys(pg_temp.js(got))) = 16, coalesce(s, '') || ' ; ' || got));

  -- ================= SA: Super Admin reads every row of all 16 tables =================
  s := pg_temp.fullvec(pg_temp.fx(30));
  r := r || jsonb_build_object('SA_full_tables_equal_bypass_and_P0', pg_temp.pass(
    pg_temp.js(s) = pg_temp.allfull() AND pg_temp.js(s) = pg_temp.js(p0.sa_full), s || ' vs P0 ' || p0.sa_full));

  -- ================= R1: admin_roles own role (PR3-b) =================
  s := pg_temp.call_as(pg_temp.fx(1), 'SELECT to_jsonb(count(ar.id)) FROM public.internal_roles ir'
         || ' LEFT JOIN public.admin_roles ar ON ar.id = ir.role_id WHERE ir.user_id = auth.uid()')
    || '/' || pg_temp.call_as(pg_temp.fx(1), format('SELECT to_jsonb(count(*)) FROM public.admin_roles WHERE id = %L', pg_temp.fx(201)))
    || '/' || pg_temp.call_as(pg_temp.fx(1), format('SELECT to_jsonb(count(*)) FROM public.admin_roles WHERE id = %L', pg_temp.fx(202)));
  r := r || jsonb_build_object('R1_u0_own_role_embed_1_other_role_0', pg_temp.pass(s = '1/1/0', s));

  -- ================= R2: invitation cancel by an internal_users.manage-only holder (PR3-d) =================
  BEGIN
    s := pg_temp.call_as(pg_temp.fx(19), format('WITH d AS (DELETE FROM public.pending_internal_invitations WHERE id = %L RETURNING id) SELECT to_jsonb(count(*)) FROM d', pg_temp.fx(801)));
    s := s || '/' || (SELECT count(*) FROM public.pending_internal_invitations WHERE id = pg_temp.fx(801));
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
    ELSE s := 'ERRRB ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
  END;
  r := r || jsonb_build_object('R2_manage_only_cancels_invitation', pg_temp.pass(s = '1/0', s));
  BEGIN
    s := pg_temp.call_as(pg_temp.fx(5), format('WITH d AS (DELETE FROM public.pending_internal_invitations WHERE id = %L RETURNING id) SELECT to_jsonb(count(*)) FROM d', pg_temp.fx(801)));
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
    ELSE s := 'ERRRB ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
  END;
  r := r || jsonb_build_object('R2b_invitee_reads_and_deletes_own_invitation', pg_temp.pass(s = '1', s));

  -- ================= R3: templates (scope row b447c887) =================
  s := pg_temp.call_as(pg_temp.fx(3), 'SELECT to_jsonb((SELECT count(*) FROM jsonb_array_elements(public.support_list_templates()) x WHERE x ->> ''name'' LIKE ''P4170p3%''))')
    || '/' || pg_temp.call_as(pg_temp.fx(2), 'SELECT to_jsonb((SELECT count(*) FROM jsonb_array_elements(public.support_list_templates()) x WHERE x ->> ''name'' LIKE ''P4170p3%''))');
  r := r || jsonb_build_object('R3_picker_returns_active_template_to_support_view', pg_temp.pass(s = '1/1', s));
  s := pg_temp.call_as(pg_temp.fx(5), 'SELECT to_jsonb(public.support_list_templates())')
    || '|' || pg_temp.call_as(pg_temp.fx(1), 'SELECT to_jsonb(public.support_list_templates())');
  r := r || jsonb_build_object('R3b_picker_refuses_customer_and_u0', pg_temp.pass(
    s = 'ERR 42501 Support agent access required|ERR 42501 Support agent access required', s));
  -- settings page (support/settings/page.tsx -> support_list_all_templates) for a support.view-only user:
  -- refused before and after PR3 alike (PR3 changes the table policy, not the function)
  s := pg_temp.call_as(pg_temp.fx(3), 'SELECT to_jsonb(public.support_list_all_templates())');
  r := r || jsonb_build_object('R3c_settings_list_all_unchanged_for_view_only', pg_temp.pass(
    s = p0.settings_view_only AND s LIKE 'ERR 42501%', p0.settings_view_only || ' -> ' || s));

  -- ================= R4: users/[id] plan-name embed for a support.view agent (PR3-c) =================
  s := pg_temp.call_as(pg_temp.fx(2), embedq);
  r := r || jsonb_build_object('R4_support_view_reads_plan_through_users_page_embed',
    pg_temp.pass(s = '1' AND p0.embed_assigned = '1', p0.embed_assigned || ' -> ' || s));

  -- ================= R5: email_delivery_log TO authenticated; all other roles unchanged (PR3-e) =================
  s := (SELECT roles::text FROM pg_policies WHERE schemaname = 'public' AND tablename = 'email_delivery_log'
          AND policyname = 'Internal users can read logs');
  r := r || jsonb_build_object('R5_logs_policy_to_authenticated_others_unchanged',
    pg_temp.pass(s = '{authenticated}' AND pg_temp.roles_rest() = p0.roles_rest, s || ' ; ' || pg_temp.roles_rest() || ' vs ' || p0.roles_rest));

  -- ================= D: policies that joined the permission tables inline still work (sections 17-18) =================
  r := r || jsonb_build_object('D0_dep_pre_state_is_prod_text', pg_temp.pass(p0.depdigest = '2/807b7e3820f853eb4e18e29bfe74f922', p0.depdigest));
  s := pg_temp.writes();
  r := r || jsonb_build_object('D1_inline_join_and_is_system_write_paths_unchanged',
    pg_temp.pass(p0.writes = s AND s ~ '^2\|0\|1\|', p0.writes || ' -> ' || s));
  s := (SELECT string_agg(policyname, ',') FROM pg_policies WHERE schemaname = 'public'
         AND policyname IN ('support_templates_manage', 'support_sla_settings_update_admin')
         AND ((coalesce(qual, '') || coalesce(with_check, '')) ~ 'internal_roles|admin_role_permissions|admin_permissions'
              OR qual !~ 'has_any_permission' OR with_check !~ 'has_any_permission'));
  n := (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND policyname IN ('support_templates_manage', 'support_sla_settings_update_admin'));
  r := r || jsonb_build_object('D2_dep_policies_use_helper_in_using_and_check', pg_temp.pass(s IS NULL AND n = 2, coalesce(s, '') || ' n=' || n));

  -- ================= K-pol: count / shape unchanged; no internal-role text except the own-role branch =================
  s := pg_temp.shape();
  r := r || jsonb_build_object('Kpol_policy_count_and_shape_unchanged', pg_temp.pass(s = p0.shape, p0.shape || ' vs ' || s));
  n := (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY (ALLT));
  r := r || jsonb_build_object('Kpol_target_policy_count_36', pg_temp.pass(n = 36, n::text));
  s := (SELECT string_agg(tablename || '.' || policyname, ',') FROM pg_policies
         WHERE schemaname = 'public' AND tablename = ANY (ALLT) AND cmd = 'SELECT'
           AND (coalesce(qual, '') || coalesce(with_check, '')) ~ '(internal_roles|has_internal_role)'
           AND NOT (tablename = 'admin_roles' AND policyname = 'Internal users can view roles'));
  s2 := (SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'admin_roles' AND policyname = 'Internal users can view roles');
  r := r || jsonb_build_object('Kpol_no_internal_role_text_except_own_role', pg_temp.pass(s IS NULL
    AND s2 !~ 'has_internal_role'
    AND (SELECT count(*) FROM regexp_matches(s2, 'internal_roles', 'g')) = 1
    AND s2 ~ 'id IN \( SELECT ir\.role_id\s+FROM internal_roles ir\s+WHERE \(ir\.user_id = \( SELECT auth\.uid\(\) AS uid\)\)\)',
    coalesce(s, '') || ' | ' || s2));
  -- the 16 changed SELECT policies all call has_any_permission; none is USING (true)
  s := (SELECT string_agg(tablename || '.' || policyname, ',') FROM pg_policies
         WHERE schemaname = 'public' AND tablename = ANY (ALLT) AND cmd = 'SELECT'
           AND policyname NOT IN ('organization_plans_select_authenticated', 'users_can_read_own_invitation')
           AND (qual !~ 'has_any_permission' OR qual = 'true'));
  n := (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY (ALLT) AND cmd = 'SELECT'
           AND policyname NOT IN ('organization_plans_select_authenticated', 'users_can_read_own_invitation'));
  r := r || jsonb_build_object('Kpol_16_select_policies_keyed', pg_temp.pass(s IS NULL AND n = 16, coalesce(s, '') || ' n=' || n));

  -- ================= C11: policies call only functions authenticated can execute =================
  s := (SELECT string_agg(DISTINCT d.refobjid::regprocedure::text, ',' ORDER BY d.refobjid::regprocedure::text)
          FROM pg_depend d JOIN pg_policy pol ON pol.oid = d.objid JOIN pg_class cl ON cl.oid = pol.polrelid
         WHERE d.classid = 'pg_policy'::regclass AND d.refclassid = 'pg_proc'::regclass
           AND cl.relnamespace = 'public'::regnamespace AND cl.relname = ANY (ALLT) AND pol.polcmd = 'r'
           AND NOT has_function_privilege('authenticated', d.refobjid, 'EXECUTE'));
  s2 := (SELECT string_agg(DISTINCT d.refobjid::regprocedure::text, ',' ORDER BY d.refobjid::regprocedure::text)
          FROM pg_depend d JOIN pg_policy pol ON pol.oid = d.objid JOIN pg_class cl ON cl.oid = pol.polrelid
         WHERE d.classid = 'pg_policy'::regclass AND d.refclassid = 'pg_proc'::regclass
           AND cl.relnamespace = 'public'::regnamespace AND cl.relname = ANY (ALLT) AND pol.polcmd = 'r');
  r := r || jsonb_build_object('C11_policy_functions_executable_by_authenticated',
    pg_temp.pass(s IS NULL AND s2 LIKE '%has_any_permission(uuid,text[])%' AND s2 LIKE '%support_my_requester_ids()%'
                 AND s2 NOT LIKE '%has_internal_role%', coalesce(s, '') || ' | ' || s2));

  -- ================= K1: every key literal on the targets exists =================
  s := (SELECT string_agg(DISTINCT m[1], ',') FROM pg_policies p, regexp_matches(coalesce(p.qual, '') || coalesce(p.with_check, ''),
           '''([a-z_]+\.[a-z_]+)''::text', 'g') m
         WHERE p.schemaname = 'public' AND p.tablename = ANY (ALLT)
           AND NOT EXISTS (SELECT 1 FROM public.admin_permissions ap WHERE ap.key = m[1]));
  n := (SELECT count(*) FROM pg_policies p, regexp_matches(coalesce(p.qual, '') || coalesce(p.with_check, ''),
           '''([a-z_]+\.[a-z_]+)''::text', 'g') m WHERE p.schemaname = 'public' AND p.tablename = ANY (ALLT));
  r := r || jsonb_build_object('K1_every_permission_key_exists', pg_temp.pass(s IS NULL AND n > 0, 'bad=' || coalesce(s, '') || ' literals=' || n));

  -- ================= KT: TRUNCATE revoked from anon / authenticated on all 16 =================
  r := r || jsonb_build_object('KT_truncate_revoked_on_16', pg_temp.pass(pg_temp.trunc() = 'none' AND p0.trunc = 'none', p0.trunc || ' -> ' || pg_temp.trunc()));

  -- ================= K2: re-apply changes nothing =================
  s := pg_temp.tdigest();
  BEGIN
    EXECUTE $mg$__MIGRATION__$mg$;
    s2 := pg_temp.tdigest();
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s2 = PG_EXCEPTION_DETAIL;
    ELSE s2 := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
  END;
  r := r || jsonb_build_object('K2_reapply_idempotent', pg_temp.pass(s = s2 AND split_part(s, '+', 1) <> p0.tdigest AND split_part(s, '+', 2) <> p0.depdigest, s || ' vs ' || s2));

  -- ================= K3: rollback file restores the production text exactly =================
  BEGIN
    EXECUTE $rb$__ROLLBACK__$rb$;
    s := pg_temp.tdigest() || '/' || pg_temp.shape() || '/' || pg_temp.depdigest();
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
    ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
  END;
  r := r || jsonb_build_object('K3_rollback_restores_prod_text',
    pg_temp.pass(s = '36/801af2214b81aebad5e5c7831547727a/' || p0.shape || '/2/807b7e3820f853eb4e18e29bfe74f922', s));

  -- ================= KA (applied mode only): keepr-test state equals the migration file =================
  IF to_regclass('pg_temp.p4170p3_applied') IS NOT NULL THEN
    s := (SELECT d FROM p4170p3_applied);
    r := r || jsonb_build_object('KA_applied_state_equals_file', pg_temp.pass(s = pg_temp.tdigest() || '+' || pg_temp.depdigest(),
      s || ' vs ' || pg_temp.tdigest() || '+' || pg_temp.depdigest()));
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
    'post_digest', pg_temp.tdigest(), 'post_depdigest', pg_temp.depdigest(),
    'writes_p0', (SELECT writes FROM p4170p3_p0), 'writes_post', pg_temp.writes(),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'));
END
$drv$;
