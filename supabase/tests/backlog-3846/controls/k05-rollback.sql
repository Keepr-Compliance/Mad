-- harness: rollback
-- K5: the rollback restores production's log_admin_action, grants and NOT NULL, and removes the trigger.
SELECT pg_temp.check('rollback succeeds', pg_temp.step_ok('rollback'), pg_temp.step_err('rollback'));
SELECT pg_temp.check('log_admin_action body = production',
  (SELECT md5(prosrc) = 'df1ef32e483bab95212c7525be8c5fb2' FROM pg_proc WHERE oid = 'public.log_admin_action(text,text,text,jsonb,inet,text)'::regprocedure));
SELECT pg_temp.check('anon EXECUTE restored', has_function_privilege('anon', 'public.log_admin_action(text,text,text,jsonb,inet,text)', 'EXECUTE'));
SELECT pg_temp.check('actor_id NOT NULL again',
  (SELECT is_nullable = 'NO' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'admin_audit_logs' AND column_name = 'actor_id'));
SELECT pg_temp.check('trigger and function gone',
  NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'billing_regrant_on_unsuspend')
  AND to_regprocedure('public._billing_on_licence_unsuspend()') IS NULL);
