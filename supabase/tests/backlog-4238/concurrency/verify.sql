-- After teardown: 'clean' only when no fixture row is left and mcp_settings equals the snapshot.
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM auth.users WHERE id = '__UID__'::uuid)
             AND NOT EXISTS (SELECT 1 FROM public.mcp_oauth_clients WHERE client_id = 'kpr_c_cc__RUN__')
             AND NOT EXISTS (SELECT 1 FROM public.mcp_connections WHERE id = ANY (string_to_array(nullif('__CONNS__', ''), ',')::uuid[]))
             AND NOT EXISTS (SELECT 1 FROM public.mcp_rate_counters WHERE bucket = 'tok_fail:kpr_c_cc__RUN__'
                               OR bucket = 'call_user:' || ('__UID__')
                               OR bucket = ANY (SELECT 'call_conn:' || x FROM unnest(string_to_array(nullif('__CONNS__', ''), ',')) x))
             AND (SELECT enabled::text = '__ENABLED__' AND coalesce(encode(portal_secret_sha256, 'hex'), '') = '__SECRET_HEX__' FROM public.mcp_settings WHERE id)
        THEN 'clean' ELSE 'NOT CLEAN' END AS verdict;
