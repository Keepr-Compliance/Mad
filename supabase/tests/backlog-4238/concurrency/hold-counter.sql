-- D13 busy: holds the fixture connection's counter row of the current minute for 4 s.
INSERT INTO public.mcp_rate_counters AS rc (bucket, window_start, count)
SELECT 'call_conn:' || c.id, public._mcp_window(interval '1 minute'), 1
  FROM public.mcp_connections c WHERE c.client_id = 'kpr_c_cc__RUN__' AND c.status = 'active'
ON CONFLICT (bucket, window_start) DO UPDATE SET count = rc.count;
SELECT pg_sleep(4);
