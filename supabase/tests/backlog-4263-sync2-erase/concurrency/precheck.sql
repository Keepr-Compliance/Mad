-- /*t:precheck*/ READ ONLY, the first call of every run, before anything is created: no auth user with the fixture
-- id, no p4263c-*@example.test user, no public.*_m4263 function, no erase run row marked p4263c; the auth.users total
-- (asserted equal after the delete); and the unreferenced blobs older than 24 h (attach needs fewer than 900).
SELECT (SELECT count(*) FROM auth.users WHERE id = '__U__'::uuid) AS by_id,
       (SELECT count(*) FROM auth.users WHERE email LIKE 'p4263c-%@example.test') AS by_pattern,
       (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '%\_m4263') AS mutants,
       (SELECT count(*) FROM public.cloud_blob_erase_runs WHERE counts ? 'p4263c') AS marked_runs,
       (SELECT count(*) FROM auth.users) AS auth_users,
       (SELECT count(*) FROM public.cloud_blobs x WHERE x.purge_requested_at IS NULL
           AND greatest(x.created_at, coalesce(x.uploaded_at, x.created_at)) < now() - interval '24 hours'
           AND NOT EXISTS (SELECT 1 FROM public.cloud_deal_files f WHERE f.blob_id = x.id)) AS orphans;
