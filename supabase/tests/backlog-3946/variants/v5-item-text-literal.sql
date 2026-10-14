-- v5: the item's scope read literally: revoke PUBLIC/anon on the four named helpers and move
-- only the two organization_members policies TO authenticated.
REVOKE EXECUTE ON FUNCTION public.has_internal_role(uuid), public.has_permission(uuid, text),
  public.get_user_org_ids(uuid), public.is_org_admin(uuid, uuid) FROM PUBLIC, anon;
ALTER POLICY organization_members_all_public ON public.organization_members TO authenticated;
ALTER POLICY organization_members_select_public ON public.organization_members TO authenticated;
