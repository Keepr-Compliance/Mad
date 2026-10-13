-- Rollback of 20261012152626_backlog_3846_unsuspend_regrant_and_audit_actor.sql.
-- Restores the pre-3846 trigger set on licenses and the production
-- log_admin_action (body and EXECUTE grants as read on 2026-10-12).
-- Refuses while a NULL-actor audit row exists: NOT NULL cannot come back
-- without deleting audit history, and that is not a rollback's call.

DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM public.admin_audit_logs WHERE actor_id IS NULL) THEN
    RAISE EXCEPTION 'rollback-3846: admin_audit_logs has rows with no actor (service-role actions); keep actor_id nullable';
  END IF;
END
$pre$;

DROP TRIGGER IF EXISTS billing_regrant_on_unsuspend ON public.licenses;
DROP FUNCTION IF EXISTS public._billing_on_licence_unsuspend();

CREATE OR REPLACE FUNCTION public.log_admin_action(p_action text, p_target_type text, p_target_id text, p_metadata jsonb DEFAULT NULL::jsonb, p_ip_address inet DEFAULT NULL::inet, p_user_agent text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.admin_audit_logs (
    actor_id, action, target_type, target_id, metadata, ip_address, user_agent
  )
  VALUES (
    auth.uid(), p_action, p_target_type, p_target_id, p_metadata, p_ip_address, p_user_agent
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.log_admin_action(text, text, text, jsonb, inet, text) TO PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.admin_audit_logs ALTER COLUMN actor_id SET NOT NULL;
