-- 'clean' only when no row of the run is left anywhere.
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM auth.users WHERE id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.users WHERE id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = '__O__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.organization_members WHERE id = '__M__'::uuid OR user_id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.member_addons WHERE user_id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.cloud_autosave_settings WHERE user_id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.cloud_deals WHERE owner_user_id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.cloud_blobs WHERE owner_user_id = '__A__'::uuid)
        THEN 'clean' ELSE 'DIRTY' END AS verdict;
