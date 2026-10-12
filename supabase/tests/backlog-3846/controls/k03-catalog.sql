-- K3 (BACKLOG-3136): grants and nullability.
SELECT pg_temp.check('anon has no EXECUTE on log_admin_action', NOT has_function_privilege('anon', 'public.log_admin_action(text,text,text,jsonb,inet,text)', 'EXECUTE'));
SELECT pg_temp.check('PUBLIC has no EXECUTE on log_admin_action',
  NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = 'public.log_admin_action(text,text,text,jsonb,inet,text)'::regprocedure AND a.grantee = 0));
SELECT pg_temp.check('authenticated and service_role keep EXECUTE',
  has_function_privilege('authenticated', 'public.log_admin_action(text,text,text,jsonb,inet,text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.log_admin_action(text,text,text,jsonb,inet,text)', 'EXECUTE'));
SELECT pg_temp.check('admin_audit_logs.actor_id nullable, FK kept',
  (SELECT is_nullable = 'YES' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'admin_audit_logs' AND column_name = 'actor_id')
  AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_audit_logs_actor_id_fkey'));
