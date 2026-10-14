-- D05: catalogue shape. Helper grants/flags unchanged; links has one internal-only policy.
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT p.oid::regprocedure::text sig, p.prosecdef, p.proconfig::text cfg, p.provolatile,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') au, has_function_privilege('service_role', p.oid, 'EXECUTE') sr
             FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('get_user_org_ids','is_org_admin','broker_get_org_features') LOOP
    PERFORM pg_temp.check('d05 ' || r.sig || ' definer+search_path+stable+grants kept',
      r.prosecdef AND r.cfg = '{search_path=public}' AND r.provolatile = 's' AND r.au AND r.sr, r::text);
  END LOOP;
  PERFORM pg_temp.check('d05 links: exactly one policy',
    (SELECT count(*) FROM pg_policies WHERE tablename = 'support_ticket_backlog_links') = 1,
    (SELECT string_agg(policyname, ',') FROM pg_policies WHERE tablename = 'support_ticket_backlog_links'));
  PERFORM pg_temp.check('d05 links policy: ALL, authenticated, has_internal_role in USING and WITH CHECK',
    EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'support_ticket_backlog_links' AND cmd = 'ALL'
             AND roles = '{authenticated}' AND qual ~ 'has_internal_role' AND with_check ~ 'has_internal_role'
             AND qual !~ 'organization_members' AND with_check !~ 'organization_members'),
    (SELECT string_agg(cmd || ' ' || roles::text || ' ' || coalesce(qual,'') || ' / ' || coalesce(with_check,''), '; ') FROM pg_policies WHERE tablename = 'support_ticket_backlog_links'));
END $$;
