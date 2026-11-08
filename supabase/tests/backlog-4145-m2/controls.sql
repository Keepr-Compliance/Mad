-- BACKLOG-4145 M2 controls. compose.py order: [applied digest] -> rollback -> prelude (fixtures + P0)
-- -> policy-shape snapshot -> migration TWICE -> this file. Fixtures: see prelude.sql.
-- Vectors are per-table counts of fixture rows the caller does NOT own; 'all' = every such row.
-- Output: RAISE 'P4145_RESULT {total, pass, fail, reds}'.

CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
  r jsonb := '{}'::jsonb;
  s text; s2 text; n int; p0 record;
  ALLT text[] := pg_temp.targets();
  usersq text := 'SELECT to_jsonb(count(*)) FROM public.users WHERE id = %L';
BEGIN
  SELECT * INTO p0 FROM p4145m2_p0;

  -- ================= P0: baseline before M2 (same transaction, same fixtures) =================
  s := (SELECT string_agg(k || '=' || v::text, ',') FROM jsonb_each(pg_temp.js(p0.v4)) e(k, v)
         WHERE (k NOT IN ('support_ticket_messages','support_ticket_events','support_ticket_participants','support_ticket_attachments') AND (jsonb_typeof(v) <> 'number' OR v::int = 0))
            OR (k IN ('support_ticket_messages','support_ticket_events','support_ticket_participants','support_ticket_attachments') AND v::text NOT LIKE '"ERR 42501 permission denied for table users%'));
  r := r || jsonb_build_object('P0_marketing_reads_every_target_before',
    pg_temp.pass(s IS NULL AND (SELECT count(*) FROM jsonb_object_keys(pg_temp.js(p0.v4))) = 13, coalesce(s, '') || ' ; ' || p0.v4));
  r := r || jsonb_build_object('P0_pre_state_is_prod_text', pg_temp.pass(p0.tdigest = '31/83dce5f806f9431a9eead58e9f61ea89', p0.tdigest));

  -- ================= H1: child tables failed for authenticated before M2; readable after =================
  s := (SELECT string_agg(k, ',') FROM jsonb_each(pg_temp.js(p0.o5)) e(k, v)
         WHERE k IN ('support_ticket_messages','support_ticket_events','support_ticket_participants','support_ticket_attachments') AND v::text NOT LIKE '"ERR 42501 permission denied for table users%');
  s2 := pg_temp.each(pg_temp.fx(5), true);
  r := r || jsonb_build_object('H1_child_tables_failed_before_read_after',
    pg_temp.pass(s IS NULL AND s2 NOT LIKE '%ERR%' AND NOT has_column_privilege('authenticated', 'auth.users', 'email', 'SELECT'),
                 'before=' || p0.o5 || ' after=' || s2));

  -- ================= C1: a Marketing-like internal role (analytics.view, no report rows) =================
  s := pg_temp.vec(pg_temp.fx(4));
  r := r || jsonb_build_object('C1_marketing_reads_0_non_own_on_all_targets',
    pg_temp.pass(s = pg_temp.expect(pg_temp.fx(4), '{}'), s));
  s := pg_temp.vec(pg_temp.fx(10));
  r := r || jsonb_build_object('C1b_pm_only_reads_0_non_own', pg_temp.pass(s = pg_temp.expect(pg_temp.fx(10), '{}'), s));

  -- ================= C2: each permission / report reads its rows, and only those =================
  s := pg_temp.vec(pg_temp.fx(12));
  r := r || jsonb_build_object('C2_users_view', pg_temp.pass(s = pg_temp.expect(pg_temp.fx(12),
    '{"users":"all","organizations":"all","organization_members":"all","audit_logs":"all","licenses":"all"}'), s));
  s := pg_temp.vec(pg_temp.fx(13));
  r := r || jsonb_build_object('C2_organizations_view', pg_temp.pass(s = pg_temp.expect(pg_temp.fx(13),
    '{"users":"all","organizations":"all","organization_members":"all"}'), s));
  s := pg_temp.vec(pg_temp.fx(14));
  r := r || jsonb_build_object('C2_users_edit_reads_organizations', pg_temp.pass(s = pg_temp.expect(pg_temp.fx(14),
    '{"organizations":"all"}'), s));
  s := pg_temp.vec(pg_temp.fx(3));
  r := r || jsonb_build_object('C2_support_view_reads_tickets_and_children', pg_temp.pass(s = pg_temp.expect(pg_temp.fx(3),
    '{"support_tickets":"all","support_ticket_messages":"all","support_ticket_events":"all","support_ticket_participants":"all","support_ticket_attachments":"all","support_ticket_backlog_links":"all"}'), s));
  s := pg_temp.vec(pg_temp.fx(21));
  r := r || jsonb_build_object('C2_report_analytics', pg_temp.pass(s = pg_temp.expect(pg_temp.fx(21),
    '{"users":"all","organizations":"all","organization_members":"all","devices":"all","user_preferences":"all"}'), s));
  s := pg_temp.vec(pg_temp.fx(22));
  r := r || jsonb_build_object('C2_report_exports', pg_temp.pass(s = pg_temp.expect(pg_temp.fx(22),
    '{"users":"all","organizations":"all","organization_members":"all"}'), s));
  s := pg_temp.vec(pg_temp.fx(23));
  r := r || jsonb_build_object('C2_report_iphone_sync', pg_temp.pass(s = pg_temp.expect(pg_temp.fx(23), '{"users":"all"}'), s));
  s := pg_temp.vec(pg_temp.fx(24));
  r := r || jsonb_build_object('C2_report_google_messages_sync', pg_temp.pass(s = pg_temp.expect(pg_temp.fx(24), '{"users":"all"}'), s));
  s := pg_temp.vec(pg_temp.fx(25));
  r := r || jsonb_build_object('C2_report_email_precache', pg_temp.pass(s = pg_temp.expect(pg_temp.fx(25), '{"users":"all"}'), s));
  s := pg_temp.vec(pg_temp.fx(26));
  r := r || jsonb_build_object('C2_report_submissions', pg_temp.pass(s = pg_temp.expect(pg_temp.fx(26),
    '{"users":"all","organizations":"all"}'), s));
  s := pg_temp.vec(pg_temp.fx(27));
  r := r || jsonb_build_object('C2_report_support_sla', pg_temp.pass(s = pg_temp.expect(pg_temp.fx(27),
    '{"users":"all","support_tickets":"all"}'), s));
  s := pg_temp.vec(pg_temp.fx(28));
  r := r || jsonb_build_object('C2_report_user_activity', pg_temp.pass(s = pg_temp.expect(pg_temp.fx(28),
    '{"users":"all","organizations":"all","organization_members":"all","devices":"all","audit_logs":"all"}'), s));

  -- ================= C3: own rows still readable (customer 5) =================
  s := pg_temp.own(pg_temp.fx(5));
  r := r || jsonb_build_object('C3_customer_own_rows',
    pg_temp.pass(pg_temp.js(s) = '{"users":1,"organization_members":1,"devices":1,"user_preferences":1,"audit_logs":1,"licenses":1,"support_tickets":1,"support_ticket_messages":1,"support_ticket_events":1,"support_ticket_participants":1,"support_ticket_attachments":1}'::jsonb, s));

  -- ================= C4: broker org-member reads unchanged (before = after) =================
  s := (SELECT string_agg(x.lbl || ':' || k, ',') FROM (VALUES
          ('v5', p0.v5, pg_temp.each(pg_temp.fx(5), false)), ('o5', p0.o5, pg_temp.each(pg_temp.fx(5), true)),
          ('v11', p0.v11, pg_temp.each(pg_temp.fx(11), false)), ('o11', p0.o11, pg_temp.each(pg_temp.fx(11), true))) x(lbl, b, a),
          jsonb_object_keys(pg_temp.js(x.b)) k
         WHERE k NOT IN ('support_ticket_messages','support_ticket_events','support_ticket_participants','support_ticket_attachments') AND (pg_temp.js(x.b) -> k) IS DISTINCT FROM (pg_temp.js(x.a) -> k));
  s2 := pg_temp.each(pg_temp.fx(5), false) || ' | ' || pg_temp.each(pg_temp.fx(11), false);
  r := r || jsonb_build_object('C4_broker_counts_unchanged', pg_temp.pass(s IS NULL AND pg_temp.js(p0.v5) ->> 'users' = '1'
    AND pg_temp.js(p0.v11) ->> 'organization_members' = '1' AND s2 NOT LIKE '%ERR%', coalesce(s, '') || ' ; ' || s2));

  -- ================= C12: the requester_email branch on child tables reads the session email =================
  s := pg_temp.call_as(pg_temp.fx(6), format('SELECT to_jsonb(count(*)) FROM public.support_ticket_messages WHERE id = %L', pg_temp.fx(705)))
    || '/' || pg_temp.call_as(pg_temp.fx(5), format('SELECT to_jsonb(count(*)) FROM public.support_ticket_messages WHERE id = %L', pg_temp.fx(705)))
    || '/' || pg_temp.call_as(pg_temp.fx(4), format('SELECT to_jsonb(count(*)) FROM public.support_ticket_messages WHERE id = %L', pg_temp.fx(705)));
  r := r || jsonb_build_object('C12_child_email_branch_uses_session_email', pg_temp.pass(s = '1/0/0', s));

  -- ================= C5: support agent = assigned requesters; support.admin = every requester =================
  s := pg_temp.vec(pg_temp.fx(2));
  r := r || jsonb_build_object('C5_support_view_assigned_requesters_only', pg_temp.pass(s = pg_temp.expect(pg_temp.fx(2),
    '{"users":2,"organizations":1,"organization_members":1,"audit_logs":1,"licenses":1,"support_tickets":"all","support_ticket_messages":"all","support_ticket_events":"all","support_ticket_participants":"all","support_ticket_attachments":"all","support_ticket_backlog_links":"all"}'), s));
  s := pg_temp.call_as(pg_temp.fx(2), format(usersq, pg_temp.fx(5))) || '/' || pg_temp.call_as(pg_temp.fx(2), format(usersq, pg_temp.fx(8)))
    || '/' || pg_temp.call_as(pg_temp.fx(2), format(usersq, pg_temp.fx(6))) || '/' || pg_temp.call_as(pg_temp.fx(2), format(usersq, pg_temp.fx(9)));
  r := r || jsonb_build_object('C5b_support_view_which_requesters', pg_temp.pass(s = '1/1/0/0', s));
  s := pg_temp.call_as(pg_temp.fx(2), format('SELECT to_jsonb(count(*)) FROM public.organizations WHERE id = %L', pg_temp.fx(601)))
    || '/' || pg_temp.call_as(pg_temp.fx(2), format('SELECT to_jsonb(count(*)) FROM public.organizations WHERE id = %L', pg_temp.fx(602)));
  r := r || jsonb_build_object('C5c_requester_org_via_member_branch', pg_temp.pass(s = '1/0', s));
  s := pg_temp.vec(pg_temp.fx(1));
  r := r || jsonb_build_object('C5d_support_admin_every_requester', pg_temp.pass(s = pg_temp.expect(pg_temp.fx(1),
    '{"users":5,"organizations":3,"organization_members":3,"audit_logs":3,"licenses":3}'), s));

  -- ================= C6: forged requester_email gets nothing =================
  s := pg_temp.call_as(pg_temp.fx(2), format(usersq, pg_temp.fx(7)))
    || '/' || pg_temp.call_as(pg_temp.fx(2), format('SELECT to_jsonb(count(*)) FROM public.licenses WHERE user_id = %L', pg_temp.fx(7)))
    || '/' || pg_temp.call_as(pg_temp.fx(2), format('SELECT to_jsonb(count(*)) FROM public.audit_logs WHERE user_id = %L', pg_temp.fx(7)));
  r := r || jsonb_build_object('C6_forged_requester_email_reads_0', pg_temp.pass(s = '0/0/0', s));

  -- ================= C7: self-assigned user without support.view gets nothing =================
  s := pg_temp.call_as(pg_temp.fx(4), format(usersq, pg_temp.fx(9)))
    || '/' || pg_temp.call_as(pg_temp.fx(4), format('SELECT to_jsonb(count(*)) FROM public.support_tickets WHERE id = %L', pg_temp.fx(304)));
  r := r || jsonb_build_object('C7_self_assigned_without_support_view_reads_0', pg_temp.pass(s = '0/0', s));

  -- ================= C8: internal users still see their own tickets (internal notes hidden) =================
  s := pg_temp.own(pg_temp.fx(4));
  r := r || jsonb_build_object('C8_internal_user_own_ticket',
    pg_temp.pass(pg_temp.js(s) = '{"users":1,"organization_members":0,"devices":0,"user_preferences":0,"audit_logs":0,"licenses":0,"support_tickets":1,"support_ticket_messages":1,"support_ticket_events":1,"support_ticket_participants":1,"support_ticket_attachments":1}'::jsonb, s));

  s := pg_temp.call_as(pg_temp.fx(4), format('SELECT to_jsonb(count(*)) FROM public.support_tickets WHERE id = %L', pg_temp.fx(307)))
    || '/' || pg_temp.call_as(pg_temp.fx(5), format('SELECT to_jsonb(count(*)) FROM public.support_tickets WHERE id = %L', pg_temp.fx(307)));
  r := r || jsonb_build_object('C8b_internal_user_reads_ticket_carrying_their_email', pg_temp.pass(s = '1/0', s));

  -- ================= C9: reassignment moves access inside one transaction =================
  BEGIN
    s := pg_temp.call_as(pg_temp.fx(2), format(usersq, pg_temp.fx(5)));
    UPDATE public.support_tickets SET assignee_id = pg_temp.fx(3) WHERE id = pg_temp.fx(301);
    s := s || '/' || pg_temp.call_as(pg_temp.fx(2), format(usersq, pg_temp.fx(5)))
           || '/' || pg_temp.call_as(pg_temp.fx(3), format(usersq, pg_temp.fx(5)));
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
    ELSE s := 'ERRRB ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
  END;
  r := r || jsonb_build_object('C9_reassignment_revokes_in_session', pg_temp.pass(s = '1/0/1', s));

  -- ================= C10: policy count / shape unchanged; no internal-role text on the targets =================
  s := (SELECT shape FROM p4145m2_p0);
  s2 := pg_temp.shape();
  r := r || jsonb_build_object('C10_policy_count_and_shape_unchanged', pg_temp.pass(s = s2 AND split_part(s, '/', 1) = split_part(s2, '/', 1), s || ' vs ' || s2));
  s := (SELECT string_agg(tablename || '.' || policyname, ',') FROM pg_policies
         WHERE schemaname = 'public' AND tablename = ANY (ALLT)
           AND (coalesce(qual, '') || coalesce(with_check, '')) ~ '(internal_roles|has_internal_role)');
  r := r || jsonb_build_object('C10b_no_internal_role_text_on_targets', pg_temp.pass(s IS NULL, s));
  s := (SELECT string_agg(policyname || '=' || roles::text, ',' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'public'
         AND policyname IN ('support_tickets_select_public', 'support_ticket_messages_select_public', 'support_ticket_events_select_public',
                            'support_ticket_participants_select_public', 'support_ticket_attachments_select_public'));
  r := r || jsonb_build_object('C10d_support_policies_to_authenticated_others_unchanged',
    pg_temp.pass(s = 'support_ticket_attachments_select_public={authenticated},support_ticket_events_select_public={authenticated},support_ticket_messages_select_public={authenticated},support_ticket_participants_select_public={authenticated},support_tickets_select_public={authenticated}'
                 AND pg_temp.roles_rest() = p0.roles_rest, s || ' ; ' || pg_temp.roles_rest() || ' vs ' || p0.roles_rest));
  n := (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY (ALLT));
  r := r || jsonb_build_object('C10c_target_policy_count_31', pg_temp.pass(n = 31 AND split_part(p0.tdigest, '/', 1) = '31', n::text));

  -- ================= C11: policies call only functions authenticated can execute =================
  s := (SELECT string_agg(DISTINCT d.refobjid::regprocedure::text, ',' ORDER BY d.refobjid::regprocedure::text)
          FROM pg_depend d JOIN pg_policy pol ON pol.oid = d.objid JOIN pg_class c ON c.oid = pol.polrelid
         WHERE d.classid = 'pg_policy'::regclass AND d.refclassid = 'pg_proc'::regclass
           AND c.relnamespace = 'public'::regnamespace AND c.relname = ANY (ALLT)
           AND NOT has_function_privilege('authenticated', d.refobjid, 'EXECUTE'));
  s2 := (SELECT string_agg(DISTINCT d.refobjid::regprocedure::text, ',' ORDER BY d.refobjid::regprocedure::text)
          FROM pg_depend d JOIN pg_policy pol ON pol.oid = d.objid JOIN pg_class c ON c.oid = pol.polrelid
         WHERE d.classid = 'pg_policy'::regclass AND d.refclassid = 'pg_proc'::regclass
           AND c.relnamespace = 'public'::regnamespace AND c.relname = ANY (ALLT));
  r := r || jsonb_build_object('C11_policy_functions_executable_by_authenticated',
    pg_temp.pass(s IS NULL AND s2 LIKE '%has_any_permission(uuid,text[])%' AND s2 LIKE '%report_my_access(text)%'
                 AND s2 LIKE '%support_my_requester_ids()%' AND s2 NOT LIKE '%has_internal_role%', coalesce(s, '') || ' | ' || s2));

  -- ================= K1: every key literal on the targets exists =================
  s := (SELECT string_agg(DISTINCT m[1], ',') FROM pg_policies p, regexp_matches(coalesce(p.qual, '') || coalesce(p.with_check, ''),
           '''([a-z_]+\.[a-z_]+)''::text', 'g') m
         WHERE p.schemaname = 'public' AND p.tablename = ANY (ALLT)
           AND NOT EXISTS (SELECT 1 FROM public.admin_permissions ap WHERE ap.key = m[1]));
  s2 := (SELECT string_agg(DISTINCT m[1], ',') FROM pg_policies p, regexp_matches(coalesce(p.qual, '') || coalesce(p.with_check, ''),
           'report_my_access\(''([^'']+)''::text\)', 'g') m
         WHERE p.schemaname = 'public' AND p.tablename = ANY (ALLT)
           AND NOT EXISTS (SELECT 1 FROM public.reports k WHERE k.report_key = m[1]));
  n := (SELECT count(*) FROM pg_policies p, regexp_matches(coalesce(p.qual, '') || coalesce(p.with_check, ''),
           '''([a-z_]+\.[a-z_]+)''::text|report_my_access\(''([^'']+)''::text\)', 'g') m
         WHERE p.schemaname = 'public' AND p.tablename = ANY (ALLT));
  r := r || jsonb_build_object('K1_every_permission_and_report_key_exists', pg_temp.pass(s IS NULL AND s2 IS NULL AND n > 0,
    'bad perms=' || coalesce(s, '') || ' bad reports=' || coalesce(s2, '') || ' literals=' || n));

  -- ================= A1: anon read of support tables (policies apply to role public) =================
  s := (SELECT jsonb_object_agg(x, pg_temp.call_as(NULL, format('SELECT to_jsonb(count(*)) FROM public.%I', x), 'anon'))::text
          FROM unnest(ARRAY['support_tickets','support_ticket_messages','support_ticket_events',
                            'support_ticket_participants','support_ticket_attachments']) x);
  r := r || jsonb_build_object('A1_anon_support_tables_0_rows',
    pg_temp.pass(pg_temp.js(s) = '{"support_tickets":"0","support_ticket_messages":"0","support_ticket_events":"0","support_ticket_participants":"0","support_ticket_attachments":"0"}'::jsonb
                 AND pg_temp.js(p0.anon5) ->> 'support_tickets' = '0', p0.anon5 || ' -> ' || s));
  s := pg_temp.call_as(NULL, 'SELECT to_jsonb(count(*)) FROM public.users', 'anon');
  r := r || jsonb_build_object('A2_anon_users_0', pg_temp.pass(s = '0', s));

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
  r := r || jsonb_build_object('K2_reapply_idempotent', pg_temp.pass(s = s2 AND s <> p0.tdigest, s || ' vs ' || s2));

  -- ================= K3: rollback file restores the production text exactly =================
  BEGIN
    EXECUTE $rb$__ROLLBACK__$rb$;
    s := pg_temp.tdigest() || '/' || pg_temp.shape();
    RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
    ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80); END IF;
  END;
  r := r || jsonb_build_object('K3_rollback_restores_prod_text',
    pg_temp.pass(s = '31/83dce5f806f9431a9eead58e9f61ea89/' || p0.shape, s));

  -- ================= K0 (applied mode only): keepr-test state equals the migration file =================
  IF to_regclass('pg_temp.p4145m2_applied') IS NOT NULL THEN
    s := (SELECT d FROM p4145m2_applied);
    r := r || jsonb_build_object('K0_applied_state_equals_file', pg_temp.pass(s = pg_temp.tdigest(), s || ' vs ' || pg_temp.tdigest()));
  END IF;

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
