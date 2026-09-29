-- BACKLOG-3553: restrict EXECUTE on public.get_storage_usage() to service_role.
--
-- WHAT THIS DOES
--   * Revokes EXECUTE from PUBLIC, anon and authenticated.
--   * Grants EXECUTE to service_role.
--   * Function body, owner, SECURITY DEFINER and search_path are unchanged.

REVOKE EXECUTE ON FUNCTION public.get_storage_usage() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_storage_usage() TO service_role;
