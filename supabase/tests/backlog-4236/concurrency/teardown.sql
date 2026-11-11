-- Removes exactly the rows of one run (ids filled by run-concurrency.sh). Cloud rows, settings,
-- memberships and the assignment go with the user (ON DELETE CASCADE); the organization and its
-- plan row are removed by id.
DO $td$
BEGIN
  DELETE FROM public.cloud_blobs WHERE owner_user_id = '__A__'::uuid;
  DELETE FROM public.cloud_deals WHERE owner_user_id = '__A__'::uuid;
  DELETE FROM public.cloud_autosave_settings WHERE user_id = '__A__'::uuid;
  DELETE FROM public.member_addons WHERE user_id = '__A__'::uuid;
  SET LOCAL session_replication_role = replica;
  DELETE FROM public.organization_members WHERE id = '__M__'::uuid AND user_id = '__A__'::uuid;
  DELETE FROM public.organization_plans WHERE organization_id = '__O__'::uuid;
  DELETE FROM public.organizations WHERE id = '__O__'::uuid AND slug = 'p4236cc-__RUN__';
  DELETE FROM public.users WHERE id = '__A__'::uuid AND email = 'p4236cc-__RUN__@example.test';
  DELETE FROM auth.users WHERE id = '__A__'::uuid AND email = 'p4236cc-__RUN__@example.test';
END
$td$;
