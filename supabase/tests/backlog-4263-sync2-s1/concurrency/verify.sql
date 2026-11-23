-- /*t:verify*/ 'clean' only when no row of the run is left (keyed on the fixture user id and this run's slug).
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM auth.users WHERE id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.users WHERE id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.organizations WHERE slug = 'p4263s1cc-__RUN__')
             AND NOT EXISTS (SELECT 1 FROM public.organization_members WHERE user_id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.member_addons WHERE user_id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.cloud_autosave_settings WHERE user_id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.cloud_deals WHERE owner_user_id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.cloud_blobs WHERE owner_user_id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.cloud_removed_installs WHERE owner_user_id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.cloud_todo_feed_head WHERE owner_user_id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.cloud_computer_moves WHERE owner_user_id = '__A__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.cloud_computer_move_notices WHERE user_id = '__A__'::uuid)
        THEN 'clean' ELSE 'DIRTY' END AS verdict;
