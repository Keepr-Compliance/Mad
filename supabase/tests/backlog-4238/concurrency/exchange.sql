-- D7 concurrent half: one session redeems code 'c-cc2' as anon, then holds its transaction open
-- for 3 s (the code row stays locked). Run twice in parallel, the second started 1 s later.
SET LOCAL ROLE anon;
SELECT public.mcp_exchange_code('p4238-secret-current', sha256(convert_to('p4238:c-cc2', 'UTF8')), 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
       'kpr_c_ccxxxxxxxxxxxxxxxxxxxx', 'https://claude.ai/api/mcp/auth_callback', 'https://portal.example.test/api/mcp',
       sha256(convert_to('p4238:at-cc2-' || pg_backend_pid(), 'UTF8')), sha256(convert_to('p4238:rt-cc2-' || pg_backend_pid(), 'UTF8'))) AS r,
       pg_sleep(3) AS hold;
