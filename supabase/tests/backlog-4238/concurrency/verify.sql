-- After teardown: 'clean' only when none of the nine mcp_* tables holds a row of this run, the
-- fixture user is gone, mcp_settings equals the snapshot and the allowlist count is unchanged.
WITH ids AS (
  SELECT '__UID__'::uuid AS a, 'kpr_c_cc__RUN__'::text AS client,
         coalesce(string_to_array(nullif('__CONNS__', ''), ',')::uuid[], '{}') AS conns
)
SELECT CASE WHEN
      NOT EXISTS (SELECT 1 FROM auth.users u, ids WHERE u.id = ids.a)
  AND (SELECT s.enabled::text = '__ENABLED__' AND coalesce(encode(s.portal_secret_sha256, 'hex'), '') = '__SECRET_HEX__'
         FROM public.mcp_settings s WHERE s.id)                                                         -- 1 mcp_settings
  AND (SELECT count(*) FROM public.mcp_redirect_allowlist)::text = '__ALLOW_N__'                        -- 2 mcp_redirect_allowlist
  AND NOT EXISTS (SELECT 1 FROM public.mcp_oauth_clients c, ids WHERE c.client_id = ids.client)         -- 3 mcp_oauth_clients
  AND NOT EXISTS (SELECT 1 FROM public.mcp_authorization_requests r, ids
                   WHERE r.client_id = ids.client OR r.claimed_by = ids.a)                              -- 4 mcp_authorization_requests
  AND NOT EXISTS (SELECT 1 FROM public.mcp_connections c, ids
                   WHERE c.id = ANY (ids.conns) OR c.client_id = ids.client OR c.user_id = ids.a)       -- 5 mcp_connections
  AND NOT EXISTS (SELECT 1 FROM public.mcp_authorization_codes k, ids
                   WHERE k.connection_id = ANY (ids.conns) OR k.client_id = ids.client)                 -- 6 mcp_authorization_codes
  AND NOT EXISTS (SELECT 1 FROM public.mcp_tokens t, ids WHERE t.connection_id = ANY (ids.conns))       -- 7 mcp_tokens
  AND NOT EXISTS (SELECT 1 FROM public.mcp_rate_counters q, ids
                   WHERE q.bucket = 'tok_fail:' || ids.client OR q.bucket = 'call_user:' || ids.a::text
                      OR q.bucket = ANY (SELECT 'call_conn:' || x::text FROM unnest(ids.conns) x))     -- 8 mcp_rate_counters
  AND NOT EXISTS (SELECT 1 FROM public.mcp_call_log l, ids
                   WHERE l.user_id = ids.a OR l.connection_id = ANY (ids.conns))                        -- 9 mcp_call_log
  THEN 'clean' ELSE 'NOT CLEAN' END AS verdict
FROM ids;
