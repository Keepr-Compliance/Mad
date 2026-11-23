-- /*t:precheck*/ READ ONLY, the FIRST call of every run, before anything is created (the probe for the before-note).
-- Statement 1 sets a transaction-local setting; statement 2 reads it back. run.sh refuses to go on unless the answer is
-- exactly ONE row with txn = 'one' (one call = one transaction, and only the last statement's rows come back) and
-- iso = 'read committed'. It also refuses when an auth user has the fixture id, any p4263c-*@example.test user exists,
-- any public.*_m4263 function exists, any erase run row is marked p4263c, any row references the fixture id, or (attach)
-- 900 or more unreferenced blobs are older than 24 h. Names (function names, fixture addresses) are returned so a
-- refusal says what it found; fixture addresses only, never another user's.
SELECT set_config('p4263.probe', 'one', true) AS probe_set;
SELECT current_setting('p4263.probe', true) AS txn,
       current_setting('transaction_isolation') AS iso,
       current_setting('track_activity_query_size') AS track_size,
       (SELECT r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) AS bypassrls,
       coalesce((SELECT one_computer FROM public.cloud_release_switches WHERE id), false) AS one_computer,
       (SELECT count(*) FROM auth.users WHERE id = '__U__'::uuid) AS by_id,
       (SELECT count(*) FROM auth.users WHERE email LIKE 'p4263c-%@example.test') AS by_pattern,
       (SELECT string_agg(email, ', ' ORDER BY email) FROM auth.users WHERE email LIKE 'p4263c-%@example.test') AS pattern_emails,
       (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '%\_m4263') AS mutants,
       (SELECT string_agg(p.proname::text, ', ' ORDER BY p.proname) FROM pg_catalog.pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '%\_m4263') AS mutant_names,
       (SELECT count(*) FROM public.cloud_blob_erase_runs WHERE counts ? 'p4263c') AS marked_runs,
       (SELECT count(*) FROM auth.users) AS auth_users,
       (SELECT count(*) FROM public.cloud_blobs x WHERE x.purge_requested_at IS NULL
           AND greatest(x.created_at, coalesce(x.uploaded_at, x.created_at)) < now() - interval '24 hours'
           AND NOT EXISTS (SELECT 1 FROM public.cloud_deal_files f WHERE f.blob_id = x.id)) AS orphans,
       (SELECT json_agg(json_build_object('tbl', f.tbl, 'col', f.col, 'del', f.del, 'n', f.n)) FROM (
         SELECT c.conrelid::regclass::text AS tbl, a.attname::text AS col, c.confdeltype::text AS del,
                (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %s WHERE %I = %L::uuid',
                                                            c.conrelid::regclass, a.attname, '__U__'), false, true, '')))[1]::text::bigint AS n
           FROM pg_catalog.pg_constraint c
           JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
          WHERE c.contype = 'f' AND c.confrelid = 'auth.users'::regclass) f) AS fk;
