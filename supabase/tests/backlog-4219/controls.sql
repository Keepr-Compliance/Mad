-- BACKLOG-4219 PR1 DB controls: learn_pilot_reports, the validators, learn_pilot_report_submit /
-- _withdraw / _admin_list, the purge job, grants, rollback.
-- Venue: keepr-test ONLY (kt-sql refuses the production ref). ONE call, ONE transaction ending in
-- RAISE, so nothing persists. Run with compose.py --with-migration (migration applied TWICE in
-- front), or without it once the migration is applied. Needs 20261105100000 (BACKLOG-4144) and
-- 20261107235503 (BACKLOG-4175) applied.
-- Mutations are applied to the migration / rollback FILE by mutate.py, then this runs.
-- Fixtures (invented, same pattern as backlog-4175/controls.sql; ids fx(n), emails
-- p4219-<n>@example.test; admin roles picked BY NAME):
--   u1 Super Admin (owner)   u2 Support Supervisor + viewer on learn-pilot   u3 Support Supervisor, no grant
--   u5 signed in, no internal role, no org
--   u6, u10, u12 members of org X (brokerage, active; autodetect_eval on)
--   u7 member of org Y (brokerage, active; no plan -> autodetect_eval default false)
--   u8 personal org P (membership created EARLIER) + org X (later)  -> resolves to X
--   u9 org X membership suspended only  -> no org
--   u13 member of org Z (brokerage, active; autodetect_eval on)
--   u14 org X suspended (EARLIER) + org Z active (later)  -> resolves to Z
-- The autodetect_eval override is the shape the founder's go set on the pilot org
-- (organization_plans.feature_overrides {"autodetect_eval":{"enabled":true}}, pm_comments 32c2a51a / fe112802
-- on BACKLOG-4120); keepr-test has no such row, so it is inserted here.
-- Output: RAISE 'P4219_RESULT {total, pass, fail, reds}'.

