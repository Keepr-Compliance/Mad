-- One get_status call as anon with the fixture access token.
SET LOCAL ROLE anon;
SELECT public.mcp_get_status('__SECRET__', sha256(convert_to('p4238:at-cc-__RUN__', 'UTF8')), 'https://portal.example.test/api/mcp') AS r;
