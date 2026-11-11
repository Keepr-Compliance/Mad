-- BACKLOG-4238: remove exactly the fixture rows of one run and restore the mcp_settings snapshot.
-- Filled by run-concurrency.sh: __CONNS__ (connection ids printed by setup.sql), __RUN__,
-- __ENABLED__ and __SECRET_HEX__ (the snapshot taken before setup).
DO $td$
DECLARE A uuid := '__UID__'::uuid;
        v_conns uuid[] := string_to_array(nullif('__CONNS__', ''), ',')::uuid[];
BEGIN
  DELETE FROM public.mcp_rate_counters
   WHERE bucket = ANY (SELECT 'call_conn:' || x::text FROM unnest(v_conns) x)
      OR bucket = 'call_user:' || A::text
      OR bucket = 'tok_fail:kpr_c_cc__RUN__';
  DELETE FROM public.mcp_call_log WHERE user_id = A;
  DELETE FROM public.mcp_connections WHERE id = ANY (v_conns) AND user_id = A;
  DELETE FROM public.mcp_oauth_clients WHERE client_id = 'kpr_c_cc__RUN__';
  DELETE FROM auth.users WHERE id = A AND email = 'p4238-__RUN__@example.test';
  UPDATE public.mcp_settings
     SET enabled = '__ENABLED__'::boolean,
         portal_secret_sha256 = CASE WHEN '__SECRET_HEX__' = '' THEN NULL ELSE decode('__SECRET_HEX__', 'hex') END
   WHERE id;
END
$td$;
