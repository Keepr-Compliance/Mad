-- BACKLOG-4244 rollback: removes everything 20261114110000_backlog_4244_mcp_data_tools.sql creates and
-- restores the mcp_call_log CHECKs of 20261112170000_backlog_4238_mcp_oauth_server.sql.
-- Order: log rows the old CHECKs would refuse, the CHECKs, reader functions (as their owner), the
-- tool functions, the helpers, the ledger row.
DELETE FROM public.mcp_call_log
 WHERE tool IN ('list_deals', 'get_deal', 'get_deal_checklists') OR outcome IN ('invalid_input', 'not_found', 'too_large');
DO $rb4244$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT c.conname FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = 'public.mcp_call_log'::regclass AND c.contype = 'c'
       AND c.conkey IN (ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'public.mcp_call_log'::regclass AND a.attname = 'tool')],
                        ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a WHERE a.attrelid = 'public.mcp_call_log'::regclass AND a.attname = 'outcome')])
  LOOP
    EXECUTE format('ALTER TABLE public.mcp_call_log DROP CONSTRAINT %I', v_name);
  END LOOP;
END
$rb4244$;
ALTER TABLE public.mcp_call_log ADD CONSTRAINT mcp_call_log_tool_check
  CHECK (tool IS NULL OR tool IN ('get_status'));
ALTER TABLE public.mcp_call_log ADD CONSTRAINT mcp_call_log_outcome_check
  CHECK (outcome IN ('pending', 'ok', 'not_connected', 'disabled', 'rate_limited', 'busy', 'not_entitled', 'timeout', 'error'));
DO $rb4244$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'mcp_reader') THEN
    EXECUTE 'SET ROLE mcp_reader';
    EXECUTE 'DROP FUNCTION IF EXISTS public._mcp_r_deal_checklists(uuid, boolean, uuid)';
    EXECUTE 'DROP FUNCTION IF EXISTS public._mcp_r_get_deal(uuid)';
    EXECUTE 'DROP FUNCTION IF EXISTS public._mcp_r_list_deals(text, text, integer, timestamptz, uuid)';
    EXECUTE 'RESET ROLE';
  END IF;
END
$rb4244$;
DROP FUNCTION IF EXISTS public.mcp_get_deal_checklists(text, bytea, text, text, boolean, text);
DROP FUNCTION IF EXISTS public.mcp_get_deal(text, bytea, text, text);
DROP FUNCTION IF EXISTS public.mcp_list_deals(text, bytea, text, text, text, integer, text);
DROP FUNCTION IF EXISTS public._mcp_day(timestamptz);
DROP FUNCTION IF EXISTS public._mcp_ts(timestamptz);
DROP FUNCTION IF EXISTS public._mcp_clean(text, integer);
DROP FUNCTION IF EXISTS public._mcp_mask(text);
DROP FUNCTION IF EXISTS public._mcp_txt(text, integer);
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261114110000';
