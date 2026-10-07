-- Migration: Cleanup Expired Impersonation Sessions
-- BACKLOG-911: No DB cleanup job for expired sessions
-- Purpose: Create a function that marks stale active/validated sessions as expired.
--
-- This function should be called periodically (e.g., via pg_cron every 5 minutes,
-- or from a Supabase edge function on a schedule). Setting up the scheduler
-- is out of scope for this migration -- only the function is created here.
--
-- Example pg_cron setup (apply separately when pg_cron is available):
--   SELECT cron.schedule(
--     'cleanup-expired-impersonation-sessions',
--     '*/5 * * * *',
--     $$ SELECT public.cleanup_expired_impersonation_sessions(); $$
--   );

CREATE OR REPLACE FUNCTION public.cleanup_expired_impersonation_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  cleaned_count integer;
BEGIN
  UPDATE impersonation_sessions
  SET status = 'expired', ended_at = now()
  WHERE status IN ('active', 'validated')
    AND session_expires_at < now();
  GET DIAGNOSTICS cleaned_count = ROW_COUNT;
  RETURN cleaned_count;
END;
$$;

-- Grant to service_role only (not authenticated) since this is a maintenance function.
-- It will be called by pg_cron or an edge function, not by end users.
REVOKE ALL ON FUNCTION public.cleanup_expired_impersonation_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_impersonation_sessions() TO service_role;
