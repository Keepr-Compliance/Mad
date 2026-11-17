-- BACKLOG-4263 PR-1 rollback: removes everything 20261118100000_backlog_4263_mcp_list_all_deals.sql
-- creates and restores the mcp_call_log tool CHECK of 20261114110000_backlog_4244_mcp_data_tools.sql.
-- Order: log rows the earlier CHECK would refuse, the CHECK, the reader (as its owner), the tool, the
-- ledger row. It deletes every mcp_call_log row of the tool list_all_deals.
DELETE FROM public.mcp_call_log WHERE tool = 'list_all_deals';
DO $rb4263$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT c.conname FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = 'public.mcp_call_log'::regclass AND c.contype = 'c'
       AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'public.mcp_call_log'::regclass AND a.attname = 'tool')]
  LOOP
    EXECUTE format('ALTER TABLE public.mcp_call_log DROP CONSTRAINT %I', v_name);
  END LOOP;
END
$rb4263$;
ALTER TABLE public.mcp_call_log ADD CONSTRAINT mcp_call_log_tool_check
  CHECK (tool IS NULL OR tool IN ('get_status', 'list_deals', 'get_deal', 'get_deal_checklists'));
DO $rb4263$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'mcp_reader') THEN
    EXECUTE 'SET ROLE mcp_reader';
    EXECUTE 'DROP FUNCTION IF EXISTS public._mcp_r_list_all_deals(text, date, date, uuid)';
    EXECUTE 'RESET ROLE';
  END IF;
END
$rb4263$;
DROP FUNCTION IF EXISTS public.mcp_list_all_deals(text, bytea, text, text, text, text, text);
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261118100000';
