-- BACKLOG-4259: read-only catalog check of the test project before and after the harness calls.
-- md5 of the function bodies this change edits, object counts, ledger row, row counts of the mcp_* tables.
SELECT json_build_object(
 'fn_md5', (SELECT json_object_agg(p.proname, md5(p.prosrc)) FROM pg_proc p
             WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('mcp_register_client', 'mcp_authorize_begin', 'mcp_authorize_view')),
 'mcp_functions', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname ~ '^_?mcp_'),
 'mcp_tables', (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname LIKE 'mcp\_%'),
 'ledger_4238', (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261112170000'),
 'rows', json_build_object(
   'clients', (SELECT count(*) FROM public.mcp_oauth_clients), 'requests', (SELECT count(*) FROM public.mcp_authorization_requests),
   'connections', (SELECT count(*) FROM public.mcp_connections), 'codes', (SELECT count(*) FROM public.mcp_authorization_codes),
   'tokens', (SELECT count(*) FROM public.mcp_tokens), 'counters', (SELECT count(*) FROM public.mcp_rate_counters),
   'call_log', (SELECT count(*) FROM public.mcp_call_log)),
 'fixture_users', (SELECT count(*) FROM auth.users WHERE email LIKE 'p4238-%'),
 'enabled', (SELECT enabled FROM public.mcp_settings WHERE id)) j;
