-- /*t:precheck*/ READ ONLY, the FIRST call of every run, before anything is created (the probe for the before-note).
-- Statement 1 sets a transaction-local setting; the final SELECT reads it back. run.sh refuses to go on unless its
-- answer has txn = 'one' (both statements ran in one transaction) and iso = 'read committed'. The answer is one tagged
-- json (column a), read as the last tagged answer of the call, so it does not matter whether the transport returns every
-- statement's rows or only the last one's. It also refuses when an auth user has the fixture id, an auth user has a
-- p4263s1cc-*@example.test address, any public.*_m4263 function exists, any row references the fixture id, or (R3-R6)
-- one_computer is not already true. Names (function names, fixture addresses) are returned so a refusal says what it
-- found; fixture addresses only, never another user's.
SELECT set_config('p4263.probe', 'one', true) AS probe_set;
SELECT json_build_object('tag', 'probe',
       'txn', current_setting('p4263.probe', true),
       'iso', current_setting('transaction_isolation'),
       'track_size', current_setting('track_activity_query_size'),
       'bypassrls', (SELECT r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = current_user),
       'by_id', (SELECT count(*) FROM auth.users WHERE id = '__A__'::uuid),
       'by_pattern', (SELECT count(*) FROM auth.users WHERE email LIKE 'p4263s1cc-%@example.test'),
       'pattern_emails', (SELECT string_agg(email, ', ' ORDER BY email) FROM auth.users WHERE email LIKE 'p4263s1cc-%@example.test'),
       'mutants', (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '%\_m4263'),
       'mutant_names', (SELECT string_agg(p.proname::text, ', ' ORDER BY p.proname) FROM pg_catalog.pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '%\_m4263'),
       'auth_users', (SELECT count(*) FROM auth.users),
       'one_computer', coalesce((SELECT one_computer FROM public.cloud_release_switches WHERE id), false),
       'fk', (SELECT json_agg(json_build_object('tbl', f.tbl, 'col', f.col, 'del', f.del, 'n', f.n)) FROM (
         SELECT c.conrelid::regclass::text AS tbl, a.attname::text AS col, c.confdeltype::text AS del,
                (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %s WHERE %I = %L::uuid',
                                                            c.conrelid::regclass, a.attname, '__A__'), false, true, '')))[1]::text::bigint AS n
           FROM pg_catalog.pg_constraint c
           JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
          WHERE c.contype = 'f' AND c.confrelid = 'auth.users'::regclass) f)) AS a;
