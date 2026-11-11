-- BACKLOG-4238: what the harness could have left behind on the test project. Every count must be 0.
SELECT json_build_object(
 'mcp_tables', (SELECT count(*) FROM pg_class WHERE relkind IN ('r', 'p') AND (relname LIKE 'mcp\_%' OR relname LIKE 'cloud\_p4238%' OR relname LIKE 'p4238%')),
 'mcp_sequences', (SELECT count(*) FROM pg_class WHERE relkind = 'S' AND (relname LIKE 'mcp\_%' OR relname LIKE 'p4238%')),
 'mcp_other_relations', (SELECT count(*) FROM pg_class WHERE relkind NOT IN ('r', 'p', 'S') AND (relname LIKE 'mcp\_%' OR relname LIKE 'cloud\_p4238%' OR relname LIKE 'p4238%')),
 'mcp_types', (SELECT count(*) FROM pg_type WHERE typname LIKE 'mcp\_%' OR typname LIKE '\_mcp\_%' OR typname LIKE 'p4238%' OR typname LIKE 'cloud\_p4238%'),
 'mcp_functions', (SELECT count(*) FROM pg_proc WHERE proname ~ '^_?mcp_' OR proname LIKE 'p4238%' OR proname = 'get_my_cloud_autosave_state'),
 'mcp_reader_role', (SELECT count(*) FROM pg_roles WHERE rolname = 'mcp_reader'),
 'fixture_users', (SELECT count(*) FROM auth.users WHERE email LIKE 'p4238-%'),
 'ledger_row', (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261112170000')) j;
