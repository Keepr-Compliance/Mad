-- One get_status call as anon with the fixture access token.
SET LOCAL ROLE anon;
-- ms: server-side duration of the call (t0 is taken first in the same row; OFFSET 0 keeps the subquery).
SELECT x.r, round(extract(epoch FROM clock_timestamp() - x.t0) * 1000)::integer AS ms
  FROM (SELECT clock_timestamp() AS t0,
               public.mcp_get_status('__SECRET__', sha256(convert_to('p4238:at-cc-__RUN__', 'UTF8')), 'https://portal.example.test/api/mcp') AS r
        OFFSET 0) x;
