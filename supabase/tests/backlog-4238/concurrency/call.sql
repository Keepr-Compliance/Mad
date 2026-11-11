-- One get_status call as anon with the fixture access token (D13 busy, D14).
SET LOCAL ROLE anon;
SELECT public.mcp_get_status('p4238-secret-current', sha256(convert_to('p4238:at-cc', 'UTF8')), 'https://portal.example.test/api/mcp') AS r;
