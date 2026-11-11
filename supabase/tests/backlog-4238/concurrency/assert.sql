-- Outcomes recorded for the fixture user, and the fixture connections left.
SELECT json_build_object(
  'outcomes', (SELECT json_object_agg(outcome, n) FROM (SELECT outcome, count(*) n FROM public.mcp_call_log WHERE user_id = ('00000000-0000-4238-8000-' || lpad('1', 12, '0'))::uuid AND event = 'call' GROUP BY outcome) x),
  'events', (SELECT json_object_agg(event, n) FROM (SELECT event, count(*) n FROM public.mcp_call_log WHERE user_id = ('00000000-0000-4238-8000-' || lpad('1', 12, '0'))::uuid AND event <> 'call' GROUP BY event) y),
  'connections', (SELECT json_object_agg(status, n) FROM (SELECT status, count(*) n FROM public.mcp_connections WHERE user_id = ('00000000-0000-4238-8000-' || lpad('1', 12, '0'))::uuid GROUP BY status) z)) j;
