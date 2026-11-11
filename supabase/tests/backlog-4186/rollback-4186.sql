-- BACKLOG-4186 PR A rollback (20261109210000_backlog_4186_sender_rule_set_reads.sql).
-- Removes the two read functions. The 4175 tables and write functions are untouched.
DROP FUNCTION IF EXISTS public.sender_rule_set_admin_content(BIGINT);
DROP FUNCTION IF EXISTS public.sender_rule_set_admin_state();
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261109210000';
