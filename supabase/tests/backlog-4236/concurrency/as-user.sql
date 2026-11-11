-- prefix for every session call: act as the fixture user
SELECT set_config('request.jwt.claims', json_build_object('sub', '__A__', 'role', 'authenticated')::text, true),
       set_config('request.jwt.claim.sub', '__A__', true), set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
