-- Alternative on top of fix-3938: also remove anon EXECUTE and move the two TO public policies to authenticated.
REVOKE EXECUTE ON FUNCTION public.get_user_org_ids(uuid), public.is_org_admin(uuid, uuid) FROM PUBLIC, anon;
ALTER POLICY organization_members_all_public ON public.organization_members TO authenticated;
ALTER POLICY organization_members_select_public ON public.organization_members TO authenticated;
