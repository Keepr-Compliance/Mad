-- harness: apply-twice
-- k7a: applying the migration twice raises nothing; behaviour and ACL hold.
SELECT pg_temp.check('k7a after second apply: suspended user -> suspended',
  pg_temp.as_role('authenticated', pg_temp.id('u_susp'),
    'SELECT (public.create_active_individual_license(''{u_susp}''::uuid)).status') = 'OK suspended');
SELECT pg_temp.check('k7a exact ACL',
  (SELECT proacl::text FROM pg_proc WHERE oid = 'public.create_active_individual_license(uuid)'::regprocedure)
    = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}');
