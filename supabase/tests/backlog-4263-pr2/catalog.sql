-- BACKLOG-4263: the catalogue facts of every function this migration creates or replaces, read after the
-- migration in a rolled-back call. gen_apply.py embeds them in the apply post-check.
SELECT jsonb_object_agg(p.oid::regprocedure::text, jsonb_build_object('md5', md5(p.prosrc), 'secdef', p.prosecdef,
         'vol', p.provolatile::text, 'own', pg_get_userbyid(p.proowner), 'cfg', array_to_string(p.proconfig, ','),
         'anon', has_function_privilege('anon', p.oid, 'EXECUTE'), 'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
         'service_role', has_function_privilege('service_role', p.oid, 'EXECUTE'),
         'public', coalesce(p.proacl::text ~ '(^|[{,])=X', p.proacl IS NULL)))
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.oid::regprocedure::text = ANY (__SIGS__)
