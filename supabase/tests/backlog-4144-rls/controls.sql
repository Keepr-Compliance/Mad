-- BACKLOG-4144 M2 DB controls: the four report-only tables are readable per report.
-- Venue: keepr-test ONLY (kt-sql refuses the production ref). ONE call, ONE transaction ending in RAISE,
-- so nothing persists. Needs 20261105100000 (M1) and 20261031000000 (support_sla_settings) applied.
-- Re-runnable before and after M2 is applied: the run first restores the pre-M2 policies with the
-- rollback (inside the transaction), takes the P0 baseline, then applies the migration (from the
-- working tree, TWICE: idempotent), runs the controls, and finally runs the rollback again and compares.
-- Mutations are applied to the migration FILE by mutate.py, then this runs.
--
-- Fixtures (invented; ids from fx(n), emails p4144r-<n>@example.test; roles picked BY NAME):
--   1 A Super Admin                 2 B Support Supervisor, viewer on funnel
--   3 C Support Supervisor, viewer on exports          4 D Support Supervisor, viewer on iphone-sync
--   5 G Support Supervisor, viewer on google-messages-sync
--   6 H Support Supervisor, viewer on submissions      7 I Support Supervisor, viewer on support-sla
--   8 N Support Supervisor, no report access           9 E Support Agent (no analytics.view), no access
--  10 F authenticated, no internal role (owns one row in each user table)
--  11 R authenticated, no internal role, broker of org O (submission reviewer)
--  12 P authenticated, no internal role: producer of the report rows
--   orgs 31 O (P's submissions), 32 Q (F's submission)
-- Report rows produced by P:
--   analytics_events: paywall-viewed x2, unlock-clicked x1, payment-succeeded x1, export-completed x2, user_login x1
--   sync_outcomes:    iphone-backup x2, google-messages x1, p4144-other x1
--   submission_attempts: 2 in O
-- F owns: analytics_events user_login x1, sync_outcomes iphone-backup x1 (outcome running), submission_attempts 1 in Q.
-- Every count is restricted to fixture user ids, so real keepr-test rows never change a result.
-- Output: RAISE 'P4144_RESULT {total, pass, fail, reds}'.

