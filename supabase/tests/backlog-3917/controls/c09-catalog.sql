-- C09: catalogue. The helper's definition and grants; the five helpers keep
-- production's SECURITY DEFINER flag, volatility, search_path and grants; every
-- changed function and policy calls the helper (P2 in USING and WITH CHECK, the
-- comment read rule in both branches); roles/commands unchanged; every other
-- pinned object still equals production (organizations_select_public included).
DO $$ DECLARE r record; n int; bad text;
  changed text[] := ARRAY[
    'fn is_org_admin(uuid,uuid)','fn can_review_submission(uuid)','fn get_user_org_ids(uuid)',
    'fn can_edit_checklist_templates(uuid)','fn can_create_own_checklist_templates(uuid)',
    'fn member_status_grants_access(text)',
    'pol public.organizations.admins_can_modify_org',
    'pol public.transaction_submissions.transaction_submissions_update_public',
    'pol public.transaction_submissions.agents_can_create_submissions',
    'pol public.submission_comments.users_can_create_comments',
    'pol public.submission_comments.comment_access_via_submission',
    'pol public.users.users_select_public',
    'pol storage.objects.Members can upload submission attachments',
    'pol public.organization_identity_providers.IT admins can manage identity providers',
    'pol public.organization_identity_providers.Org admins can view identity providers',
    'pol public.scim_tokens.IT admins can manage SCIM tokens',
    'pol public.scim_sync_log.Admins can view SCIM sync logs'];
BEGIN
  SELECT * INTO r FROM pg_proc WHERE oid = to_regprocedure('public.member_status_grants_access(text)');
  PERFORM pg_temp.check('c09 helper exists', r.oid IS NOT NULL);
  PERFORM pg_temp.check('c09 helper is IMMUTABLE, SECURITY INVOKER, search_path empty',
    r.provolatile = 'i' AND NOT r.prosecdef AND r.proconfig = ARRAY['search_path=""'], r.provolatile::text || ' ' || r.prosecdef::text || ' ' || r.proconfig::text);
  PERFORM pg_temp.check('c09 helper EXECUTE: anon, authenticated, service_role; not PUBLIC',
    has_function_privilege('anon', r.oid, 'EXECUTE') AND has_function_privilege('authenticated', r.oid, 'EXECUTE')
    AND has_function_privilege('service_role', r.oid, 'EXECUTE')
    AND NOT EXISTS (SELECT 1 FROM aclexplode(r.proacl) a WHERE a.grantee = 0), r.proacl::text);
  PERFORM pg_temp.check('c09 helper allow-list is exactly {active}',
    public.member_status_grants_access('active') AND NOT public.member_status_grants_access('suspended')
    AND NOT public.member_status_grants_access('expired') AND NOT public.member_status_grants_access('pending')
    AND NOT public.member_status_grants_access('unassigned') AND NOT public.member_status_grants_access(NULL)
    AND public.member_status_grants_access(NULL) IS NOT NULL);

  -- the five helpers: production's flags and grants (read 2026-10-13)
  FOR r IN SELECT * FROM (VALUES
      ('public.is_org_admin(uuid,uuid)', '{search_path=public}', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
      ('public.can_review_submission(uuid)', '{"search_path=\"\""}', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
      ('public.get_user_org_ids(uuid)', '{search_path=public}', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
      ('public.can_edit_checklist_templates(uuid)', '{search_path=public}', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
      ('public.can_create_own_checklist_templates(uuid)', '{search_path=public}', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}')
    ) v(sig, cfg, acl) LOOP
    PERFORM pg_temp.check('c09 '||r.sig||' keeps SECURITY DEFINER, STABLE, search_path, grants',
      (SELECT p.prosecdef AND p.provolatile = 's' AND p.proconfig::text = r.cfg AND p.proacl::text = r.acl
         FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig)),
      (SELECT p.prosecdef::text || ' ' || p.provolatile::text || ' ' || p.proconfig::text || ' ' || p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig)));
    PERFORM pg_temp.check('c09 '||r.sig||' calls the helper',
      pg_get_functiondef(to_regprocedure(r.sig)) LIKE '%public.member_status_grants_access(%');
  END LOOP;

  -- every changed policy calls the helper; roles and command as in production
  FOR r IN SELECT p.*, (SELECT count(*) FROM regexp_matches(coalesce(p.qual,'') || ' ' || coalesce(p.with_check,''), 'member_status_grants_access\(', 'g')) AS calls
             FROM pg_policies p
            WHERE (p.schemaname, p.tablename, p.policyname) IN (
              ('public','organizations','admins_can_modify_org'),('public','transaction_submissions','transaction_submissions_update_public'),
              ('public','transaction_submissions','agents_can_create_submissions'),('public','submission_comments','users_can_create_comments'),
              ('public','submission_comments','comment_access_via_submission'),('public','users','users_select_public'),
              ('storage','objects','Members can upload submission attachments'),
              ('public','organization_identity_providers','IT admins can manage identity providers'),
              ('public','organization_identity_providers','Org admins can view identity providers'),
              ('public','scim_tokens','IT admins can manage SCIM tokens'),('public','scim_sync_log','Admins can view SCIM sync logs')) LOOP
    PERFORM pg_temp.check('c09 policy '||r.tablename||'.'||r.policyname||' calls the helper '||
        CASE WHEN r.policyname IN ('transaction_submissions_update_public','comment_access_via_submission') THEN 'twice' ELSE 'once' END,
      r.calls = CASE WHEN r.policyname IN ('transaction_submissions_update_public','comment_access_via_submission') THEN 2 ELSE 1 END, r.calls::text);
  END LOOP;
  SELECT count(*) INTO n FROM pg_policies p
   WHERE (p.policyname, p.cmd, p.roles::text) IN (
     ('admins_can_modify_org','UPDATE','{public}'),('transaction_submissions_update_public','UPDATE','{public}'),
     ('agents_can_create_submissions','INSERT','{public}'),('users_can_create_comments','INSERT','{public}'),
     ('comment_access_via_submission','SELECT','{public}'),('users_select_public','SELECT','{public}'),
     ('Members can upload submission attachments','INSERT','{public}'),
     ('IT admins can manage identity providers','ALL','{authenticated}'),('Org admins can view identity providers','SELECT','{authenticated}'),
     ('IT admins can manage SCIM tokens','ALL','{authenticated}'),('Admins can view SCIM sync logs','SELECT','{authenticated}'));
  PERFORM pg_temp.check('c09 the 11 changed policies keep command and roles', n = 11, n::text);

  -- every other pinned object is production's
  SELECT string_agg(coalesce(f.k, p.k), '; ') INTO bad
    FROM pg_temp.fp3917() f FULL JOIN t3917_prod p ON p.k = f.k
   WHERE f.v IS DISTINCT FROM p.v AND coalesce(f.k, p.k) <> ALL (changed);
  PERFORM pg_temp.check('c09 every unchanged pinned object equals production (incl. organizations_select_public)', bad IS NULL, bad);
  SELECT string_agg(c.ck, '; ') INTO bad FROM unnest(changed) AS c(ck)
   WHERE c.ck <> 'fn member_status_grants_access(text)'
     AND (SELECT f.v FROM pg_temp.fp3917() f WHERE f.k = c.ck) IS NOT DISTINCT FROM (SELECT p.v FROM t3917_prod p WHERE p.k = c.ck);
  PERFORM pg_temp.check('c09 every changed object differs from production', bad IS NULL, bad);
END $$;
