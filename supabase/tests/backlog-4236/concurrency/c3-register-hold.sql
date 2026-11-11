-- C3a: register a blob and hold the transaction 3 s.
SELECT public.cloud_register_blob(encode(sha256('cc-blob-__RUN__'::bytea), 'hex'), 10, NULL) AS r, pg_sleep(3) AS hold;
