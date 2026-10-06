-- BACKLOG-3653 (BACKLOG-3611 batch R2): permission lookup functions.
--
-- Removes EXECUTE from PUBLIC and anon on the two permission lookup
-- functions. authenticated keeps EXECUTE (signed-in callers and an RLS
-- policy scoped TO authenticated use them); service_role keeps its grant.
-- Grants only: no function body changes.
--
-- Every signature is named in full. Both PUBLIC and anon are listed: revoking
-- one does not remove EXECUTE held through the other.

REVOKE EXECUTE ON FUNCTION
  public.has_permission(uuid, text),
  public.has_any_permission(uuid, text[])
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.has_permission(uuid, text),
  public.has_any_permission(uuid, text[])
TO authenticated, service_role;
