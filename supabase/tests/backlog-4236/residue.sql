-- BACKLOG-4236: what the harness could have left behind on the test project. Every count must be 0.
SELECT json_build_object(
 'tables', (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace
             AND relname IN ('cloud_autosave_settings', 'member_addons', 'cloud_deals', 'cloud_deal_parties', 'cloud_deal_checklists',
                             'cloud_deal_checklist_items', 'cloud_deal_messages', 'cloud_blobs', 'cloud_deal_files')),
 'functions', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                AND (proname ~ '^_?cloud_' OR proname IN ('set_my_cloud_autosave', 'get_my_cloud_autosave_state', 'assign_member_addon'))),
 'bucket', (SELECT count(*) FROM storage.buckets WHERE id = 'cloud-deal-files'),
 'bucket_objects', (SELECT count(*) FROM storage.objects WHERE bucket_id = 'cloud-deal-files'),
 'storage_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND policyname LIKE 'Cloud deal files:%'),
 'feature_keys', (SELECT count(*) FROM public.feature_definitions WHERE key IN ('cloud_autosave', 'cloud_autosave_assignable')),
 'fixture_users', (SELECT count(*) FROM auth.users WHERE email LIKE 'p4236%'),
 'fixture_public_users', (SELECT count(*) FROM public.users WHERE email LIKE 'p4236%'),
 'fixture_orgs', (SELECT count(*) FROM public.organizations WHERE slug LIKE 'p4236%'),
 'ledger', (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version IN ('20261112180000', '20261112190000'))) AS residue;
