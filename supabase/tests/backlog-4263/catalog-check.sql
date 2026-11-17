-- BACKLOG-4263 PR-1 catalogue check. Read-only, one statement (kt-sql or execute_sql).
-- Lists every anon-callable public mcp function with md5(prosrc); after the apply of 20261118100000:
-- anon_mcp_count 10 (the nine earlier ones plus mcp_list_all_deals), mcp_function_count 41,
-- reader_md5 6ea286c67274464080b19fa439b5d9ac, tool_md5 5b12fa79e9f010af2c7c8752f23d3c9c, ledger_4263 1.
SELECT jsonb_build_object(
 'anon_mcp', (SELECT jsonb_object_agg(p.oid::regprocedure::text, md5(p.prosrc)) FROM pg_proc p
               WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_' AND has_function_privilege('anon', p.oid, 'EXECUTE')),
 'anon_mcp_count', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_' AND has_function_privilege('anon', p.oid, 'EXECUTE')),
 'anon_all_count', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('anon', p.oid, 'EXECUTE')),
 'mcp_function_count', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_'),
 'reader_md5', (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public._mcp_r_list_all_deals(text,date,date,uuid)')),
 'reader_acl', (SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure('public._mcp_r_list_all_deals(text,date,date,uuid)')),
 'reader_owner', (SELECT proowner::regrole::text FROM pg_proc WHERE oid = to_regprocedure('public._mcp_r_list_all_deals(text,date,date,uuid)')),
 'tool_md5', (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.mcp_list_all_deals(text,bytea,text,text,text,text,text)')),
 'tool_acl', (SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure('public.mcp_list_all_deals(text,bytea,text,text,text,text,text)')),
 'tool_check', (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'public.mcp_call_log'::regclass AND c.conname = 'mcp_call_log_tool_check'),
 'call_log_rows_new_tool', (SELECT count(*) FROM public.mcp_call_log WHERE tool = 'list_all_deals'),
 'ledger_4263', (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261118100000'),
 'mcp_reader_bypassrls', (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'mcp_reader'),
 'mcp_reader_schema_create', has_schema_privilege('mcp_reader', 'public', 'CREATE')
) AS after;
