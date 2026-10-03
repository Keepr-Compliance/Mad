-- BACKLOG-3673: users.onboarding_completed_at becomes the one per-account
-- "setup finished" record. Write-once guard + one-time backfill.
--
-- Version 20261003160000 claimed in the tracker before this file was written.
-- Apply as ONE transaction (`psql -1 -f <file>`, or the whole file in one SQL
-- editor run). It opens none of its own. Every statement is safe to run twice.
--
--   1. public.users_keep_onboarding_completed(): BEFORE UPDATE trigger function.
--      Once onboarding_completed_at holds a value, an UPDATE cannot clear it or
--      move it; the old value is kept. Acts only on the row being updated.
--      SECURITY INVOKER, empty search_path, references only OLD/NEW.
--      EXECUTE is revoked from public, anon and authenticated, and the body
--      refuses to run outside a trigger.
--
--   2. Trigger users_keep_onboarding_completed on public.users
--      (BEFORE UPDATE OF onboarding_completed_at, FOR EACH ROW).
--      Dropped first if it exists.
--
--   3. Backfill, evaluated when this runs:
--        email_onboarding_completed_at IS NOT NULL
--        AND onboarding_completed_at IS NULL
--      -> onboarding_completed_at := email_onboarding_completed_at.
--
-- Unchanged: every RLS policy and grant on public.users. The app's own write
-- (only where the value is still empty) runs under the existing owner UPDATE
-- policy.

CREATE OR REPLACE FUNCTION public.users_keep_onboarding_completed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF pg_catalog.pg_trigger_depth() < 1 THEN
    RAISE EXCEPTION 'users_keep_onboarding_completed() runs only as a trigger';
  END IF;

  -- Write-once: a set value can never be cleared or moved.
  IF OLD.onboarding_completed_at IS NOT NULL THEN
    NEW.onboarding_completed_at := OLD.onboarding_completed_at;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.users_keep_onboarding_completed() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.users_keep_onboarding_completed() FROM anon;
REVOKE ALL ON FUNCTION public.users_keep_onboarding_completed() FROM authenticated;

DROP TRIGGER IF EXISTS users_keep_onboarding_completed ON public.users;

CREATE TRIGGER users_keep_onboarding_completed
  BEFORE UPDATE OF onboarding_completed_at ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.users_keep_onboarding_completed();

UPDATE public.users
   SET onboarding_completed_at = email_onboarding_completed_at
 WHERE email_onboarding_completed_at IS NOT NULL
   AND onboarding_completed_at IS NULL;
