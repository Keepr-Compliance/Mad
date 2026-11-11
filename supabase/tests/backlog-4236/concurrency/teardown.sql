-- Removes exactly the rows of one run (ids filled by run-concurrency.sh). Rows in any public mcp_*
-- table with a user_id column are deleted for this user first (present when BACKLOG-4238 is applied).
DO $td$
DECLARE t text;
BEGIN
  FOR t IN SELECT c.table_name FROM information_schema.columns c
            WHERE c.table_schema = 'public' AND c.table_name LIKE 'mcp\_%' AND c.column_name = 'user_id' LOOP
    EXECUTE format('DELETE FROM public.%I WHERE user_id = $1', t) USING '__A__'::uuid;
  END LOOP;
  DELETE FROM public.cloud_deals WHERE owner_user_id = '__A__'::uuid;
  DELETE FROM public.cloud_blobs WHERE owner_user_id = '__A__'::uuid;
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