DO $drv$
DECLARE
  v_r jsonb;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.fx(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$
    SELECT ('00000000-0000-4219-8000-' || lpad(n::text, 12, '0'))::uuid
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.clear_claims() RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);
  END $b$$f$;

  -- run one statement as a role ('authenticated' with a user, or 'anon'): a SELECT/WITH returning
  -- jsonb gives its value as text; any other statement gives '"ok"'; an error gives
  -- 'ERR <sqlstate> <message>'. Each call is its own subtransaction.
  EXECUTE $f$CREATE FUNCTION pg_temp.call_as(u uuid, q text, r text DEFAULT 'authenticated') RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE j jsonb;
  BEGIN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
      PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
      PERFORM set_config('request.jwt.claim.role', r, true);
      EXECUTE format('SET LOCAL ROLE %I', r);
      IF q ~* '^\s*(select|with)\M' THEN
        EXECUTE q INTO j;
      ELSE
        EXECUTE q;
        j := '"ok"'::jsonb;
      END IF;
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN coalesce(j::text, 'null');
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      PERFORM pg_temp.clear_claims();
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 100);
    END;
  END $b$$f$;

  -- the DETAIL of the error a statement raises as a user ('none' when it does not raise)
  EXECUTE $f$CREATE FUNCTION pg_temp.detail_as(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE j jsonb; d text;
  BEGIN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', u::text, true);
      SET LOCAL ROLE authenticated;
      EXECUTE q INTO j;
      RESET ROLE;
      PERFORM pg_temp.clear_claims();
      RETURN 'none';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL;
      RESET ROLE;
      PERFORM pg_temp.clear_claims();
      RETURN coalesce(d, '');
    END;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.pass(ok boolean, detail text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL ' || left(coalesce(detail, 'null'), 300) END
  $b$$f$;

  -- one census block, all 7 signal keys present (zero-filled), one mailbox
  EXECUTE $f$CREATE FUNCTION pg_temp.census(hit int) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $b$
    SELECT jsonb_build_object(
      'mailboxes', jsonb_build_array(jsonb_build_object(
        'ordinal', 1, 'provider', 'gmail', 'n', 40,
        'full', jsonb_build_object('k', hit, 'by_signal', jsonb_build_object(
          'seedAddress', 0, 'approvedHost', 0, 'localPart', 0, 'bulkHeaders', hit,
          'gmailPromotions', 0, 'gmailSocial', 0, 'gmailUpdates', 0)),
        'minus_contact_keeps', jsonb_build_object('k', hit, 'by_signal', jsonb_build_object(
          'seedAddress', 0, 'approvedHost', 0, 'localPart', 0, 'bulkHeaders', hit,
          'gmailPromotions', 0, 'gmailSocial', 0, 'gmailUpdates', 0)),
        'address_pass_ready', hit = 0, 'detector_ready', false)),
      'min_linked_emails', 200,
      'bulk_caught', jsonb_build_object('k', 3, 'n', 10),
      'real_estate_suppressed', jsonb_build_object('k', 0, 'n', 10),
      'found_deals_lost', jsonb_build_object('full', 0, 'minus', 0),
      'cleanup_yes_lost', jsonb_build_object('full', 0, 'minus', 0),
      'kept_by', jsonb_build_object('K1', 2, 'K2', 1, 'K3', 0),
      'keep_conflicts', 0,
      'coverage', jsonb_build_object(
        'gmail', jsonb_build_object('rows', 50, 'headers', 48, 'labels', 50),
        'outlook', jsonb_build_object('rows', 0, 'headers', 0, 'labels', 0),
        'unknown', jsonb_build_object('rows', 0, 'headers', 0, 'labels', 0)))
  $b$$f$;

  -- a valid schema-1 report for one sender rules version
  EXECUTE $f$CREATE FUNCTION pg_temp.rep(v bigint, det int DEFAULT 4) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $b$
    SELECT jsonb_build_object(
      'schema', 1, 'app_version', '2.47.0',
      'learn_rules_version', 3, 'sender_rules_version', v,
      'sender_rules_source', 'download', 'sender_rules_download_rejected', false,
      'window_months', 12, 'rows_scanned', 900, 'null_sent_at', 0,
      'labels_without_local_mail', 0, 'legacy_manual_positives', 1,
      'detections', det, 'true_detections', 2, 'known_wrong', 0, 'matched_neutral', 1,
      'unmatched', 1, 'unmatched_deals', 1, 'unaskable', 0, 'seed_linked_to_deals', 0,
      'positives', 3, 'found', 2, 'missed', 1,
      'deals_in_key', jsonb_build_object('manual', 3, 'auto', 1, 'hybrid', 0, 'rejected', 1),
      'cleanup', jsonb_build_object('yes', 1, 'no', 0, 'unanswered', 0),
      'hidden_by_seed', jsonb_build_object('keys', 0, 'detections', 0, 'emails', 0),
      'recall', jsonb_build_object('k', 2, 'n', 3),
      'recall_with_cleanup_yes', jsonb_build_object('k', 3, 'n', 4),
      'recall_excluding_legacy', jsonb_build_object('k', 1, 'n', 2),
      'recall_with_cleanup_yes_excluding_legacy', jsonb_build_object('k', 2, 'n', 3),
      'precision_before_cleanup', jsonb_build_object('k', 2, 'n', 4),
      'precision_after_cleanup', jsonb_build_object('k', 3, 'n', 4),
      'side', jsonb_build_object('correct', 2, 'wrong', 0, 'not_predicted', 0, 'skipped', 0),
      'outcome', jsonb_build_object('scorable', 2, 'skipped', 0, 'predicted', 2),
      'bulk', jsonb_build_object('answered', 10, 'real_estate', 4, 'newsletter_spam', 5, 'skip', 1,
        'not_cached', 0, 'newsletter_flagged', jsonb_build_object('k', 1, 'n', 5),
        'real_estate_flagged', jsonb_build_object('k', 4, 'n', 4)),
      'answers_by_rule_version', jsonb_build_array(jsonb_build_object('rule_version', 3, 'deal', 1, 'bulk', 10)),
      'census', jsonb_build_object('learn_questions', pg_temp.census(1), 'detector', pg_temp.census(0)))
  $b$$f$;

  -- submit as a user: '""' on success, 'ERR ...' otherwise
  EXECUTE $f$CREATE FUNCTION pg_temp.sub(u uuid, p jsonb) RETURNS text LANGUAGE sql AS $b$
    SELECT pg_temp.call_as(u, format('SELECT to_jsonb(public.learn_pilot_report_submit(%L::jsonb)::text)', p))
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.wd(u uuid) RETURNS text LANGUAGE sql AS $b$
    SELECT pg_temp.call_as(u, 'SELECT to_jsonb(public.learn_pilot_report_withdraw())')
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.lst(u uuid) RETURNS text LANGUAGE sql AS $b$
    SELECT pg_temp.call_as(u, 'SELECT public.learn_pilot_report_admin_list()')
  $b$$f$;

  -- sender_rules_versions a user holds, ascending, as text '{1,2}'
  EXECUTE $f$CREATE FUNCTION pg_temp.vers(u uuid) RETURNS text LANGUAGE sql AS $b$
    SELECT coalesce(array_agg(sender_rules_version ORDER BY sender_rules_version)::text, '{}')
    FROM public.learn_pilot_reports WHERE user_id = u
  $b$$f$;

  -- "time passes": every existing row of the user gets older (now() is frozen in one transaction)
  EXECUTE $f$CREATE FUNCTION pg_temp.age(u uuid, mins int DEFAULT 1) RETURNS void LANGUAGE sql AS $b$
    UPDATE public.learn_pilot_reports SET submitted_at = submitted_at - make_interval(mins => mins) WHERE user_id = u
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    s text; s2 text; s3 text; s4 text; n int; n2 int; ok boolean; k text; f text; p jsonb; j jsonb;
    t1 timestamptz; t2 timestamptz; vC bigint; vR bigint; vv int;
    u1 uuid := pg_temp.fx(1); u2 uuid := pg_temp.fx(2); u3 uuid := pg_temp.fx(3);
    u5 uuid := pg_temp.fx(5); u6 uuid := pg_temp.fx(6); u7 uuid := pg_temp.fx(7); u8 uuid := pg_temp.fx(8);
    u9 uuid := pg_temp.fx(9); u10 uuid := pg_temp.fx(10); u12 uuid := pg_temp.fx(12); u13 uuid := pg_temp.fx(13); u14 uuid := pg_temp.fx(14);
    oX uuid := pg_temp.fx(31); oY uuid := pg_temp.fx(32); oP uuid := pg_temp.fx(33); oZ uuid := pg_temp.fx(34);
    r_sa uuid := (SELECT id FROM public.admin_roles WHERE name = 'Super Admin');
    r_ss uuid := (SELECT id FROM public.admin_roles WHERE name = 'Support Supervisor');
    pl_team uuid := (SELECT id FROM public.plans WHERE name = 'Team');
    INVALID text := 'ERR 22023 Invalid report';
    NA text := 'ERR 42501 %';
    BS text[] := ARRAY['census', 'learn_questions', 'mailboxes', '0', 'full', 'by_signal'];
    pub_sigs text[] := ARRAY['public.learn_pilot_report_submit(jsonb)', 'public.learn_pilot_report_withdraw()',
                             'public.learn_pilot_report_admin_list()'];
    priv_sigs text[] := ARRAY['public._learn_pilot_int_ok(jsonb)', 'public._learn_pilot_counts_ok(jsonb,text[])',
                              'public._learn_pilot_census_invalid(jsonb)', 'public._learn_pilot_report_invalid(jsonb)'];
    expected_keys text[] := ARRAY['app_version', 'org_current_pin_at', 'org_current_pin_version', 'org_id', 'org_name',
      'report', 'sender_rules_version', 'submitted_at', 'user_id', 'user_name', 'version_bundled', 'version_canary_org',
      'version_published_at', 'version_released', 'version_was_canary_for_this_org'];
  BEGIN
    -- ===== S0: catalog key once, table empty, one purge job, daily =====
    r := r || jsonb_build_object('S0_seed_table_job', pg_temp.pass(
      (SELECT count(*) FROM public.reports WHERE report_key = 'learn-pilot') = 1
      AND to_regclass('public.learn_pilot_reports') IS NOT NULL
      AND (SELECT count(*) FROM public.learn_pilot_reports) = 0
      AND (SELECT count(*) FROM cron.job WHERE jobname = 'purge-learn-pilot-reports') = 1
      AND (SELECT schedule FROM cron.job WHERE jobname = 'purge-learn-pilot-reports') = '17 4 * * *'
      AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.learn_pilot_reports'::regclass),
      'reports=' || (SELECT count(*) FROM public.reports WHERE report_key = 'learn-pilot')
      || ' jobs=' || (SELECT count(*) FROM cron.job WHERE jobname = 'purge-learn-pilot-reports')));

    -- ===== fixtures =====
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT pg_temp.fx(x), 'p4219-' || x || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM generate_series(1, 14) x;
    -- names: u6 has display_name AND first + last (display_name wins), u10 first + last only,
    -- u13 no name at all, everyone else a display_name
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name, first_name, last_name)
    SELECT pg_temp.fx(x), 'p4219-' || x || '@example.test', 'email', pg_temp.fx(x)::text,
           CASE WHEN x IN (10, 13) THEN NULL ELSE 'P4219 user ' || x END,
           CASE x WHEN 10 THEN 'Pat' WHEN 6 THEN 'Sam' END, CASE x WHEN 10 THEN 'Ten' WHEN 6 THEN 'Six' END
      FROM generate_series(1, 14) x
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, first_name = EXCLUDED.first_name,
                                   last_name = EXCLUDED.last_name;
    INSERT INTO public.internal_roles (user_id, role_id) VALUES (u1, r_sa), (u2, r_ss), (u3, r_ss);
    -- (a mutation that drops the catalog key makes this insert fail; K0 then reds instead of the run aborting)
    BEGIN
      INSERT INTO public.report_access (report_key, user_id, role) VALUES ('learn-pilot', u2, 'viewer');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    -- org fixtures: triggers off for these rows only (billing / seat / personal-org guards are not under test)
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.organizations (id, name, slug) VALUES
      (oX, 'P4219 X', 'p4219-x'), (oY, 'P4219 Y', 'p4219-y'), (oZ, 'P4219 Z', 'p4219-z');
    INSERT INTO public.organizations (id, name, slug, personal_owner_user_id) VALUES (oP, 'P4219 P', 'p4219-p', u8);
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, created_at) VALUES
      (oX, u6, 'agent', 'active', now()),
      (oX, u10, 'agent', 'active', now()),
      (oX, u12, 'agent', 'active', now()),
      (oY, u7, 'agent', 'active', now()),
      (oP, u8, 'admin', 'active', now() - interval '1 day'),
      (oX, u8, 'agent', 'active', now()),
      (oX, u9, 'agent', 'suspended', now()),
      (oZ, u13, 'agent', 'active', now()),
      -- u14 in two brokerages: removing the replica line above fails setup here (4179 single_brokerage_guard, 20261112121000, raises already_placed)
      (oX, u14, 'agent', 'suspended', now() - interval '1 day'),
      (oZ, u14, 'agent', 'active', now());
    INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides) VALUES
      (oX, pl_team, '{"autodetect_eval":{"enabled":true}}'),
      (oZ, pl_team, '{"autodetect_eval":{"enabled":true}}');
    SET LOCAL session_replication_role = origin;

    r := r || jsonb_build_object('K0_fixtures', pg_temp.pass(
      r_sa IS NOT NULL AND r_ss IS NOT NULL AND pl_team IS NOT NULL
      AND pg_temp.call_as(u1, 'SELECT to_jsonb(public.report_my_access(''learn-pilot''))') = '"owner"'
      AND pg_temp.call_as(u2, 'SELECT to_jsonb(public.report_my_access(''learn-pilot''))') = '"viewer"'
      AND pg_temp.call_as(u3, 'SELECT to_jsonb(public.report_my_access(''learn-pilot''))') = 'null'
      AND pg_temp.call_as(u6, format('SELECT public.check_feature_access(%L, ''autodetect_eval'')->''allowed''', oX)) = 'true'
      AND pg_temp.call_as(u7, format('SELECT public.check_feature_access(%L, ''autodetect_eval'')->''allowed''', oY)) = 'false'
      AND public._learn_pilot_report_invalid(pg_temp.rep(1)) IS NULL
      AND current_setting('session_replication_role') = 'origin',
      'u1=' || pg_temp.call_as(u1, 'SELECT to_jsonb(public.report_my_access(''learn-pilot''))')
      || ' u2=' || pg_temp.call_as(u2, 'SELECT to_jsonb(public.report_my_access(''learn-pilot''))')
      || ' inv=' || coalesce(public._learn_pilot_report_invalid(pg_temp.rep(1)), '-')));

    -- ===== S1a: a valid report is stored, one row, org X, app_version copied =====
    s := pg_temp.sub(u6, pg_temp.rep(1));
    r := r || jsonb_build_object('S1a_valid_accepted', pg_temp.pass(
      s = '""' AND pg_temp.vers(u6) = '{1}'
      AND (SELECT org_id = oX AND app_version = '2.47.0' AND report = pg_temp.rep(1)
             FROM public.learn_pilot_reports WHERE user_id = u6),
      s || ' vers=' || pg_temp.vers(u6)));

    -- ===== S1b: every off-schema report is refused; the stored row is untouched =====
    s := '';
    FOR k, p IN
      SELECT * FROM (VALUES
        ('top_unknown_key', pg_temp.rep(1) || '{"extra":1}'),
        ('top_missing_key', pg_temp.rep(1) - 'missed'),
        ('nested_unknown_key', jsonb_set(pg_temp.rep(1), '{cleanup,extra}', '1')),
        ('nested_missing_key', pg_temp.rep(1) #- '{side,skipped}'),
        ('by_signal_free_text_key', jsonb_set(pg_temp.rep(1), BS, '{"agent@x.example":1}')),
        ('by_signal_extra_key', jsonb_set(pg_temp.rep(1), BS, (pg_temp.rep(1) #> BS) || '{"agent@x.example":1}')),
        ('by_signal_partial', jsonb_set(pg_temp.rep(1), BS, (pg_temp.rep(1) #> BS) - 'gmailUpdates')),
        ('detector_minus_free_text_key', jsonb_set(pg_temp.rep(1), '{census,detector,mailboxes,0,minus_contact_keeps,by_signal}', '{"x.example":0}')),
        ('coverage_free_text_key', jsonb_set(pg_temp.rep(1), '{census,detector,coverage}', (pg_temp.rep(1) #> '{census,detector,coverage}') || '{"yahoo.com":{"rows":0,"headers":0,"labels":0}}')),
        ('float', jsonb_set(pg_temp.rep(1), '{detections}', '1.5')),
        ('negative', jsonb_set(pg_temp.rep(1), '{found}', '-1')),
        ('string_in_int', jsonb_set(pg_temp.rep(1), '{positives}', '"3"')),
        ('null_in_int', jsonb_set(pg_temp.rep(1), '{positives}', 'null')),
        ('int_too_big', jsonb_set(pg_temp.rep(1), '{rows_scanned}', '10000001')),
        ('nested_float', jsonb_set(pg_temp.rep(1), '{recall,k}', '0.5')),
        ('map_value_negative', jsonb_set(pg_temp.rep(1), BS || ARRAY['seedAddress'], '-2')),
        ('schema_2', jsonb_set(pg_temp.rep(1), '{schema}', '2')),
        ('schema_string', jsonb_set(pg_temp.rep(1), '{schema}', '"1"')),
        ('source_address', jsonb_set(pg_temp.rep(1), '{sender_rules_source}', '"a@b.example"')),
        ('provider_domain', jsonb_set(pg_temp.rep(1), '{census,learn_questions,mailboxes,0,provider}', '"yahoo.com"')),
        ('app_version_text', jsonb_set(pg_temp.rep(1), '{app_version}', '"2.47.0 agent@x.example"')),
        ('bool_as_int', jsonb_set(pg_temp.rep(1), '{census,detector,mailboxes,0,detector_ready}', '1')),
        ('bool_as_string', jsonb_set(pg_temp.rep(1), '{sender_rules_download_rejected}', '"false"')),
        ('mailboxes_11', jsonb_set(pg_temp.rep(1), '{census,learn_questions,mailboxes}',
            (SELECT jsonb_agg(pg_temp.rep(1) #> '{census,learn_questions,mailboxes,0}') FROM generate_series(1, 11)))),
        ('answers_11', jsonb_set(pg_temp.rep(1), '{answers_by_rule_version}',
            (SELECT jsonb_agg(jsonb_build_object('rule_version', x, 'deal', 0, 'bulk', 0)) FROM generate_series(1, 11) x))),
        ('detector_block_missing', pg_temp.rep(1) #- '{census,detector}'),
        ('census_extra_block', jsonb_set(pg_temp.rep(1), '{census,address_pass}', pg_temp.census(0))),
        ('array_not_object', '[1,2]'::jsonb),
        ('scalar', '7'::jsonb)) x(name, rep)
    LOOP
      s2 := pg_temp.sub(u6, p);
      IF s2 NOT LIKE INVALID THEN s := s || k || '=' || left(s2, 50) || ' '; END IF;
    END LOOP;
    r := r || jsonb_build_object('S1b_off_schema_refused', pg_temp.pass(
      s = '' AND pg_temp.vers(u6) = '{1}'
      AND (SELECT report = pg_temp.rep(1) FROM public.learn_pilot_reports WHERE user_id = u6),
      s || ' vers=' || pg_temp.vers(u6)));

    -- ===== S1c: the 32 KB cap is checked first (reason 'too large', not a key reason) =====
    s := pg_temp.detail_as(u6, format('SELECT to_jsonb(public.learn_pilot_report_submit(%L::jsonb)::text)',
      pg_temp.rep(1) || jsonb_build_object('pad', repeat('x', 40000))));
    r := r || jsonb_build_object('S1c_size_cap', pg_temp.pass(s = 'too large', s));

    -- ===== S1d: no org or user parameter on any RPC =====
    r := r || jsonb_build_object('S1d_signatures', pg_temp.pass(
      (SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname = 'learn_pilot_report_submit') = 'p_report jsonb'
      AND (SELECT pronargs FROM pg_proc WHERE proname = 'learn_pilot_report_withdraw') = 0
      AND (SELECT pronargs FROM pg_proc WHERE proname = 'learn_pilot_report_admin_list') = 0
      AND (SELECT count(*) FROM pg_proc WHERE proname LIKE 'learn_pilot_report%') = 3,
      (SELECT string_agg(proname || '(' || pg_get_function_identity_arguments(oid) || ')', ',') FROM pg_proc WHERE proname LIKE 'learn_pilot_report%')));

    -- ===== S2: the org is derived on the server, brokerage before an earlier personal org =====
    s := pg_temp.sub(u8, pg_temp.rep(1));
    r := r || jsonb_build_object('S2_org_brokerage_first', pg_temp.pass(
      s = '""' AND (SELECT org_id FROM public.learn_pilot_reports WHERE user_id = u8) = oX,
      s || ' org=' || coalesce((SELECT org_id::text FROM public.learn_pilot_reports WHERE user_id = u8), '-')));

    -- ===== S2b: a suspended membership is never the org (u14: X suspended earlier, Z active) =====
    s := pg_temp.sub(u14, pg_temp.rep(1));
    r := r || jsonb_build_object('S2b_org_active_only', pg_temp.pass(
      s = '""' AND (SELECT org_id FROM public.learn_pilot_reports WHERE user_id = u14) = oZ,
      s || ' org=' || coalesce((SELECT org_id::text FROM public.learn_pilot_reports WHERE user_id = u14), '-')));
    DELETE FROM public.learn_pilot_reports WHERE user_id = u14;

    -- ===== P11 (server half): submit then withdraw, in that order -> no row =====
    s := pg_temp.wd(u8);
    r := r || jsonb_build_object('P11_submit_then_withdraw', pg_temp.pass(
      s = '1' AND pg_temp.vers(u8) = '{}', s || ' vers=' || pg_temp.vers(u8)));

    -- ===== S6: refused without autodetect_eval, without an org, suspended, signed out =====
    s := pg_temp.sub(u7, pg_temp.rep(1));
    s2 := pg_temp.sub(u5, pg_temp.rep(1));
    s3 := pg_temp.sub(u9, pg_temp.rep(1));
    s4 := pg_temp.call_as(NULL, format('SELECT to_jsonb(public.learn_pilot_report_submit(%L::jsonb)::text)', pg_temp.rep(1)), 'anon');
    r := r || jsonb_build_object('S6_feature_and_org_required', pg_temp.pass(
      s LIKE NA AND s2 LIKE NA AND s3 LIKE NA AND s4 LIKE NA
      AND NOT EXISTS (SELECT 1 FROM public.learn_pilot_reports WHERE user_id IN (u5, u7, u9)),
      'Y=' || s || ' noorg=' || s2 || ' susp=' || s3 || ' anon=' || s4));

    -- ===== S12: the stored version is the report's own field; bad version values refused =====
    s := '';
    FOREACH f IN ARRAY ARRAY['0', '-1', '1.5', '"2"', 'null'] LOOP
      s2 := pg_temp.sub(u6, jsonb_set(pg_temp.rep(1), '{sender_rules_version}', f::jsonb));
      IF s2 NOT LIKE INVALID THEN s := s || f || '=' || left(s2, 50) || ' '; END IF;
    END LOOP;
    r := r || jsonb_build_object('S12_version_from_report', pg_temp.pass(
      s = '' AND pg_temp.vers(u6) = '{1}'
      AND NOT EXISTS (SELECT 1 FROM public.learn_pilot_reports
                      WHERE sender_rules_version IS DISTINCT FROM (report->>'sender_rules_version')::bigint),
      s || ' vers=' || pg_temp.vers(u6)));

    -- ===== S8: one row per version; the same version again replaces it and moves its time =====
    s := pg_temp.sub(u10, pg_temp.rep(1, 1));
    s2 := pg_temp.sub(u10, pg_temp.rep(2, 1));
    PERFORM pg_temp.age(u10, 10);
    t1 := (SELECT submitted_at FROM public.learn_pilot_reports WHERE user_id = u10 AND sender_rules_version = 1);
    s3 := pg_temp.sub(u10, pg_temp.rep(1, 7));
    r := r || jsonb_build_object('S8_same_version_replaces', pg_temp.pass(
      s = '""' AND s2 = '""' AND s3 = '""' AND pg_temp.vers(u10) = '{1,2}'
      AND (SELECT submitted_at > t1 AND report->'detections' = '7'::jsonb
             FROM public.learn_pilot_reports WHERE user_id = u10 AND sender_rules_version = 1)
      AND (SELECT report->'detections' = '1'::jsonb FROM public.learn_pilot_reports WHERE user_id = u10 AND sender_rules_version = 2),
      s || s2 || s3 || ' vers=' || pg_temp.vers(u10)));

    -- ===== S9: cap 5 per user by submit time: 2,3,4,5,6,1,1 -> {1,3,4,5,6}; u10 untouched =====
    DELETE FROM public.learn_pilot_reports WHERE user_id = u6;
    s := '';
    FOREACH vv IN ARRAY ARRAY[2, 3, 4, 5, 6, 1, 1] LOOP
      PERFORM pg_temp.age(u6, 1);
      PERFORM pg_temp.age(u10, 1);
      s2 := pg_temp.sub(u6, pg_temp.rep(vv));
      IF s2 <> '""' THEN s := s || vv || '=' || s2 || ' '; END IF;
    END LOOP;
    r := r || jsonb_build_object('S9_cap_5_oldest_submit_first', pg_temp.pass(
      s = '' AND pg_temp.vers(u6) = '{1,3,4,5,6}' AND pg_temp.vers(u10) = '{1,2}',
      s || ' u6=' || pg_temp.vers(u6) || ' u10=' || pg_temp.vers(u10)));

    -- ===== S10: withdraw deletes every version of the caller, nobody else's =====
    s := pg_temp.wd(u6);
    r := r || jsonb_build_object('S10_withdraw_all_versions', pg_temp.pass(
      s = '5' AND pg_temp.vers(u6) = '{}' AND pg_temp.vers(u10) = '{1,2}',
      s || ' u6=' || pg_temp.vers(u6) || ' u10=' || pg_temp.vers(u10)));

    -- ===== S3: withdraw works after the user left the org (no membership or feature check) =====
    s := pg_temp.sub(u12, pg_temp.rep(1));
    SET LOCAL session_replication_role = replica;
    DELETE FROM public.organization_members WHERE user_id = u12;
    SET LOCAL session_replication_role = origin;
    s2 := pg_temp.wd(u12);
    r := r || jsonb_build_object('S3_withdraw_after_leaving', pg_temp.pass(
      s = '""' AND s2 = '1' AND pg_temp.vers(u12) = '{}', s || ' wd=' || s2 || ' vers=' || pg_temp.vers(u12)));

    -- ===== S7c: the in-submit sweep deletes any row older than 180 days =====
    BEGIN
      INSERT INTO public.learn_pilot_reports (user_id, sender_rules_version, org_id, report, app_version, submitted_at)
      VALUES (u13, 3, oZ, pg_temp.rep(3), '2.47.0', now() - interval '181 days');
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    s := pg_temp.sub(u8, pg_temp.rep(1));
    r := r || jsonb_build_object('S7c_submit_sweeps_old_rows', pg_temp.pass(
      s = '""' AND pg_temp.vers(u13) = '{}' AND pg_temp.vers(u8) = '{1}',
      s || ' u13=' || pg_temp.vers(u13)));
    DELETE FROM public.learn_pilot_reports WHERE user_id = u8;

    -- ===== S5: no client privilege on the table; validators private; anon executes nothing =====
    s := '';
    FOREACH k IN ARRAY ARRAY['authenticated', 'anon'] LOOP
      FOREACH f IN ARRAY ARRAY[
        'SELECT to_jsonb(count(*)) FROM public.learn_pilot_reports',
        'INSERT INTO public.learn_pilot_reports (user_id, sender_rules_version, org_id, report, app_version) VALUES ('
          || quote_literal(u5) || ', 1, ' || quote_literal(oX) || ', ''{"sender_rules_version":1}'', ''x'')',
        'UPDATE public.learn_pilot_reports SET app_version = ''x'' WHERE true',
        'DELETE FROM public.learn_pilot_reports WHERE true',
        'TRUNCATE public.learn_pilot_reports'] LOOP
        s2 := pg_temp.call_as(CASE WHEN k = 'anon' THEN NULL ELSE u5 END, f, k);
        IF s2 NOT LIKE 'ERR 42501%' THEN s := s || k || ':' || left(f, 30) || '=' || left(s2, 40) || ' '; END IF;
      END LOOP;
    END LOOP;
    FOREACH f IN ARRAY pub_sigs LOOP
      IF has_function_privilege('anon', f, 'EXECUTE') THEN s := s || 'anon_exec:' || f || ' '; END IF;
      IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN s := s || 'auth_no_exec:' || f || ' '; END IF;
      IF (SELECT bool_or(a::text LIKE '=X%') FROM pg_proc pp, unnest(pp.proacl) a WHERE pp.oid = f::regprocedure) THEN
        s := s || 'public_exec:' || f || ' ';
      END IF;
      IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure) THEN s := s || 'not_definer:' || f || ' '; END IF;
    END LOOP;
    FOREACH f IN ARRAY priv_sigs LOOP
      IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
        s := s || 'client_exec:' || f || ' ';
      END IF;
    END LOOP;
    s2 := pg_temp.call_as(u5, 'SELECT to_jsonb(public._learn_pilot_report_invalid(''{}''::jsonb))');
    s3 := pg_temp.call_as(NULL, 'SELECT to_jsonb(public.learn_pilot_report_withdraw())', 'anon');
    s4 := pg_temp.call_as(NULL, 'SELECT public.learn_pilot_report_admin_list()', 'anon');
    IF s2 NOT LIKE 'ERR 42501%' THEN s := s || 'validator_call=' || left(s2, 40) || ' '; END IF;
    IF s3 NOT LIKE 'ERR 42501%' THEN s := s || 'anon_wd=' || left(s3, 40) || ' '; END IF;
    IF s4 NOT LIKE 'ERR 42501%' THEN s := s || 'anon_list=' || left(s4, 40) || ' '; END IF;
    FOREACH k IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH f IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
        IF has_table_privilege(k, 'public.learn_pilot_reports', f) THEN s := s || k || '_' || f || ' '; END IF;
      END LOOP;
    END LOOP;
    r := r || jsonb_build_object('S5_grants', pg_temp.pass(s = '', s));

    -- ===== S11 fixtures: a released version, a canary for X (pinned to X), a version unknown to the server =====
    vR := (SELECT max(version) FROM public.sender_rule_sets WHERE released);
    s := pg_temp.call_as(u1, format('SELECT to_jsonb(public.sender_rule_set_publish(%L::jsonb, %L::uuid))',
      (SELECT content FROM public.sender_rule_sets WHERE version = vR), oX));
    vC := CASE WHEN s ~ '^[0-9]+$' THEN s::bigint END;
    s2 := pg_temp.sub(u6, pg_temp.rep(vR));
    PERFORM pg_temp.age(u6, 2);
    s3 := pg_temp.sub(u6, pg_temp.rep(vC));
    PERFORM pg_temp.age(u6, 1);
    s3 := s3 || pg_temp.sub(u6, pg_temp.rep(999999));
    s4 := pg_temp.sub(u13, pg_temp.rep(vC));
    -- a row whose user is no longer active in its org (u9 suspended in X), and one older than 180 days
    -- (direct inserts; a mutated key can refuse them, which K1 reports instead of the run aborting)
    s := 'ok';
    BEGIN
      INSERT INTO public.learn_pilot_reports (user_id, sender_rules_version, org_id, report, app_version, submitted_at) VALUES
        (u9, 1, oX, pg_temp.rep(1), '2.47.0', now()),
        (u10, 3, oX, pg_temp.rep(3), '2.47.0', now() - interval '181 days');
    EXCEPTION WHEN OTHERS THEN s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 100);
    END;
    r := r || jsonb_build_object('K1_direct_fixture_rows', pg_temp.pass(s = 'ok', s));

    -- ===== S4: the admin read gate =====
    s := pg_temp.lst(u1);
    BEGIN
      DELETE FROM public.reports WHERE report_key = 'learn-pilot';
      f := pg_temp.lst(u1);
      RAISE EXCEPTION 'SEED_DONE' USING DETAIL = f;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'SEED_DONE' THEN GET STACKED DIAGNOSTICS f = PG_EXCEPTION_DETAIL;
      ELSE f := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 100); END IF;
    END;
    r := r || jsonb_build_object('S4_admin_gate', pg_temp.pass(
      s NOT LIKE 'ERR%' AND jsonb_typeof(s::jsonb->'rows') = 'array'
      AND pg_temp.lst(u2) NOT LIKE 'ERR%'
      AND pg_temp.lst(u3) LIKE NA
      AND pg_temp.lst(u5) LIKE NA
      AND pg_temp.lst(u6) LIKE NA
      AND f LIKE NA
      AND (SELECT count(*) FROM public.reports WHERE report_key = 'learn-pilot') = 1,
      'u1=' || left(s, 40) || ' u2=' || left(pg_temp.lst(u2), 40) || ' u3=' || pg_temp.lst(u3)
      || ' u5=' || pg_temp.lst(u5) || ' noseed=' || f));

    -- ===== S4b / S7: hidden rows (left the org, older than 180 days); viewer sees the same rows as owner =====
    j := CASE WHEN s LIKE 'ERR%' THEN '{"rows":[]}'::jsonb ELSE s::jsonb END;
    r := r || jsonb_build_object('S4b_hidden_rows', pg_temp.pass(
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'rows') x WHERE x->>'user_id' = u9::text)
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'rows') x
                      WHERE x->>'user_id' = u10::text AND x->>'sender_rules_version' = '3')
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(j->'rows') x
                  WHERE x->>'user_id' = u10::text AND x->>'sender_rules_version' = '2')
      AND pg_temp.lst(u2) = j::text
      AND (j->'truncated') = 'false'::jsonb,
      left(j::text, 300)));

    -- ===== S11: joined to rule-set versions and pins; the canary mark is per org; LEFT JOIN; no *_by keys =====
    s := '';
    FOR p IN SELECT x FROM jsonb_array_elements(j->'rows') x WHERE x->>'user_id' LIKE '00000000-0000-4219-8000-%' LOOP
      IF (SELECT array_agg(kk ORDER BY kk) FROM jsonb_object_keys(p) kk) <> expected_keys THEN
        s := s || 'keys=' || (SELECT string_agg(kk, ',' ORDER BY kk) FROM jsonb_object_keys(p) kk) || ' ';
      END IF;
    END LOOP;
    r := r || jsonb_build_object('S11_versions_and_pins', pg_temp.pass(
      vC IS NOT NULL AND s = '' AND s2 = '""' AND s3 = '""""' AND s4 = '""'
      -- u6 (org X) on the canary for X: marked, pinned
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(j->'rows') x
                  WHERE x->>'user_id' = u6::text AND (x->>'sender_rules_version')::bigint = vC
                    AND x->'version_was_canary_for_this_org' = 'true'::jsonb AND x->'version_released' = 'false'::jsonb
                    AND x->>'version_canary_org' = oX::text
                    AND (x->>'org_current_pin_version')::bigint = vC AND x->>'org_name' = 'P4219 X')
      -- u13 (org Z) on the same canary: not marked, no pin for Z
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(j->'rows') x
                  WHERE x->>'user_id' = u13::text AND (x->>'sender_rules_version')::bigint = vC
                    AND x->'version_was_canary_for_this_org' = 'false'::jsonb
                    AND x->'org_current_pin_version' = 'null'::jsonb AND x->>'org_name' = 'P4219 Z')
      -- u6 on the released version
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(j->'rows') x
                  WHERE x->>'user_id' = u6::text AND (x->>'sender_rules_version')::bigint = vR
                    AND x->'version_released' = 'true'::jsonb AND x->'version_was_canary_for_this_org' = 'false'::jsonb)
      -- u6 on a version the server has no row for: still listed, version columns null
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(j->'rows') x
                  WHERE x->>'user_id' = u6::text AND x->>'sender_rules_version' = '999999'
                    AND x->'version_released' = 'null'::jsonb AND x->'version_was_canary_for_this_org' = 'false'::jsonb
                    AND x->'report' = pg_temp.rep(999999))
      AND j::text NOT LIKE '%published_by%' AND j::text NOT LIKE '%pinned_by%',
      'vR=' || coalesce(vR::text, '-') || ' vC=' || coalesce(vC::text, s) || ' subs=' || s2 || s3 || s4 || ' ' || s
      || ' rows=' || left((j->'rows')::text, 200)));

    -- ===== S13: each row names its user by Keepr user id, the user who submitted that row; no email anywhere =====
    -- Every fixture row's user_id must be the user_id of a stored row with the same version and time (the
    -- submitter), u6's rows must carry u6, and the whole result carries no '@', and no row key naming an email or label (the
    -- report's own counters such as min_linked_emails are numbers and are not row keys).
    r := r || jsonb_build_object('S13_user_id_not_email', pg_temp.pass(
      EXISTS (SELECT 1 FROM jsonb_array_elements(j->'rows') x WHERE x->>'user_id' = u6::text)
      AND (SELECT count(*) FROM jsonb_array_elements(j->'rows') x WHERE x->>'user_id' LIKE '00000000-0000-4219-8000-%')
          = (SELECT count(*) FROM jsonb_array_elements(j->'rows') x
             WHERE EXISTS (SELECT 1 FROM public.learn_pilot_reports lr
                           WHERE lr.user_id::text = x->>'user_id'
                             AND lr.sender_rules_version = (x->>'sender_rules_version')::bigint
                             AND lr.submitted_at = (x->>'submitted_at')::timestamptz
                             AND lr.user_id::text LIKE '00000000-0000-4219-8000-%'))
      AND (SELECT count(*) FROM jsonb_array_elements(j->'rows') x WHERE x->>'user_id' LIKE '00000000-0000-4219-8000-%') >= 4
      AND j::text NOT LIKE '%@%'
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'rows') x, jsonb_object_keys(x) kk WHERE kk ~* '(email|label|name_of_user)')
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'rows') x WHERE (x - 'report')::text ~* 'p4219-[0-9]+@'),
      'rows=' || left((j->'rows')::text, 300)));

    -- ===== S13b: user_name = display_name, else first + last, else NULL (never the email); an
    --       email-shaped display_name comes back NULL =====
    s := (SELECT string_agg(DISTINCT (x->>'user_id') || '=' || coalesce(x->>'user_name', '<null>') || ':' || jsonb_typeof(x->'user_name'), ' ')
          FROM jsonb_array_elements(j->'rows') x WHERE x->>'user_id' IN (u6::text, u10::text, u13::text));
    UPDATE public.users SET display_name = 'p4219-6@example.test' WHERE id = u6;
    s2 := pg_temp.lst(u1);
    UPDATE public.users SET display_name = 'P4219 user 6' WHERE id = u6;
    r := r || jsonb_build_object('S13b_user_name', pg_temp.pass(
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'rows') x WHERE x->>'user_id' = u6::text AND x->>'user_name' IS DISTINCT FROM 'P4219 user 6')
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(j->'rows') x WHERE x->>'user_id' = u6::text)
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'rows') x WHERE x->>'user_id' = u10::text AND x->>'user_name' IS DISTINCT FROM 'Pat Ten')
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(j->'rows') x WHERE x->>'user_id' = u10::text)
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'rows') x WHERE x->>'user_id' = u13::text AND x->'user_name' <> 'null'::jsonb)
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(j->'rows') x WHERE x->>'user_id' = u13::text AND x ? 'user_name')
      AND s2 NOT LIKE 'ERR%'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(s2::jsonb->'rows') x WHERE x->>'user_id' = u6::text)
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s2::jsonb->'rows') x WHERE x->>'user_id' = u6::text AND x->'user_name' <> 'null'::jsonb)
      AND s2 NOT LIKE '%@%',
      coalesce(s, '-') || ' guard=' || left(s2, 120)));

    -- ===== S7b: the scheduled purge body (read from cron.job, not a copy) =====
    UPDATE public.learn_pilot_reports SET submitted_at = now() - interval '1 day' WHERE user_id = u10 AND sender_rules_version = 2;
    s := (SELECT command FROM cron.job WHERE jobname = 'purge-learn-pilot-reports');
    IF s IS NOT NULL THEN EXECUTE s; END IF;
    r := r || jsonb_build_object('S7b_purge_job', pg_temp.pass(
      s IS NOT NULL AND pg_temp.vers(u10) = '{1,2}' AND pg_temp.vers(u6) <> '{}',
      'job=' || coalesce(left(s, 60), 'missing') || ' u10=' || pg_temp.vers(u10)));

    -- ===== S20: the rollback removes every object, the job and the catalog key =====
    BEGIN
      EXECUTE $rb$__ROLLBACK__$rb$;
      s := CASE WHEN to_regclass('public.learn_pilot_reports') IS NULL
                 AND (SELECT count(*) FROM pg_proc WHERE proname LIKE '%learn_pilot%') = 0
                 AND NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-learn-pilot-reports')
                 AND NOT EXISTS (SELECT 1 FROM public.reports WHERE report_key = 'learn-pilot')
                 AND NOT EXISTS (SELECT 1 FROM public.report_access WHERE report_key = 'learn-pilot')
            THEN 'removed' ELSE 'left: procs=' || coalesce((SELECT string_agg(proname, ',') FROM pg_proc WHERE proname LIKE '%learn_pilot%'), '-')
                 || ' table=' || coalesce(to_regclass('public.learn_pilot_reports')::text, '-')
                 || ' jobs=' || (SELECT count(*) FROM cron.job WHERE jobname = 'purge-learn-pilot-reports') END;
      RAISE EXCEPTION 'RB_DONE' USING DETAIL = s;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'RB_DONE' THEN GET STACKED DIAGNOSTICS s = PG_EXCEPTION_DETAIL;
      ELSE s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 100); END IF;
    END;
    r := r || jsonb_build_object('S20_rollback_removes_everything', pg_temp.pass(s = 'removed', s));

    RETURN r;
  END $b$$f$;

  v_r := pg_temp.run();
  RAISE EXCEPTION 'P4219_RESULT %', jsonb_build_object(
    'total', (SELECT count(*) FROM jsonb_each_text(v_r)),
    'pass', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value = 'PASS'),
    'fail', (SELECT count(*) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'),
    'reds', (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r) e WHERE e.value <> 'PASS'));
END
$drv$;
