-- C10: anon cannot execute admin_update_license (permission denied, 42501,
-- raised before the function body runs); authenticated and service_role keep
-- EXECUTE (an authenticated internal-role caller is exercised in c5).
SELECT pg_temp.want('c10 anon -> 42501',
  pg_temp.run_as('anon', NULL,
    'SELECT public.admin_update_license(''{l_ind}'', ''{"status":"suspended"}''::jsonb)'),
  '~^ERR 42501 ');
SELECT pg_temp.want('c10 authenticated holds EXECUTE',
  has_function_privilege('authenticated', 'public.admin_update_license(uuid,jsonb)', 'EXECUTE')::text, 'true');
SELECT pg_temp.want('c10 service_role holds EXECUTE',
  has_function_privilege('service_role', 'public.admin_update_license(uuid,jsonb)', 'EXECUTE')::text, 'true');
SELECT pg_temp.want('c10 PUBLIC has no EXECUTE (anon inherits nothing)',
  (SELECT count(*)::text FROM pg_proc p, aclexplode(p.proacl) a
    WHERE p.oid = 'public.admin_update_license(uuid,jsonb)'::regprocedure AND a.grantee = 0), '0');
