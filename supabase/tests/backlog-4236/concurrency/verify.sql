-- 'clean' only when no row of the run is left anywhere, including any public mcp_* table with a user_id column.
CREATE OR REPLACE FUNCTION pg_temp.mcp_rows(u uuid) RETURNS bigint LANGUAGE plpgsql AS $v$
DECLARE t text; n bigint := 0; k bigint;
BEGIN
  FOR t IN SELECT c.table_name FROM information_schema.columns c
            WHERE c.table_schema = 'public' AND c.table_name LIKE 'mcp\_%' AND c.column_name = 'user_id' LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE user_id = $1', t) INTO k USING u;
    n := n + k;
  END LOOP;
  RETURN n;
END $v$;
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM auth.users WHERE id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.users WHERE id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = '__O__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.organization_members WHERE id = '__M__'::uuid OR user_id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.member_addons WHERE user_id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.cloud_autosave_settings WHERE user_id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.cloud_deals WHERE owner_user_id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.cloud_blobs WHERE owner_user_id = '__A__'::uuid)
             AND pg_temp.mcp_rows('__A__'::uuid) = 0
        THEN 'clean' ELSE 'DIRTY' END AS verdict;
