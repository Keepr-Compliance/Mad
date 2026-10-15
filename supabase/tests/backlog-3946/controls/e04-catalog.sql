-- E04: catalogue after the full change.
DO $$ DECLARE n int; s text; BEGIN
  SELECT count(*), string_agg(tablename||'.'||policyname, ', ') INTO n, s FROM pg_policies
   WHERE roles && ARRAY['public','anon']::name[]
     AND (coalesce(qual,'')||coalesce(with_check,'')) ~ '(has_internal_role|has_permission|get_user_org_ids|is_org_admin|is_super_admin|get_user_permissions|has_any_permission)';
  PERFORM pg_temp.check('e04 no TO public/anon policy calls an identity helper', n = 0, n || ' ' || coalesce(s,''));
  SELECT count(*), string_agg(p.proname, ',') INTO n, s FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
     AND p.proname IN ('has_internal_role','has_permission','get_user_org_ids','is_org_admin','is_super_admin','get_user_permissions','has_any_permission')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  PERFORM pg_temp.check('e04 anon (incl. PUBLIC) cannot execute any of the 7 helpers', n = 0, n || ' ' || coalesce(s,''));
  SELECT count(*) INTO n FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
     AND p.proname IN ('has_internal_role','has_permission','get_user_org_ids','is_org_admin','is_super_admin','get_user_permissions','has_any_permission')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND has_function_privilege('service_role', p.oid, 'EXECUTE')
     AND p.prosecdef AND p.provolatile = 's' AND p.proconfig = ARRAY['search_path=public'];
  PERFORM pg_temp.check('e04 7 helpers: authenticated+service_role EXECUTE, DEFINER, STABLE, search_path kept', n = 7, n::text);
  -- one row per helper, so a single helper losing a flag reds its own check as well as the aggregate
  FOR s IN SELECT p.proname || '|' || (p.prosecdef AND p.provolatile = 's' AND p.proconfig = ARRAY['search_path=public'])::text
             FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
              AND p.proname IN ('has_internal_role','has_permission','get_user_org_ids','is_org_admin','is_super_admin','get_user_permissions','has_any_permission')
            ORDER BY p.proname LOOP
    PERFORM pg_temp.check('e04 ' || split_part(s, '|', 1) || ' keeps DEFINER, STABLE, search_path=public', split_part(s, '|', 2) = 'true', s);
  END LOOP;
  SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) INTO s FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='support_ticket_backlog_links' AND grantee='anon';
  PERFORM pg_temp.check('e04 anon holds no privilege on support_ticket_backlog_links', s IS NULL, coalesce(s,'<none>'));
  SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) INTO s FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='support_ticket_backlog_links' AND grantee='authenticated';
  PERFORM pg_temp.check('e04 authenticated holds exactly DELETE,INSERT,SELECT on links', s = 'DELETE,INSERT,SELECT', coalesce(s,'<none>'));
END $$;
