-- D13 busy: holds the per-connection counter row of the current minute for 4 s, as a concurrent call would.
INSERT INTO public.mcp_rate_counters AS rc (bucket, window_start, count)
SELECT 'call_conn:' || c.id, public._mcp_window(interval '1 minute'), 1
  FROM public.mcp_connections c WHERE c.user_id = ('00000000-0000-4238-8000-' || lpad('1', 12, '0'))::uuid AND c.status = 'active'
ON CONFLICT (bucket, window_start) DO UPDATE SET count = rc.count;
SELECT pg_sleep(4);
