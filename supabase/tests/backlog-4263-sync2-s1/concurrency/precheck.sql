-- /*t:precheck*/ READ ONLY, the first call of every run, before anything is created. run.sh refuses to go on unless
-- no auth user has the fixture id, no auth user has a p4263s1cc-*@example.test address, and no public.*_m4263 function
-- exists. It also returns the auth.users total (asserted equal after the teardown) and the one-computer switch.
SELECT (SELECT count(*) FROM auth.users WHERE id = '__A__'::uuid) AS by_id,
       (SELECT count(*) FROM auth.users WHERE email LIKE 'p4263s1cc-%@example.test') AS by_pattern,
       (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '%\_m4263') AS mutants,
       (SELECT count(*) FROM auth.users) AS auth_users,
       coalesce((SELECT one_computer FROM public.cloud_release_switches WHERE id), false) AS one_computer;
