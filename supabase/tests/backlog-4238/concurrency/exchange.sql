-- D7 concurrent half: redeems the fixture code as anon, then holds the transaction 3 s (code row locked).
SET LOCAL ROLE anon;
SELECT public.mcp_exchange_code('__SECRET__', sha256(convert_to('p4238:c-cc2-__RUN__', 'UTF8')), 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
       'kpr_c_cc__RUN__', 'https://claude.ai/api/mcp/auth_callback', 'https://portal.example.test/api/mcp',
       sha256(convert_to('p4238:at-cc2-__RUN__-' || pg_backend_pid(), 'UTF8')), sha256(convert_to('p4238:rt-cc2-__RUN__-' || pg_backend_pid(), 'UTF8'))) AS r,
       pg_sleep(3) AS hold;
