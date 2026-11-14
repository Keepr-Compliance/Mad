-- Read-only catalog fingerprint of the Keepr Cloud surface (before and after each harness call).
SELECT md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text)) AS functions,
       (SELECT count(*) FROM pg_proc WHERE proname = 'cloud_list_install_rows') AS list_rows_fn,
       (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version LIKE '2026111%') AS ledger_rows,
       (SELECT md5(string_agg(c.relname || ':' || c.relnatts, ',' ORDER BY c.relname)) FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'cloud%') AS tables
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '%cloud%';
