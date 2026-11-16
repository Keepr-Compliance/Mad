-- C3b: register the same content while the first registration is uncommitted.
SELECT public.cloud_register_blob('__A__'::uuid, encode(sha256('cc-blob-__RUN__'::bytea), 'hex'), 10, NULL) /*c3_wait:__RUN__*/ AS r;
