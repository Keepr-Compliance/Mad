-- K2 (BACKLOG-3136): who may write an audit row.
SELECT pg_temp.check('anon -> refused', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.as_role('anon', NULL, 'SELECT public.log_admin_action(''fx.anon'', ''user'', ''x'')::text') r) s;
-- Reached through a SECURITY DEFINER chain (runs as the owner) from an anon request:
-- EXECUTE is not the guard there, the role check is.
SELECT pg_temp.check('owner role with anon claims -> refused', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.as_role('postgres', NULL, 'SELECT public.log_admin_action(''fx.chain'', ''user'', ''x'')::text') r) s
 WHERE set_config('request.jwt.claims', '{"role":"anon"}', true) IS NOT NULL;
SELECT pg_temp.check('no actorless row from anon', NOT EXISTS (SELECT 1 FROM public.admin_audit_logs WHERE action IN ('fx.anon', 'fx.chain')));
SELECT pg_temp.check('signed-in user -> accepted', r LIKE 'OK %', r)
  FROM (SELECT pg_temp.admin('SELECT public.log_admin_action(''fx.user'', ''user'', ''x'')::text') r) s;
SELECT pg_temp.check('signed-in user row carries that actor', EXISTS (SELECT 1 FROM public.admin_audit_logs WHERE action = 'fx.user' AND actor_id = pg_temp.id('a_admin')));
SELECT pg_temp.check('service role -> row with no actor', r LIKE 'OK %', r)
  FROM (SELECT pg_temp.as_role('service_role', NULL, 'SELECT public.log_admin_action(''fx.svc'', ''user'', ''x'')::text') r) s;
SELECT pg_temp.check('service-role row stored with NULL actor', EXISTS (SELECT 1 FROM public.admin_audit_logs WHERE action = 'fx.svc' AND actor_id IS NULL));
