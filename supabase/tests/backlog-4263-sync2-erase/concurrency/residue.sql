-- /*t:residue*/ READ ONLY, after the delete: rows of the fixture user left (direct and second-level), erase run rows
-- marked p4263c, and the auth.users total (compared with the precheck's).
SELECT json_build_object('tag', 'residue', 'n', (SELECT count(*) FROM auth.users WHERE id = '__U__') + (SELECT count(*) FROM public.cloud_autosave_settings WHERE user_id = '__U__')
     + (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = '__U__') + (SELECT count(*) FROM public.cloud_deal_messages WHERE owner_user_id = '__U__')
     + (SELECT count(*) FROM public.cloud_deal_files WHERE owner_user_id = '__U__') + (SELECT count(*) FROM public.cloud_blobs WHERE owner_user_id = '__U__')
     + (SELECT count(*) FROM public.cloud_blob_erase_runs WHERE counts ? 'p4263c'),
       'auth_users', (SELECT count(*) FROM auth.users)) AS a;
