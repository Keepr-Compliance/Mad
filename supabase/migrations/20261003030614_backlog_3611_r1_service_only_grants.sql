-- BACKLOG-3611 batch R1: server-only functions.
--
-- Removes EXECUTE from PUBLIC, anon and authenticated on eight SECURITY DEFINER
-- functions that no client calls, and keeps service_role's explicit grant.
-- Grants only: no function body changes.
--
-- Every signature is named in full. Both PUBLIC and anon are listed: revoking
-- one does not remove EXECUTE held through the other.

REVOKE EXECUTE ON FUNCTION
  public.get_active_connections(),
  public.get_db_size(),
  public.get_database_size(),
  public.increment_scim_token_usage(uuid),
  public.cleanup_expired_impersonation_sessions(),
  public.get_device_limit(uuid),
  public.is_trial_expired(uuid),
  public.increment_transaction_count(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.get_active_connections(),
  public.get_db_size(),
  public.get_database_size(),
  public.increment_scim_token_usage(uuid),
  public.cleanup_expired_impersonation_sessions(),
  public.get_device_limit(uuid),
  public.is_trial_expired(uuid),
  public.increment_transaction_count(uuid)
TO service_role;
