-- D06 (SR R2): grants, policy roles and function flags after the fix.
-- The 3938 file changes bodies only and the 3940 file changes one table's policies,
-- so: the three functions keep production's ACL (PUBLIC included), the two
-- organization_members policies still apply TO public, the links policy is
-- TO authenticated FOR ALL, and SECURITY DEFINER / search_path / STABLE are kept.
DO $$ DECLARE r record;
  prod_acl constant text := '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
BEGIN
  FOR r IN SELECT p.oid::regprocedure::text sig, p.proacl::text acl, p.prosecdef, p.proconfig::text cfg, p.provolatile
             FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('get_user_org_ids','is_org_admin','broker_get_org_features') ORDER BY 1 LOOP
    PERFORM pg_temp.check('d06 ' || r.sig || ' ACL equals production', r.acl = prod_acl, r.acl);
    PERFORM pg_temp.check('d06 ' || r.sig || ' SECURITY DEFINER, search_path=public, STABLE',
      r.prosecdef AND r.cfg = '{search_path=public}' AND r.provolatile = 's', r::text);
  END LOOP;
  PERFORM pg_temp.check('d06 three functions present',
    (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('get_user_org_ids','is_org_admin','broker_get_org_features')) = 3, NULL);
  FOR r IN SELECT n, (SELECT roles::text FROM pg_policies WHERE tablename = 'organization_members' AND policyname = n) roles
             FROM unnest(ARRAY['organization_members_all_public','organization_members_select_public']) n LOOP
    PERFORM pg_temp.check('d06 ' || r.n || ' still TO public', r.roles = '{public}', coalesce(r.roles, '<missing>'));
  END LOOP;
  PERFORM pg_temp.check('d06 links policy TO authenticated FOR ALL',
    EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'support_ticket_backlog_links'
             AND policyname = 'support_ticket_backlog_links_internal_all' AND roles = '{authenticated}' AND cmd = 'ALL'),
    (SELECT string_agg(policyname || ' ' || cmd || ' ' || roles::text, '; ') FROM pg_policies WHERE tablename = 'support_ticket_backlog_links'));
END $$;
