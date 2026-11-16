-- 'clean' only when no row of the run is left anywhere, including any public mcp_* table with a user_id column.
-- No helper function: a pg_temp function committed by one call stays in the pooled backend and reads as residue.
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM auth.users WHERE id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.users WHERE id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = '__O__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.organization_members WHERE id = '__M__'::uuid OR user_id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.member_addons WHERE user_id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.cloud_autosave_settings WHERE user_id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.cloud_deals WHERE owner_user_id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.cloud_blobs WHERE owner_user_id = '__A__'::uuid)
             AND (SELECT coalesce(sum((xpath('/row/n/text()', query_to_xml(format(
                    'SELECT count(*) AS n FROM public.%I WHERE user_id = %L', c.table_name, '__A__'), false, true, '')))[1]::text::bigint), 0)
                    FROM information_schema.columns c
                   WHERE c.table_schema = 'public' AND c.table_name LIKE 'mcp\_%' AND c.column_name = 'user_id') = 0
        THEN 'clean' ELSE 'DIRTY' END AS verdict;
