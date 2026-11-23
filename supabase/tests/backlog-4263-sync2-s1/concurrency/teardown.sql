-- Removes exactly the rows of one run (ids filled by run.sh). Moves and move notices cascade with the auth user.
DO $s1td$
BEGIN
  DELETE FROM public.cloud_deals WHERE owner_user_id = '__A__'::uuid;
  DELETE FROM public.cloud_blobs WHERE owner_user_id = '__A__'::uuid;
  DELETE FROM public.cloud_removed_installs WHERE owner_user_id = '__A__'::uuid;
  DELETE FROM public.cloud_todo_feed_head WHERE owner_user_id = '__A__'::uuid;
  DELETE FROM public.cloud_autosave_settings WHERE user_id = '__A__'::uuid;
  DELETE FROM public.member_addons WHERE user_id = '__A__'::uuid;
  SET LOCAL session_replication_role = replica;
  DELETE FROM public.organization_members WHERE id = '__M__'::uuid AND user_id = '__A__'::uuid;
  DELETE FROM public.organization_plans WHERE organization_id = '__O__'::uuid;
  DELETE FROM public.organizations WHERE id = '__O__'::uuid AND slug = 'p4263s1cc-__RUN__';
  DELETE FROM public.users WHERE id = '__A__'::uuid AND email = 'p4263s1cc-__RUN__@example.test';
  SET LOCAL session_replication_role = origin;
  DELETE FROM auth.users WHERE id = '__A__'::uuid AND email = 'p4263s1cc-__RUN__@example.test';
END
$s1td$;
