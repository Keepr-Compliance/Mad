-- S4a (SR R1, RC7): who may execute the two functions, and how they run.
SELECT pg_temp.check('invoke: not executable by ' || r,
  NOT has_function_privilege(r, 'public.billing_drain_invoke(text)', 'EXECUTE'))
  FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r;
SELECT pg_temp.check('invoke: no PUBLIC grant',
  NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
               WHERE p.oid = 'public.billing_drain_invoke(text)'::regprocedure AND a.grantee = 0),
  (SELECT coalesce(proacl::text, '<default acl>') FROM pg_proc WHERE oid = 'public.billing_drain_invoke(text)'::regprocedure));
SELECT pg_temp.check('secret: not executable by ' || r,
  NOT has_function_privilege(r, 'public.billing_drain_secret()', 'EXECUTE'))
  FROM unnest(ARRAY['anon', 'authenticated']) r;
SELECT pg_temp.check('secret: executable by service_role',
  has_function_privilege('service_role', 'public.billing_drain_secret()', 'EXECUTE'));
SELECT pg_temp.check('secret: no PUBLIC grant',
  NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
               WHERE p.oid = 'public.billing_drain_secret()'::regprocedure AND a.grantee = 0));
SELECT pg_temp.check('secret: SECURITY DEFINER', prosecdef) FROM pg_proc WHERE oid = 'public.billing_drain_secret()'::regprocedure;
SELECT pg_temp.check('invoke: SECURITY INVOKER (runs as the cron job owner)', NOT prosecdef)
  FROM pg_proc WHERE oid = 'public.billing_drain_invoke(text)'::regprocedure;
SELECT pg_temp.check(p.proname || ': search_path is empty',
  p.proconfig @> ARRAY['search_path=""'], array_to_string(p.proconfig, ','))
  FROM pg_proc p WHERE p.oid IN ('public.billing_drain_secret()'::regprocedure, 'public.billing_drain_invoke(text)'::regprocedure);
SELECT pg_temp.check('exactly two billing_drain functions',
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'billing_drain%') = 2);
