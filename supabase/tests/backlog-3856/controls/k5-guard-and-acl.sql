-- k5: identity guard and EXECUTE grants unchanged.
SELECT pg_temp.check('k5 other user''s id as authenticated -> 42501',
  pg_temp.as_role('authenticated', pg_temp.id('u_active'),
    'SELECT (public.create_active_individual_license(''{u_susp}''::uuid)).status') LIKE 'ERR 42501 %',
  pg_temp.lic('u_susp')::text);
SELECT pg_temp.check('k5 no row created by the refused call', pg_temp.lic('u_susp') IS NULL);
SELECT pg_temp.check('k5 anon -> 42501',
  pg_temp.as_role('anon', NULL,
    'SELECT (public.create_active_individual_license(''{u_susp}''::uuid)).status') LIKE 'ERR 42501 %');
SELECT pg_temp.check('k5 exact ACL',
  (SELECT proacl::text FROM pg_proc WHERE oid = 'public.create_active_individual_license(uuid)'::regprocedure)
    = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}',
  (SELECT proacl::text FROM pg_proc WHERE oid = 'public.create_active_individual_license(uuid)'::regprocedure));
SELECT pg_temp.check('k5 still SECURITY DEFINER, search_path public, returns licenses',
  (SELECT prosecdef AND proconfig = ARRAY['search_path=public'] AND prorettype = 'public.licenses'::regtype
     FROM pg_proc WHERE oid = 'public.create_active_individual_license(uuid)'::regprocedure));
