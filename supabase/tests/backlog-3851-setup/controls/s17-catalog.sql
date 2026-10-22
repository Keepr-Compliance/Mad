-- S17: signature, definer, search_path, ACL and body after the migration.
SELECT pg_temp.check('S17 one overload', (SELECT count(*) FROM pg_proc WHERE proname = 'auto_provision_it_admin' AND pronamespace = 'public'::regnamespace) = 1, NULL);
SELECT pg_temp.check('S17 signature and return type',
  (SELECT p.oid::regprocedure::text || ' -> ' || format_type(p.prorettype, NULL) FROM pg_proc p WHERE p.proname = 'auto_provision_it_admin' AND p.pronamespace = 'public'::regnamespace)
  = 'auto_provision_it_admin(text,text,text) -> jsonb', NULL);
SELECT pg_temp.check('S17 definer, search_path=public, plpgsql',
  (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=public'] AND l.lanname = 'plpgsql'
     FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'public.auto_provision_it_admin(text,text,text)'::regprocedure), NULL);
SELECT pg_temp.check('S17 ACL = production''s',
  (SELECT proacl::text FROM pg_proc WHERE oid = 'public.auto_provision_it_admin(text,text,text)'::regprocedure)
  = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}',
  (SELECT proacl::text FROM pg_proc WHERE oid = 'public.auto_provision_it_admin(text,text,text)'::regprocedure));
SELECT pg_temp.check('S17 body md5 = the migration''s',
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.auto_provision_it_admin(text,text,text)'::regprocedure) = '0ca68b8cee9820322274e1f1a4817b0a',
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.auto_provision_it_admin(text,text,text)'::regprocedure));
SELECT pg_temp.check('S17 body inserts no organization',
  (SELECT prosrc NOT ILIKE '%INSERT INTO organizations%' FROM pg_proc WHERE oid = 'public.auto_provision_it_admin(text,text,text)'::regprocedure), NULL);
SELECT pg_temp.check('S17 anon cannot execute', NOT has_function_privilege('anon', 'public.auto_provision_it_admin(text,text,text)', 'EXECUTE'), NULL);