DO $drv$
DECLARE
  v_r jsonb;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
    SELECT ('00000000-0000-4144-8002-' || lpad(n::text, 12, '0'))::uuid
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.call_as(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE j jsonb;
  BEGIN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', u::text, true);
      SET LOCAL ROLE authenticated;
      EXECUTE q INTO j;
      RESET ROLE;
      PERFORM set_config('request.jwt.claims', '', true);
      PERFORM set_config('request.jwt.claim.sub', '', true);
      RETURN coalesce(j::text, 'null');
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE;
      PERFORM set_config('request.jwt.claims', '', true);
      PERFORM set_config('request.jwt.claim.sub', '', true);
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
    END;
  END $b$$f$;

  -- rows of table t matching w, as the user: '<n>' or 'ERR ...'
  EXECUTE $f$CREATE FUNCTION pg_temp.cnt(u uuid, t text, w text) RETURNS text LANGUAGE sql AS $b$
    SELECT pg_temp.call_as(u, format('SELECT to_jsonb(count(*)) FROM public.%I WHERE %s', t, w))
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.pass(ok boolean, detail text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || left(coalesce(detail, 'null'), 260) END
  $b$$f$;

  -- policies on the four tables, one row each
  EXECUTE $f$CREATE FUNCTION pg_temp.pols() RETURNS TABLE (tbl name, pol name, cmd text, roles text, permissive text, qual text, wc text)
    LANGUAGE sql AS $b$
    SELECT tablename, policyname, cmd, roles::text, permissive, coalesce(qual, ''), coalesce(with_check, '')
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('analytics_events', 'sync_outcomes', 'submission_attempts', 'support_sla_settings')
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    s text;
    uA uuid := pg_temp.fx(1);  uB uuid := pg_temp.fx(2);  uC uuid := pg_temp.fx(3);  uD uuid := pg_temp.fx(4);
    uG uuid := pg_temp.fx(5);  uH uuid := pg_temp.fx(6);  uI uuid := pg_temp.fx(7);  uN uuid := pg_temp.fx(8);
    uE uuid := pg_temp.fx(9);  uF uuid := pg_temp.fx(10); uR uuid := pg_temp.fx(11); uP uuid := pg_temp.fx(12);
    oO uuid := pg_temp.fx(31); oQ uuid := pg_temp.fx(32);
    r_sa uuid := (SELECT id FROM public.admin_roles WHERE name = 'Super Admin');
    r_ss uuid := (SELECT id FROM public.admin_roles WHERE name = 'Support Supervisor');
    r_ag uuid := (SELECT id FROM public.admin_roles WHERE name = 'Support Agent');
    wP text; wF text; wPF text;
    FUN3 text := 'event_name IN (''paywall-viewed'',''unlock-clicked'',''payment-succeeded'')';
    EXP text := 'event_name = ''export-completed''';
    OTH text := 'event_name = ''user_login''';
    IPH text := 'source = ''iphone-backup''';
    GMS text := 'source = ''google-messages''';
    OSRC text := 'source = ''p4144-other''';
  BEGIN
    wP := format('user_id = %L', uP);
    wF := format('user_id = %L', uF);
    wPF := format('user_id IN (%L, %L)', uP, uF);

    -- ===== pre-M2 state (whatever keepr-test holds now) =====
    EXECUTE $rb$__ROLLBACK__$rb$;
    CREATE TEMP TABLE p4144_old ON COMMIT DROP AS SELECT * FROM pg_temp.pols();
    r := r || jsonb_build_object('R0_pre_text_equals_prod', pg_temp.pass(
      (SELECT md5(qual) FROM p4144_old WHERE pol = 'analytics_events_select_own_or_internal') = 'd247c211e204a20ce401851da92092c8'
      AND (SELECT md5(qual) FROM p4144_old WHERE pol = 'Internal roles can read sync outcomes') = '64cef7be76851c518dc9a9228ad1af19'
      AND (SELECT md5(qual) FROM p4144_old WHERE pol = 'submission_attempts_select') = '77dde7655b213df03cfea8b4b18d99a0'
      AND (SELECT md5(qual) FROM p4144_old WHERE pol = 'support_sla_settings_select_internal') = 'd4f42f3f4d09d3b2efa8089660aa9a9c'
      AND (SELECT count(*) FROM p4144_old) = 10,
      'policies=' || (SELECT count(*) FROM p4144_old)));

    -- ===== fixtures =====
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT pg_temp.fx(x), 'p4144r-' || x || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM generate_series(1, 12) x;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    SELECT pg_temp.fx(x), 'p4144r-' || x || '@example.test', 'email', pg_temp.fx(x)::text, 'P4144r user ' || x
      FROM generate_series(1, 12) x ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;
    INSERT INTO public.internal_roles (user_id, role_id) VALUES
      (uA, r_sa), (uB, r_ss), (uC, r_ss), (uD, r_ss), (uG, r_ss), (uH, r_ss), (uI, r_ss), (uN, r_ss), (uE, r_ag);
    INSERT INTO public.organizations (id, name, slug) VALUES
      (oO, 'P4144r org O', 'p4144r-org-o'), (oQ, 'P4144r org Q', 'p4144r-org-q');
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, provisioned_by)
      VALUES (oO, uR, 'broker', 'active', 'manual');

    INSERT INTO public.analytics_events (user_id, event_name) VALUES
      (uP, 'paywall-viewed'), (uP, 'paywall-viewed'), (uP, 'unlock-clicked'), (uP, 'payment-succeeded'),
      (uP, 'export-completed'), (uP, 'export-completed'), (uP, 'user_login'), (uF, 'user_login');
    INSERT INTO public.sync_outcomes (user_id, source, outcome) VALUES
      (uP, 'iphone-backup', 'complete'), (uP, 'iphone-backup', 'error'), (uP, 'google-messages', 'complete'),
      (uP, 'p4144-other', 'complete'), (uF, 'iphone-backup', 'running');
    INSERT INTO public.submission_attempts (submission_id, user_id, organization_id) VALUES
      (pg_temp.fx(41), uP, oO), (pg_temp.fx(42), uP, oO), (pg_temp.fx(43), uF, oQ);

    -- ===== P0 baseline (pre-M2 policies): a role with NO report access reads every report row =====
    r := r || jsonb_build_object('P0a_agent_reads_all_events_today', pg_temp.pass(pg_temp.cnt(uE, 'analytics_events', wPF) = '8', pg_temp.cnt(uE, 'analytics_events', wPF)));
    r := r || jsonb_build_object('P0b_agent_reads_all_syncs_today', pg_temp.pass(pg_temp.cnt(uE, 'sync_outcomes', wPF) = '5', pg_temp.cnt(uE, 'sync_outcomes', wPF)));
    r := r || jsonb_build_object('P0c_agent_reads_all_submissions_today', pg_temp.pass(pg_temp.cnt(uE, 'submission_attempts', wPF) = '3', pg_temp.cnt(uE, 'submission_attempts', wPF)));
    r := r || jsonb_build_object('P0d_agent_reads_sla_today', pg_temp.pass(pg_temp.cnt(uE, 'support_sla_settings', 'true') = '1', pg_temp.cnt(uE, 'support_sla_settings', 'true')));
    r := r || jsonb_build_object('P0e_supervisor_no_access_reads_all_today', pg_temp.pass(pg_temp.cnt(uN, 'analytics_events', wPF) = '8', pg_temp.cnt(uN, 'analytics_events', wPF)));
    r := r || jsonb_build_object('P0f_no_role_reads_only_own', pg_temp.pass(pg_temp.cnt(uF, 'analytics_events', wPF) = '1', pg_temp.cnt(uF, 'analytics_events', wPF)));

    -- ===== M2, applied twice =====
    EXECUTE $mg$__MIGRATION__$mg$;
    EXECUTE $mg$__MIGRATION__$mg$;
    CREATE TEMP TABLE p4144_new ON COMMIT DROP AS SELECT * FROM pg_temp.pols();

    -- ===== K catalog: same policies (name, command, roles, permissive), only the 4 SELECT texts changed =====
    r := r || jsonb_build_object('K1_policy_set_unchanged', pg_temp.pass(
      NOT EXISTS ((SELECT tbl, pol, cmd, roles, permissive FROM p4144_old) EXCEPT (SELECT tbl, pol, cmd, roles, permissive FROM p4144_new))
      AND NOT EXISTS ((SELECT tbl, pol, cmd, roles, permissive FROM p4144_new) EXCEPT (SELECT tbl, pol, cmd, roles, permissive FROM p4144_old)),
      (SELECT string_agg(tbl || '.' || pol, ',') FROM ((SELECT tbl, pol FROM p4144_new) EXCEPT (SELECT tbl, pol FROM p4144_old)) x)));
    r := r || jsonb_build_object('K2_policy_count_per_table', pg_temp.pass(
      (SELECT string_agg(tbl || '=' || n, ',' ORDER BY tbl) FROM (SELECT tbl, count(*) n FROM p4144_new GROUP BY tbl) x)
        = 'analytics_events=3,submission_attempts=1,support_sla_settings=2,sync_outcomes=4',
      (SELECT string_agg(tbl || '=' || n, ',' ORDER BY tbl) FROM (SELECT tbl, count(*) n FROM p4144_new GROUP BY tbl) x)));
    r := r || jsonb_build_object('K3_only_four_texts_changed', pg_temp.pass(
      (SELECT string_agg(n.pol::text, ',' ORDER BY n.pol) FROM p4144_new n JOIN p4144_old o USING (tbl, pol)
        WHERE n.qual <> o.qual OR n.wc <> o.wc)
        = 'Internal roles can read sync outcomes,analytics_events_select_own_or_internal,submission_attempts_select,support_sla_settings_select_internal',
      (SELECT string_agg(n.pol::text, ',' ORDER BY n.pol) FROM p4144_new n JOIN p4144_old o USING (tbl, pol) WHERE n.qual <> o.qual OR n.wc <> o.wc)));
    r := r || jsonb_build_object('K4_new_texts_use_wrapper_not_internal', pg_temp.pass(
      (SELECT bool_and(qual LIKE '%report_my_access(%' AND qual NOT LIKE '%_report_access_role%'
                       AND qual NOT LIKE '%internal_roles%' AND qual NOT LIKE '%has_internal_role%')
         FROM p4144_new WHERE pol IN ('analytics_events_select_own_or_internal', 'Internal roles can read sync outcomes',
                                      'submission_attempts_select', 'support_sla_settings_select_internal')),
      'a new text lacks report_my_access or keeps an internal-role branch'));

    -- ===== C1 no access -> 0 =====
    r := r || jsonb_build_object('C1a_agent_events_0', pg_temp.pass(pg_temp.cnt(uE, 'analytics_events', wP) = '0', pg_temp.cnt(uE, 'analytics_events', wP)));
    r := r || jsonb_build_object('C1b_supervisor_no_access_events_0', pg_temp.pass(pg_temp.cnt(uN, 'analytics_events', wP) = '0', pg_temp.cnt(uN, 'analytics_events', wP)));
    r := r || jsonb_build_object('C1c_agent_syncs_0', pg_temp.pass(pg_temp.cnt(uE, 'sync_outcomes', wPF) = '0', pg_temp.cnt(uE, 'sync_outcomes', wPF)));
    r := r || jsonb_build_object('C1d_supervisor_no_access_syncs_0', pg_temp.pass(pg_temp.cnt(uN, 'sync_outcomes', wPF) = '0', pg_temp.cnt(uN, 'sync_outcomes', wPF)));
    r := r || jsonb_build_object('C1e_supervisor_no_access_submissions_0', pg_temp.pass(pg_temp.cnt(uN, 'submission_attempts', wPF) = '0', pg_temp.cnt(uN, 'submission_attempts', wPF)));
    r := r || jsonb_build_object('C1f_agent_submissions_0', pg_temp.pass(pg_temp.cnt(uE, 'submission_attempts', wPF) = '0', pg_temp.cnt(uE, 'submission_attempts', wPF)));
    r := r || jsonb_build_object('C1g_supervisor_no_access_sla_0', pg_temp.pass(pg_temp.cnt(uN, 'support_sla_settings', 'true') = '0', pg_temp.cnt(uN, 'support_sla_settings', 'true')));
    r := r || jsonb_build_object('C1h_agent_sla_0', pg_temp.pass(pg_temp.cnt(uE, 'support_sla_settings', 'true') = '0', pg_temp.cnt(uE, 'support_sla_settings', 'true')));

    -- ===== C1 Super Admin -> non-empty (the private-helper mutation reds these with 42501) =====
    r := r || jsonb_build_object('C1i_superadmin_funnel_events_4', pg_temp.pass(pg_temp.cnt(uA, 'analytics_events', wP || ' AND ' || FUN3) = '4', pg_temp.cnt(uA, 'analytics_events', wP || ' AND ' || FUN3)));
    r := r || jsonb_build_object('C1j_superadmin_export_events_2', pg_temp.pass(pg_temp.cnt(uA, 'analytics_events', wP || ' AND ' || EXP) = '2', pg_temp.cnt(uA, 'analytics_events', wP || ' AND ' || EXP)));
    r := r || jsonb_build_object('C1k_superadmin_syncs_3', pg_temp.pass(pg_temp.cnt(uA, 'sync_outcomes', wP) = '3', pg_temp.cnt(uA, 'sync_outcomes', wP)));
    r := r || jsonb_build_object('C1l_superadmin_submissions_3', pg_temp.pass(pg_temp.cnt(uA, 'submission_attempts', wPF) = '3', pg_temp.cnt(uA, 'submission_attempts', wPF)));
    r := r || jsonb_build_object('C1m_superadmin_sla_1', pg_temp.pass(pg_temp.cnt(uA, 'support_sla_settings', 'true') = '1', pg_temp.cnt(uA, 'support_sla_settings', 'true')));
    -- event names and sources no report reads: no internal reader, Super Admin included
    r := r || jsonb_build_object('C1n_unread_event_name_0_for_superadmin', pg_temp.pass(pg_temp.cnt(uA, 'analytics_events', wP || ' AND ' || OTH) = '0', pg_temp.cnt(uA, 'analytics_events', wP || ' AND ' || OTH)));
    r := r || jsonb_build_object('C1o_unread_source_0_for_superadmin', pg_temp.pass(pg_temp.cnt(uA, 'sync_outcomes', wP || ' AND ' || OSRC) = '0', pg_temp.cnt(uA, 'sync_outcomes', wP || ' AND ' || OSRC)));

    -- ===== grants =====
    INSERT INTO public.report_access (report_key, user_id, role) VALUES
      ('funnel', uB, 'viewer'), ('exports', uC, 'viewer'), ('iphone-sync', uD, 'viewer'),
      ('google-messages-sync', uG, 'viewer'), ('submissions', uH, 'viewer'), ('support-sla', uI, 'viewer'),
      ('funnel', uE, 'viewer');  -- a row on a user without analytics.view stays closed

    -- ===== C1 viewer on the right key -> rows; on the sibling key -> 0 =====
    -- funnel viewer: the three funnel-only events AND export-completed (the funnel's last step)
    r := r || jsonb_build_object('C1p_funnel_viewer_funnel_events_4', pg_temp.pass(pg_temp.cnt(uB, 'analytics_events', wP || ' AND ' || FUN3) = '4', pg_temp.cnt(uB, 'analytics_events', wP || ' AND ' || FUN3)));
    r := r || jsonb_build_object('C1q_funnel_viewer_export_completed_2', pg_temp.pass(pg_temp.cnt(uB, 'analytics_events', wP || ' AND ' || EXP) = '2', pg_temp.cnt(uB, 'analytics_events', wP || ' AND ' || EXP)));
    -- exports viewer: export-completed only, none of the three funnel-only events
    r := r || jsonb_build_object('C1r_exports_viewer_export_completed_2', pg_temp.pass(pg_temp.cnt(uC, 'analytics_events', wP || ' AND ' || EXP) = '2', pg_temp.cnt(uC, 'analytics_events', wP || ' AND ' || EXP)));
    r := r || jsonb_build_object('C1s_exports_viewer_funnel_only_events_0', pg_temp.pass(pg_temp.cnt(uC, 'analytics_events', wP || ' AND ' || FUN3) = '0', pg_temp.cnt(uC, 'analytics_events', wP || ' AND ' || FUN3)));
    r := r || jsonb_build_object('C1t_report_viewers_unread_event_0', pg_temp.pass(
      pg_temp.cnt(uB, 'analytics_events', wP || ' AND ' || OTH) = '0' AND pg_temp.cnt(uC, 'analytics_events', wP || ' AND ' || OTH) = '0',
      pg_temp.cnt(uB, 'analytics_events', wP || ' AND ' || OTH) || '/' || pg_temp.cnt(uC, 'analytics_events', wP || ' AND ' || OTH)));
    r := r || jsonb_build_object('C1u_iphone_viewer_iphone_2', pg_temp.pass(pg_temp.cnt(uD, 'sync_outcomes', wP || ' AND ' || IPH) = '2', pg_temp.cnt(uD, 'sync_outcomes', wP || ' AND ' || IPH)));
    r := r || jsonb_build_object('C1v_iphone_viewer_gm_0', pg_temp.pass(pg_temp.cnt(uD, 'sync_outcomes', wP || ' AND ' || GMS) = '0', pg_temp.cnt(uD, 'sync_outcomes', wP || ' AND ' || GMS)));
    r := r || jsonb_build_object('C1w_gm_viewer_gm_1', pg_temp.pass(pg_temp.cnt(uG, 'sync_outcomes', wP || ' AND ' || GMS) = '1', pg_temp.cnt(uG, 'sync_outcomes', wP || ' AND ' || GMS)));
    r := r || jsonb_build_object('C1x_gm_viewer_iphone_0', pg_temp.pass(pg_temp.cnt(uG, 'sync_outcomes', wPF || ' AND ' || IPH) = '0', pg_temp.cnt(uG, 'sync_outcomes', wPF || ' AND ' || IPH)));
    r := r || jsonb_build_object('C1y_submissions_viewer_3', pg_temp.pass(pg_temp.cnt(uH, 'submission_attempts', wPF) = '3', pg_temp.cnt(uH, 'submission_attempts', wPF)));
    r := r || jsonb_build_object('C1z_sla_viewer_1', pg_temp.pass(pg_temp.cnt(uI, 'support_sla_settings', 'true') = '1', pg_temp.cnt(uI, 'support_sla_settings', 'true')));
    -- cross-report: one report's viewer reads none of another report's table
    r := r || jsonb_build_object('C1za_funnel_viewer_other_tables_0', pg_temp.pass(
      pg_temp.cnt(uB, 'sync_outcomes', wPF) = '0' AND pg_temp.cnt(uB, 'submission_attempts', wPF) = '0' AND pg_temp.cnt(uB, 'support_sla_settings', 'true') = '0',
      pg_temp.cnt(uB, 'sync_outcomes', wPF) || '/' || pg_temp.cnt(uB, 'submission_attempts', wPF) || '/' || pg_temp.cnt(uB, 'support_sla_settings', 'true')));
    r := r || jsonb_build_object('C1zb_sla_viewer_other_tables_0', pg_temp.pass(
      pg_temp.cnt(uI, 'analytics_events', wP) = '0' AND pg_temp.cnt(uI, 'sync_outcomes', wPF) = '0' AND pg_temp.cnt(uI, 'submission_attempts', wPF) = '0',
      pg_temp.cnt(uI, 'analytics_events', wP) || '/' || pg_temp.cnt(uI, 'sync_outcomes', wPF) || '/' || pg_temp.cnt(uI, 'submission_attempts', wPF)));
    r := r || jsonb_build_object('C1zc_row_without_analytics_view_closed', pg_temp.pass(pg_temp.cnt(uE, 'analytics_events', wP) = '0', pg_temp.cnt(uE, 'analytics_events', wP)));
    -- removal takes effect on the next read
    DELETE FROM public.report_access WHERE user_id = uB;
    r := r || jsonb_build_object('C1zd_removed_access_closes_at_read', pg_temp.pass(pg_temp.cnt(uB, 'analytics_events', wP) = '0', pg_temp.cnt(uB, 'analytics_events', wP)));

    -- ===== C6 non-internal branches kept =====
    r := r || jsonb_build_object('C6a_own_event_readable', pg_temp.pass(pg_temp.cnt(uF, 'analytics_events', wPF) = '1', pg_temp.cnt(uF, 'analytics_events', wPF)));
    r := r || jsonb_build_object('C6b_own_sync_readable', pg_temp.pass(pg_temp.cnt(uF, 'sync_outcomes', wPF) = '1', pg_temp.cnt(uF, 'sync_outcomes', wPF)));
    r := r || jsonb_build_object('C6c_own_sync_updatable', pg_temp.pass(
      pg_temp.call_as(uF, format('WITH u AS (UPDATE public.sync_outcomes SET outcome = ''complete'' WHERE user_id = %L AND outcome = ''running'' RETURNING 1) SELECT to_jsonb(count(*)) FROM u', uF)) = '1',
      pg_temp.call_as(uF, format('WITH u AS (UPDATE public.sync_outcomes SET outcome = ''complete'' WHERE user_id = %L RETURNING 1) SELECT to_jsonb(count(*)) FROM u', uF))));
    r := r || jsonb_build_object('C6d_own_submission_readable', pg_temp.pass(pg_temp.cnt(uF, 'submission_attempts', wPF) = '1', pg_temp.cnt(uF, 'submission_attempts', wPF)));
    r := r || jsonb_build_object('C6e_reviewer_reads_org_submissions', pg_temp.pass(pg_temp.cnt(uR, 'submission_attempts', wPF) = '2', pg_temp.cnt(uR, 'submission_attempts', wPF)));
    r := r || jsonb_build_object('C6f_others_rows_closed_to_no_role', pg_temp.pass(
      pg_temp.cnt(uF, 'analytics_events', wP) = '0' AND pg_temp.cnt(uR, 'sync_outcomes', wPF) = '0',
      pg_temp.cnt(uF, 'analytics_events', wP) || '/' || pg_temp.cnt(uR, 'sync_outcomes', wPF)));

    -- ===== RB rollback restores the exact pre-M2 text =====
    EXECUTE $rb$__ROLLBACK__$rb$;
    r := r || jsonb_build_object('RB1_rollback_restores_exact_text', pg_temp.pass(
      NOT EXISTS ((SELECT * FROM p4144_old) EXCEPT (SELECT * FROM pg_temp.pols()))
      AND NOT EXISTS ((SELECT * FROM pg_temp.pols()) EXCEPT (SELECT * FROM p4144_old))
      AND NOT EXISTS (SELECT 1 FROM pg_policy p JOIN pg_description d ON d.objoid = p.oid AND d.classoid = 'pg_policy'::regclass
                       WHERE p.polrelid IN ('public.analytics_events'::regclass, 'public.sync_outcomes'::regclass,
                                            'public.submission_attempts'::regclass, 'public.support_sla_settings'::regclass)),
      (SELECT string_agg(pol::text, ',') FROM ((SELECT * FROM pg_temp.pols()) EXCEPT (SELECT * FROM p4144_old)) x)));
    r := r || jsonb_build_object('RB2_rollback_reopens_internal_read', pg_temp.pass(pg_temp.cnt(uN, 'analytics_events', wPF) = '8', pg_temp.cnt(uN, 'analytics_events', wPF)));

    RETURN r;
  END $b$$f$;

  v_r := pg_temp.run();
  RAISE EXCEPTION 'P4144_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(v_r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'));
END
$drv$;
