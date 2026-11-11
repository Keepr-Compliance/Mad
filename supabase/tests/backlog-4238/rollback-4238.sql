-- BACKLOG-4238 rollback: removes everything 20261112170000_backlog_4238_mcp_oauth_server.sql creates.
-- Order: reader functions (as their owner), the other functions, tables, type, role memberships, role.
DO $rb4238$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'mcp_reader') THEN
    EXECUTE 'GRANT mcp_reader TO postgres WITH INHERIT FALSE, SET TRUE';
    EXECUTE 'SET ROLE mcp_reader';
    EXECUTE 'DROP FUNCTION IF EXISTS public._mcp_r_entitlement()';
    EXECUTE 'RESET ROLE';
  END IF;
END
$rb4238$;
DROP FUNCTION IF EXISTS public.mcp_disconnect_all_mine();
DROP FUNCTION IF EXISTS public.mcp_disconnect(uuid);
DROP FUNCTION IF EXISTS public.mcp_list_my_connections();
DROP FUNCTION IF EXISTS public.mcp_authorize_deny(text, bytea, text);
DROP FUNCTION IF EXISTS public.mcp_authorize_approve(text, bytea, text, bytea);
DROP FUNCTION IF EXISTS public.mcp_authorize_view(text, bytea);
DROP FUNCTION IF EXISTS public.mcp_get_status(text, bytea, text);
DROP FUNCTION IF EXISTS public.mcp_check_access(text, bytea, text);
DROP FUNCTION IF EXISTS public.mcp_refresh(text, bytea, text, text, bytea, bytea);
DROP FUNCTION IF EXISTS public.mcp_exchange_code(text, bytea, text, text, text, text, bytea, bytea);
DROP FUNCTION IF EXISTS public.mcp_authorize_begin(text, text, text, text, text, text, text, text, bytea, bytea);
DROP FUNCTION IF EXISTS public.mcp_register_client(text, text, text, text[], bytea);
DROP FUNCTION IF EXISTS public._mcp_disconnect_all_for(uuid, text);
DROP FUNCTION IF EXISTS public._mcp_entitlement_now();
DROP FUNCTION IF EXISTS public._mcp_finish(bigint, text, integer, timestamptz);
DROP FUNCTION IF EXISTS public._mcp_enter(bytea, text, text);
DROP FUNCTION IF EXISTS public._mcp_reader_ok(regprocedure);
DROP FUNCTION IF EXISTS public._mcp_impersonating(uuid);
DROP FUNCTION IF EXISTS public._mcp_fail_over(text, interval, integer);
DROP FUNCTION IF EXISTS public._mcp_bump(text, interval, integer);
DROP FUNCTION IF EXISTS public._mcp_window(interval);
DROP FUNCTION IF EXISTS public._mcp_b64url(bytea);
DROP FUNCTION IF EXISTS public._mcp_refuse(text);
DROP FUNCTION IF EXISTS public._mcp_secret_ok(text);
DROP TABLE IF EXISTS public.mcp_call_log;
DROP TABLE IF EXISTS public.mcp_rate_counters;
DROP TABLE IF EXISTS public.mcp_tokens;
DROP TABLE IF EXISTS public.mcp_authorization_codes;
DROP TABLE IF EXISTS public.mcp_connections;
DROP TABLE IF EXISTS public.mcp_authorization_requests;
DROP TABLE IF EXISTS public.mcp_oauth_clients;
DROP TABLE IF EXISTS public.mcp_redirect_allowlist;
DROP TABLE IF EXISTS public.mcp_settings;
DROP TYPE IF EXISTS public.mcp_gate;
DO $rb4238$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'mcp_reader') THEN
    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM mcp_reader';
    EXECUTE 'REVOKE authenticated FROM mcp_reader';
    EXECUTE 'REVOKE mcp_reader FROM postgres';
    EXECUTE 'DROP ROLE mcp_reader';
  END IF;
END
$rb4238$;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261112170000';
