-- BACKLOG-3917 harness helpers (pg_temp, inside the run's rolled-back transaction).
-- Fixture ids are derived from names: pg_temp.id('<name>') as postgres, '{<name>}'
-- inside statements passed to pg_temp.as_user. Output maps ids back to {<name>}.
CREATE FUNCTION pg_temp.id(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT md5('backlog-3917:' || p_name)::uuid $f$;
CREATE FUNCTION pg_temp.id_names() RETURNS SETOF text LANGUAGE sql IMMUTABLE AS $f$
  SELECT unnest(ARRAY['org1','org2','org_p','org_p2','plan','u_s','u_a','u_g','u_gs','u_ts','u_ta','u_p','u_ps',
                      'm_s','m_a','m_g','m_gs','m_ts','m_ta','m_p','m_ps','m_s2','m_gs2','scl','scl_item','sub','sub_p','tpl_org','tpl_own_p','tpl_own_s',
                      'idp','tok','log','att','msg','new_sub']) $f$;
CREATE FUNCTION pg_temp.subst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP p := replace(p, '{' || n || '}', pg_temp.id(n)::text); END LOOP;
  IF p ~ '\{[a-z_0-9]+\}' THEN RAISE EXCEPTION 'unknown fixture name in: %', p; END IF;
  RETURN p; END $f$;
CREATE FUNCTION pg_temp.unsubst(p text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n text; BEGIN
  FOR n IN SELECT pg_temp.id_names() LOOP p := replace(p, pg_temp.id(n)::text, '{' || n || '}'); END LOOP;
  RETURN p; END $f$;

CREATE TEMP TABLE t3917_r (seq serial, label text, ok boolean, detail text) ON COMMIT DROP;

-- Run `sql` as `authenticated` (or p_role) with JWT claims for user {p_user}; returns
-- 'OK rows=N', 'OK <value>' or 'ERR <sqlstate> <message>'. Always rolled back.
CREATE FUNCTION pg_temp.as_role(p_role text, p_user text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n int; msg text; st text;
BEGIN
  p_sql := pg_temp.subst(p_sql);
  BEGIN
    IF p_user IS NOT NULL THEN
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', pg_temp.id(p_user), 'role', p_role, 'email', p_user || '-3917@example.test')::text, true);
    ELSE
      PERFORM set_config('request.jwt.claims', json_build_object('role', p_role)::text, true);
    END IF;
    PERFORM set_config('role', p_role, true);
    IF p_sql ILIKE 'select%' THEN
      EXECUTE 'select (' || substr(p_sql, 8) || ')::text' INTO msg;
      msg := 'OK ' || coalesce(msg, '<null>');
    ELSE
      EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; msg := 'OK rows=' || n;
    END IF;
    PERFORM set_config('role', 'postgres', true);
    RAISE EXCEPTION 't3917_undo' USING DETAIL = msg;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 't3917_undo' THEN GET STACKED DIAGNOSTICS msg = PG_EXCEPTION_DETAIL;
    ELSE GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE; msg := 'ERR ' || st || ' ' || SQLERRM; END IF;
  END;
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN pg_temp.unsubst(msg);
END $f$;
CREATE FUNCTION pg_temp.as_user(p_user text, p_sql text) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.as_role('authenticated', p_user, p_sql) $f$;

CREATE FUNCTION pg_temp.check(p_label text, p_ok boolean, p_detail text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $f$
  INSERT INTO t3917_r (label, ok, detail) VALUES (p_label, coalesce(p_ok, false), pg_temp.unsubst(p_detail)) $f$;
-- A refusal is an error or zero rows touched.
CREATE FUNCTION pg_temp.refused(m text) RETURNS boolean LANGUAGE sql AS $f$
  SELECT m LIKE 'ERR %' OR m = 'OK rows=0' $f$;

-- Set a member's license_status as postgres (the venue for the expired / pending variants).
CREATE FUNCTION pg_temp.set_status(p_member text, p_status text) RETURNS void LANGUAGE sql AS $f$
  UPDATE public.organization_members SET license_status = p_status WHERE id = pg_temp.id(p_member) $f$;

-- Catalogue fingerprint of every object this harness reads, one row per object.
-- Same expressions as the production read recorded in preconditions-3917.sql.
-- Not compared (venue artifacts, stated in README): storage.objects triggers
-- (storage service version) and the support-attachments storage policies.
CREATE FUNCTION pg_temp.fp3917() RETURNS TABLE (k text, v text) LANGUAGE sql AS $f$
  WITH tabs(s, t) AS (VALUES ('public','organization_members'),('public','organizations'),('public','transaction_submissions'),
    ('public','submission_comments'),('public','submission_attachments'),('public','submission_messages'),('public','submission_attempts'),
    ('public','submission_checklist_items'),('public','submission_checklist_link_members'),('public','submission_checklist_links'),
    ('public','submission_checklists'),('public','submission_status_history'),('public','users'),('public','checklist_templates'),
    ('public','checklist_template_items'),('storage','objects'),('public','organization_identity_providers'),('public','scim_tokens'),
    ('public','scim_sync_log')),
  x AS (
    SELECT 'pol ' || p.schemaname || '.' || p.tablename || '.' || p.policyname AS k,
           md5(coalesce(qual,'') || '|' || coalesce(with_check,'') || '|' || cmd || '|' || roles::text || '|' || permissive) AS v
      FROM pg_policies p JOIN tabs ON tabs.s = p.schemaname AND tabs.t = p.tablename
    UNION ALL
    SELECT 'trg ' || n.nspname || '.' || c.relname || '.' || t.tgname,
           md5(pg_get_triggerdef(t.oid) || '|' || t.tgenabled::text || '|' || md5(pg_get_functiondef(t.tgfoid)))
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN tabs ON tabs.s = n.nspname AND tabs.t = c.relname WHERE NOT t.tgisinternal
    UNION ALL
    SELECT 'rls ' || n.nspname || '.' || c.relname, c.relrowsecurity::text || c.relforcerowsecurity::text
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN tabs ON tabs.s = n.nspname AND tabs.t = c.relname
    UNION ALL
    SELECT 'fn ' || p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid) || '|' || coalesce(p.proacl::text, ''))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('is_org_admin','can_review_submission','get_user_org_ids',
       'can_edit_checklist_templates','can_create_own_checklist_templates','can_write_checklist_template','has_internal_role',
       'check_feature_access','member_status_grants_access','save_checklist_template','add_submission_checklist_at_review',
       'remove_submission_checklist_at_review','restore_submission_checklist_at_review','set_submission_checklist_reviewer_check'))
  SELECT k, v FROM x
   WHERE k NOT LIKE 'trg storage.objects.%'
     AND k NOT IN ('pol storage.objects.Agents can delete support attachments','pol storage.objects.Agents can read all support attachments',
                   'pol storage.objects.Agents can upload support attachments','pol storage.objects.Customers can delete own ticket attachments',
                   'pol storage.objects.Customers can read own ticket attachments','pol storage.objects.Customers can upload to own tickets')
$f$;
CREATE FUNCTION pg_temp.fp3917_md5() RETURNS text LANGUAGE sql AS $f$
  SELECT md5(string_agg(k || '=' || v, E'\n' ORDER BY k)) FROM pg_temp.fp3917() $f$;

-- Production's fingerprint before 3917 (read 2026-10-13, prod ledger head 20261013020819).
-- HISTORICAL (BACKLOG-3945, 2026-10-14): not production today. Checks the venue this harness builds.
CREATE TEMP TABLE t3917_prod (k text PRIMARY KEY, v text) ON COMMIT DROP;
INSERT INTO t3917_prod (k, v) VALUES
  ('fn add_submission_checklist_at_review(uuid,uuid)', '3ae3cec0e42576c84bf432d1d9a3246f'),
  ('fn can_create_own_checklist_templates(uuid)', 'f646e4dff722efc621f2df72b77ef35f'),
  ('fn can_edit_checklist_templates(uuid)', '3b9a8dceb0ed129b4fc160ebcfe10f64'),
  ('fn can_review_submission(uuid)', '68c64ba10dc430b660e237d8ea617e3b'),
  ('fn can_write_checklist_template(uuid,uuid)', '7c7396f88fb63140f718df5ccbd31238'),
  ('fn check_feature_access(uuid,text)', 'b271dd9bf2187d58c425806276180b1f'),
  ('fn get_user_org_ids(uuid)', 'f192a28be236193ccb930aef2f5d96f1'),
  ('fn has_internal_role(uuid)', 'b67d4e60480924f083452e4b731c277d'),
  ('fn is_org_admin(uuid,uuid)', 'd4cd29ef23a3c27048c259908a38a620'),
  ('fn remove_submission_checklist_at_review(uuid)', '75a4f3c549e2ecffadf2ce4efe72196f'),
  ('fn restore_submission_checklist_at_review(uuid,uuid)', 'c947093118e746fe418579ba2321eaaf'),
  ('fn save_checklist_template(uuid,uuid,text,text,text,jsonb,boolean,boolean)', '0a9b88c11dbd4a7598f6fc32d3a1d834'),
  ('fn set_submission_checklist_reviewer_check(uuid,boolean)', '73d06c697cef9f808da297ccf56cb453'),
  ('pol public.checklist_template_items.checklist_template_items_delete_writer', 'fa66eac3256fda19b43a2ed6df46da0d'),
  ('pol public.checklist_template_items.checklist_template_items_insert_writer', 'a46ff15ccc1cb6121a41715bf6653774'),
  ('pol public.checklist_template_items.checklist_template_items_select_member', '3356d84f3aa1376cca5adfd17c1dce5a'),
  ('pol public.checklist_template_items.checklist_template_items_update_writer', '1625cc141baff59a0ab31c0e6cd20a5c'),
  ('pol public.checklist_templates.checklist_templates_insert_writer', 'bd388affb40144f71c67facde329ac26'),
  ('pol public.checklist_templates.checklist_templates_select_member', 'b66385fa89d169de0c17fc6a0142c82f'),
  ('pol public.checklist_templates.checklist_templates_update_writer', 'e1c84fa598c2688330ee05d7a663d561'),
  ('pol public.organization_identity_providers.IT admins can manage identity providers', 'ee8d0151c220441b3ea8603b44e69687'),
  ('pol public.organization_identity_providers.Org admins can view identity providers', '2d13184cd8053d17f08ce61936863358'),
  ('pol public.organization_members.organization_members_all_public', '26f1f2113a852901272fb613cf782e58'),
  ('pol public.organization_members.organization_members_select_public', '27f8255cd3589eb108ee67f620b6edb2'),
  ('pol public.organization_members.users_can_accept_invite', 'eeff3edb57e1ec4e558b2a2ac6d5b8be'),
  ('pol public.organization_members.users_can_view_own_invite', '481d98608bb68a4455ccab60fa6ab060'),
  ('pol public.organizations.admins_can_modify_org', 'fe41497c1cb4701c5acb11e111b6ffd3'),
  ('pol public.organizations.organizations_select_public', '4e86a12b5b35316b13099b32f5f5e73a'),
  ('pol public.organizations.service_role_full_access_organizations', 'fa3f6dea225a4b60151162f1cad4dd7f'),
  ('pol public.scim_sync_log.Admins can view SCIM sync logs', 'eceed2b800bf9415231cd26ac0c9e7ef'),
  ('pol public.scim_tokens.IT admins can manage SCIM tokens', '2e266eea93072676ec2e75043694cb23'),
  ('pol public.submission_attachments.agents_can_delete_own_attachments', 'ef7592d098f8506894cd62edf3a626bf'),
  ('pol public.submission_attachments.agents_can_insert_attachments', 'd7c1d42f086dae082692d8f6e4fce8d8'),
  ('pol public.submission_attachments.attachment_access_via_submission', '993094eee68223e616bc15a3b4e2abba'),
  ('pol public.submission_attachments.service_role_full_access_attachments', 'fa3f6dea225a4b60151162f1cad4dd7f'),
  ('pol public.submission_attempts.submission_attempts_select', '50efc4f6308f43656667b7b5c8789f1b'),
  ('pol public.submission_checklist_items.submission_checklist_items_insert', 'afb8b999d3d7f99df08e48a73ad6b3bf'),
  ('pol public.submission_checklist_items.submission_checklist_items_select', 'a62e86743b4da3e8a1929acc743705e5'),
  ('pol public.submission_checklist_link_members.submission_checklist_link_members_insert', '1dcd0cdd66a7d97bccccde41cd999837'),
  ('pol public.submission_checklist_link_members.submission_checklist_link_members_select', '73306726c9e8e2efe3bd857d8798b80a'),
  ('pol public.submission_checklist_links.submission_checklist_links_insert', 'bcdac96d9efc3a00d50b3aaf9ffab1a4'),
  ('pol public.submission_checklist_links.submission_checklist_links_select', 'd9c2293bc88482fd8d0d62ba3d625511'),
  ('pol public.submission_checklists.submission_checklists_insert', 'd82cdb464f631190841a6a7dbceed77e'),
  ('pol public.submission_checklists.submission_checklists_select', 'ea139a8651990422b7e138d37e12a689'),
  ('pol public.submission_comments.comment_access_via_submission', '893d5b39004a21845cbea89a0c9eaaf7'),
  ('pol public.submission_comments.service_role_full_access_comments', 'fa3f6dea225a4b60151162f1cad4dd7f'),
  ('pol public.submission_comments.users_can_create_comments', '501ae58fe4f7e3c67f559d24d516a41d'),
  ('pol public.submission_messages.agents_can_insert_messages', '52a325a722a54309f31fd96888030024'),
  ('pol public.submission_messages.message_access_via_submission', 'd0e422d4f639af13ed29938bfa9b3659'),
  ('pol public.submission_messages.service_role_full_access_messages', 'fa3f6dea225a4b60151162f1cad4dd7f'),
  ('pol public.transaction_submissions.agents_can_create_submissions', '9526c78ef4ee920b11f3bfbe1acc9673'),
  ('pol public.transaction_submissions.agents_can_delete_stale_uploads', 'acf1d8e3db9d12f32ce73ff28949eca0'),
  ('pol public.transaction_submissions.service_role_full_access_submissions', 'fa3f6dea225a4b60151162f1cad4dd7f'),
  ('pol public.transaction_submissions.transaction_submissions_select_public', '7726382d8094df7f5b788052e101dc65'),
  ('pol public.transaction_submissions.transaction_submissions_update_public', 'bb73e3ade0815958362741449da5e800'),
  ('pol public.users.service_role_full_access_users', 'ef8211987096405ff64016e274c67d01'),
  ('pol public.users.users_can_insert_own_user', 'ef62abcfddb1f48c0ac4874337accf48'),
  ('pol public.users.users_can_update_own_user', '7a3ecfee112e5de2400a67c11ecc198e'),
  ('pol public.users.users_select_public', '480f34c4655f166d00fc719543cac418'),
  ('pol storage.objects.Members can upload submission attachments', 'eb427762bafe69fb1ea193b2f4d70460'),
  ('pol storage.objects.Submission attachments follow their submission', '31ab2ca0b92b952ed754dd846475e7dc'),
  ('pol storage.objects.Submitters can delete attachments of their abandoned upload', '8590ac7463b9d325f8f1d5beec0f2e55'),
  ('rls public.checklist_template_items', 'truefalse'),
  ('rls public.checklist_templates', 'truefalse'),
  ('rls public.organization_identity_providers', 'truefalse'),
  ('rls public.organization_members', 'truefalse'),
  ('rls public.organizations', 'truefalse'),
  ('rls public.scim_sync_log', 'truefalse'),
  ('rls public.scim_tokens', 'truefalse'),
  ('rls public.submission_attachments', 'truefalse'),
  ('rls public.submission_attempts', 'truefalse'),
  ('rls public.submission_checklist_items', 'truefalse'),
  ('rls public.submission_checklist_link_members', 'truefalse'),
  ('rls public.submission_checklist_links', 'truefalse'),
  ('rls public.submission_checklists', 'truefalse'),
  ('rls public.submission_comments', 'truefalse'),
  ('rls public.submission_messages', 'truefalse'),
  ('rls public.transaction_submissions', 'truetrue'),
  ('rls public.users', 'truefalse'),
  ('rls storage.objects', 'truefalse'),
  ('trg public.checklist_template_items.checklist_template_items_updated_at', 'c1947e60d81ac3d254907faab7bc733e'),
  ('trg public.checklist_templates.checklist_templates_audit', 'c85c0778f35861060fbe473abd74334b'),
  ('trg public.checklist_templates.checklist_templates_updated_at', '1819752acbe66a48b05697e8f92ba4f4'),
  ('trg public.organization_members.guard_invite_acceptance', '9655100856fa56b879769b51e9ca7d45'),
  ('trg public.organization_members.retire_personal_membership', '3b6d1266f82f60132173d52fdb7bf61b'),
  ('trg public.organization_members.update_org_members_updated_at', '29ecbbddc51e24fbe762b3400cd247b7'),
  ('trg public.organizations.guard_organization_client_update', 'ad78e3c9ef560c0ace1fa76bde86f59a'),
  ('trg public.organizations.guard_personal_owner_user_id', 'a8003d2a50dcbf45583239b913955bf9'),
  ('trg public.organizations.update_organizations_updated_at', '6f1e6685b72eda23c37725668d1a1690'),
  ('trg public.transaction_submissions.commission_figures_locked', 'fe44b78527ad2d40cff3597d2bcf3536'),
  ('trg public.transaction_submissions.status_history_append_only', 'aa39a00968841aab70ee3b2f9d273206'),
  ('trg public.transaction_submissions.submission_abandoned_at_guard', '099e362b29c95dbfb8c92e77668397e9'),
  ('trg public.transaction_submissions.track_status_changes', '7a694fcdfc14ac8730d8d7599e379ac9'),
  ('trg public.transaction_submissions.update_submissions_updated_at', '55f1995bc5d8be85c18ffc6f8031ea07'),
  ('trg public.users.update_users_updated_at', '95bb2dd9004eaaf1654c57b4951e83f3'),
  ('trg public.users.users_keep_onboarding_completed', 'dad30a80c0900a4a33dbc7fd7d3310c1');
