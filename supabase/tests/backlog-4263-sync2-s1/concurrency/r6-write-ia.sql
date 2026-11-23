-- R6 session 2: IA writes a new deal while the claim holds; it waits at its settings lock, then must be refused.
SELECT set_config('p4263.t_start', clock_timestamp()::text, true);
SELECT set_config('p4263.r', (public.__DEAL_FN__('__A__'::uuid, jsonb_build_object('source_install_id', '__IA__', 'local_id', 'r6-new', 'content_hash', encode(sha256('r6-new'::bytea), 'hex'))))::text, true);
