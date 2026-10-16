-- BACKLOG-3973: public.users.last_login_at follows auth.users.last_sign_in_at.
--
-- The portals' "Last login" readers (admin_search_users, the admin user page, the
-- broker users list and user page) all read public.users.last_login_at. Nothing on
-- the sign-in path real users take writes that column; auth.users.last_sign_in_at
-- is set by Supabase Auth on every sign-in. This migration:
--
-- 1. adds a trigger function that copies auth.users.last_sign_in_at into
--    public.users.last_login_at for the same id, only when it moves the value
--    forward. It never raises: a failure inside a trigger on auth.users would fail
--    the sign-in itself, so any error becomes a WARNING and the sign-in proceeds;
-- 2. fires it AFTER INSERT and AFTER UPDATE OF last_sign_in_at on auth.users. The
--    trigger name sorts after on_auth_user_created, so on INSERT the public.users
--    row that trigger creates already exists;
-- 3. backfills public.users.last_login_at from auth.users.last_sign_in_at where the
--    auth value is later (or the column is empty).
--
-- No reader changes. public.users.updated_at moves on each sign-in
-- (update_users_updated_at trigger).
--
-- Apply as one transaction. No BEGIN/COMMIT here.
-- Rollback:
--   DROP TRIGGER IF EXISTS on_auth_user_signed_in ON auth.users;
--   DROP FUNCTION IF EXISTS public.sync_last_login_from_auth();
--   (the backfilled values are left in place; they were NULL before.)

CREATE OR REPLACE FUNCTION public.sync_last_login_from_auth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.last_sign_in_at IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.last_sign_in_at IS NOT DISTINCT FROM OLD.last_sign_in_at THEN
    RETURN NULL;
  END IF;

  BEGIN
    UPDATE public.users
       SET last_login_at = NEW.last_sign_in_at
     WHERE id = NEW.id
       AND (last_login_at IS NULL OR last_login_at < NEW.last_sign_in_at);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'sync_last_login_from_auth: % %', SQLSTATE, SQLERRM;
  END;

  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sync_last_login_from_auth() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_signed_in ON auth.users;
CREATE TRIGGER on_auth_user_signed_in
  AFTER INSERT OR UPDATE OF last_sign_in_at ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_last_login_from_auth();

UPDATE public.users u
   SET last_login_at = a.last_sign_in_at
  FROM auth.users a
 WHERE a.id = u.id
   AND a.last_sign_in_at IS NOT NULL
   AND (u.last_login_at IS NULL OR u.last_login_at < a.last_sign_in_at);
