-- R6 session 2: IA writes a new deal while the claim holds; it waits at its settings lock, then must be refused.
SELECT public.__DEAL_FN__('__A__'::uuid, jsonb_build_object('source_install_id', '__IA__', 'local_id', 'r6-new', 'content_hash', encode(sha256('r6-new'::bytea), 'hex'))) AS r;
