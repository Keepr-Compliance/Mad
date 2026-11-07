-- BACKLOG-4175 migration A rollback (20261108100000_backlog_4175_sender_rule_sets.sql).
-- Removes every object the migration created. Order matters: the tables carry a CHECK that calls
-- _sender_rule_set_invalid, so the tables go before the validators.
-- Desktop clients fall back to their cache, then to the bundled rules, when the RPC is gone.
DROP FUNCTION IF EXISTS public.sender_rule_set_revert_all();
DROP FUNCTION IF EXISTS public.sender_rule_set_pin(UUID, BIGINT);
DROP FUNCTION IF EXISTS public.sender_rule_set_publish(JSONB, UUID);
DROP FUNCTION IF EXISTS public.sender_rule_set_current();
DROP FUNCTION IF EXISTS public._sender_rule_set_release_blocks(JSONB, JSONB, BIGINT);
DROP TABLE IF EXISTS public.sender_rule_set_pins;
DROP TABLE IF EXISTS public.sender_rule_sets;
DROP FUNCTION IF EXISTS public._sender_rule_set_invalid(JSONB);
DROP FUNCTION IF EXISTS public._sender_rule_set_list_invalid(JSONB, INTEGER, TEXT);
DROP FUNCTION IF EXISTS public._sender_rule_set_int_ok(JSONB, NUMERIC, NUMERIC);
DROP FUNCTION IF EXISTS public._sender_rule_set_str_ok(JSONB, TEXT);
DROP FUNCTION IF EXISTS public._sender_rule_set_keys_exact(JSONB, TEXT[]);
-- cascades any report_access rows on the key
DELETE FROM public.reports WHERE report_key = 'sender-rules';
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261108100000';
