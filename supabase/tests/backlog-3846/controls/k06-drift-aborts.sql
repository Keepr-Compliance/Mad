-- harness: expect-raise
-- harness: pre-apply: CREATE OR REPLACE FUNCTION public.log_admin_action(p_action text, p_target_type text, p_target_id text, p_metadata jsonb DEFAULT NULL, p_ip_address inet DEFAULT NULL, p_user_agent text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $d$ BEGIN NULL; END $d$;
-- K6: a log_admin_action body other than production's stops the migration before anything changes.
SELECT pg_temp.check('migration refused on drift', NOT pg_temp.step_ok('apply1') AND pg_temp.step_err('apply1') LIKE '%log_admin_action body changed%', pg_temp.step_err('apply1'));
SELECT pg_temp.check('nothing applied', to_regprocedure('public._billing_on_licence_unsuspend()') IS NULL
  AND (SELECT is_nullable = 'NO' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'admin_audit_logs' AND column_name = 'actor_id'));
