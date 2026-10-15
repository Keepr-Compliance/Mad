-- claim_pending_invite(): anon can no longer execute it; authenticated still can
-- (k07 of backlog-3679 runs it as authenticated and expects success).
DO $$ DECLARE m text; BEGIN
  m := pg_temp.as_role('anon', NULL, NULL, $q$select public.claim_pending_invite()$q$);
  PERFORM pg_temp.check('k12 anon executing claim_pending_invite() is refused',
    m LIKE 'ERR 42501 permission denied for function claim_pending_invite%', m);
  PERFORM pg_temp.check('k12 anon has no EXECUTE (incl. through PUBLIC)',
    NOT has_function_privilege('anon', 'public.claim_pending_invite()', 'EXECUTE'));
  PERFORM pg_temp.check('k12 authenticated keeps EXECUTE',
    has_function_privilege('authenticated', 'public.claim_pending_invite()', 'EXECUTE'));
  PERFORM pg_temp.check('k12 service_role keeps EXECUTE',
    has_function_privilege('service_role', 'public.claim_pending_invite()', 'EXECUTE'));
  PERFORM pg_temp.check('k12 ACL is postgres, authenticated, service_role only',
    pg_temp.acl('public.claim_pending_invite()'::regprocedure) = 'authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres',
    pg_temp.acl('public.claim_pending_invite()'::regprocedure));
END $$;
