-- C1a: writes that create new rows (a new deal and a new blob), then hold the transaction 4 s.
SELECT public.cloud_upsert_deal(jsonb_build_object('source_install_id', '__I__', 'local_id', 'cc-new', 'content_hash', encode(sha256('cc-new'::bytea), 'hex'))) AS d,
       public.cloud_register_blob(encode(sha256('cc-new-blob-__RUN__'::bytea), 'hex'), 10, NULL) AS b,
       pg_sleep(4) /*p_hold:__RUN__*/ AS hold;
