-- C1b: the same new-row writes, started while the turn-off holds the settings row.
SELECT public.cloud_upsert_deal('__A__'::uuid, jsonb_build_object('source_install_id', '__I__', 'local_id', 'cc-new', 'content_hash', encode(sha256('cc-new'::bytea), 'hex'))) AS d,
       public.cloud_register_blob('__A__'::uuid, encode(sha256('cc-new-blob-__RUN__'::bytea), 'hex'), 10, NULL) AS b;
