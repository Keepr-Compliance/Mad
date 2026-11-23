-- prefix for every session call: the fixture user's claims, so auth.uid() answers the fixture user. No role switch:
-- the four functions (live and copies) are SECURITY DEFINER and run as their owner either way, and the copies are
-- granted to no API role.
SELECT set_config('request.jwt.claims', json_build_object('sub', '__A__', 'role', 'authenticated')::text, true),
       set_config('request.jwt.claim.sub', '__A__', true), set_config('request.jwt.claim.role', 'authenticated', true);
