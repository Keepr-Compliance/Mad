-- /*t:precheck*/ READ ONLY, the FIRST call of every run, before anything is created (the probe for the before-note).
-- Statement 1 sets a transaction-local setting; the final SELECT reads it back. run.sh refuses to go on unless its
-- answer has txn = 'one' (both statements ran in one transaction) and
-- iso = 'read committed'. It also refuses when an auth user has the fixture id, any p4263c-*@example.test user exists,
-- any public.*_m4263 function exists, any erase run row is marked p4263c, any row references the fixture id, or (attach)
-- 900 or more unreferenced blobs are older than 24 h. Names (function names, fixture addresses) are returned so a
-- refusal says what it found; fixture addresses only, never another user's.
SELECT set_config('p4263.probe', 'one', true) AS probe_set;
SELECT json_build_object('tag', 'probe',
       'txn', current_setting('p4263.probe', true),
       'iso', current_setting('transaction_isolation'),
       'track_size', current_setting('track_activity_query_size'),
       'bypassrls', (SELECT r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = current_user),
       'one_computer', coalesce((SELECT one_computer FROM public.cloud_release_switches WHERE id), false),
       'by_id', (SELECT count(*) FROM auth.users WHERE id = '__U__'::uuid),
       'by_pattern', (SELECT count(*) FROM auth.users WHERE email LIKE 'p4263c-%@example.test'),
       'pattern_emails', (SELECT string_agg(email, ', ' ORDER BY email) FROM auth.users WHERE email LIKE 'p4263c-%@example.test'),
       'mutants', (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '%\_m4263'),
       'mutant_names', (SELECT string_agg(p.proname::text, ', ' ORDER BY p.proname) FROM pg_catalog.pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '%\_m4263'),
       'marked_runs', (SELECT count(*) FROM public.cloud_blob_erase_runs WHERE counts ? 'p4263c'),
       'auth_users', (SELECT count(*) FROM auth.users),
       'orphans', (SELECT count(*) FROM public.cloud_blobs x WHERE x.purge_requested_at IS NULL
           AND greatest(x.created_at, coalesce(x.uploaded_at, x.created_at)) < now() - interval '24 hours'
           AND NOT EXISTS (SELECT 1 FROM public.cloud_deal_files f WHERE f.blob_id = x.id)),
       'fk', (SELECT json_agg(json_build_object('tbl', f.tbl, 'col', f.col, 'del', f.del, 'n', f.n)) FROM (
         SELECT c.conrelid::regclass::text AS tbl, a.attname::text AS col, c.confdeltype::text AS del,
                (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %s WHERE %I = %L::uuid',
                                                            c.conrelid::regclass, a.attname, '__U__'), false, true, '')))[1]::text::bigint AS n
           FROM pg_catalog.pg_constraint c
           JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
          WHERE c.contype = 'f' AND c.confrelid = 'auth.users'::regclass) f)) AS a;
