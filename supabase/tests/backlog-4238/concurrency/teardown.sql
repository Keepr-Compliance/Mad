-- BACKLOG-4238: remove every row one run created in the mcp_* tables, by this run's ids only
-- (explicit deletes; nothing relies on a cascade from auth.users), then the fixture user, then
-- restore the mcp_settings snapshot.
-- Filled by run-concurrency.sh: __UID__, __RUN__, __CONNS__ (ids printed by setup.sql),
-- __ENABLED__ and __SECRET_HEX__ (the snapshot taken before setup).
DO $td$
DECLARE A uuid := '__UID__'::uuid;
        v_client text := 'kpr_c_cc__RUN__';
        v_conns uuid[];
BEGIN
  v_conns := ARRAY(SELECT x FROM unnest(string_to_array(nullif('__CONNS__', ''), ',')::uuid[]) x
                   UNION SELECT c.id FROM public.mcp_connections c WHERE c.client_id = v_client OR c.user_id = A);
  DELETE FROM public.mcp_rate_counters
   WHERE bucket = ANY (SELECT 'call_conn:' || x::text FROM unnest(v_conns) x)
      OR bucket = 'call_user:' || A::text
      OR bucket = 'tok_fail:' || v_client;
  DELETE FROM public.mcp_call_log WHERE user_id = A OR connection_id = ANY (v_conns);
  DELETE FROM public.mcp_tokens WHERE connection_id = ANY (v_conns);
  DELETE FROM public.mcp_authorization_codes WHERE connection_id = ANY (v_conns) OR client_id = v_client;
  DELETE FROM public.mcp_authorization_requests WHERE client_id = v_client OR claimed_by = A;
  DELETE FROM public.mcp_connections WHERE id = ANY (v_conns);
  DELETE FROM public.mcp_oauth_clients WHERE client_id = v_client;
  DELETE FROM auth.users WHERE id = A AND email = 'p4238-__RUN__@example.test';
  UPDATE public.mcp_settings
     SET enabled = '__ENABLED__'::boolean,
         portal_secret_sha256 = CASE WHEN '__SECRET_HEX__' = '' THEN NULL ELSE decode('__SECRET_HEX__', 'hex') END
   WHERE id;
END
$td$;
