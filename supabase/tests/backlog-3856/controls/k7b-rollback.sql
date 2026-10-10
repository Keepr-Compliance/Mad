-- harness: rollback
-- k7b: rollback-3856.sql restores the pre-3856 fingerprint and behaviour.
SELECT pg_temp.check('k7b fingerprint restored', pg_temp.fp() = 'f5f432e32c93707a74002363b99bd18c', pg_temp.fp());
SELECT pg_temp.check('k7b pre-3856 behaviour back (suspended user -> active)',
  pg_temp.as_role('authenticated', pg_temp.id('u_susp'),
    'SELECT (public.create_active_individual_license(''{u_susp}''::uuid)).status') = 'OK active');
SELECT pg_temp.check('k7b exact ACL',
  (SELECT proacl::text FROM pg_proc WHERE oid = 'public.create_active_individual_license(uuid)'::regprocedure)
    = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}');
