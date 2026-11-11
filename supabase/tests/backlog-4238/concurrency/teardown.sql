-- BACKLOG-4238: remove the concurrency fixtures.
DELETE FROM public.mcp_call_log WHERE user_id = ('00000000-0000-4238-8000-' || lpad('1', 12, '0'))::uuid;
DELETE FROM public.mcp_connections WHERE user_id = ('00000000-0000-4238-8000-' || lpad('1', 12, '0'))::uuid;
DELETE FROM public.mcp_oauth_clients WHERE client_id = 'kpr_c_ccxxxxxxxxxxxxxxxxxxxx';
DELETE FROM public.mcp_rate_counters WHERE bucket LIKE 'call_%' OR bucket LIKE 'tok_fail:kpr_c_cc%';
UPDATE public.mcp_settings SET enabled = false, portal_secret_sha256 = NULL WHERE id;
DELETE FROM auth.users WHERE id = ('00000000-0000-4238-8000-' || lpad('1', 12, '0'))::uuid;
