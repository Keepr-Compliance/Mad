-- BACKLOG-3986 rollback: restore the 20261014002359 (BACKLOG-3917) expression of
-- public.scim_tokens "IT admins can manage SCIM tokens" (it_admin only).
-- Expected qual md5 after rollback: 650dd386970cc49956848392f8c5889f (pg_policies.qual).
-- scim_sync_log was not changed by 20261116120000 and is not touched here.
-- Apply as one transaction.

ALTER POLICY "IT admins can manage SCIM tokens" ON public.scim_tokens
  USING (EXISTS (
    SELECT 1
      FROM public.organization_members token_manager
     WHERE token_manager.organization_id = scim_tokens.organization_id
       AND token_manager.user_id = (SELECT auth.uid())
       AND token_manager.role = 'it_admin'
       AND public.member_status_grants_access(token_manager.license_status)));

DO $chk$
BEGIN
  IF (SELECT md5(qual) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'scim_tokens'
        AND policyname = 'IT admins can manage SCIM tokens') <> '650dd386970cc49956848392f8c5889f' THEN
    RAISE EXCEPTION 'BACKLOG-3986 rollback: scim_tokens policy is not at the 20261014002359 expression';
  END IF;
END
$chk$;
