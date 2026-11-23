-- R1 session 1: IA writes a new deal, then holds its transaction (and its settings FOR SHARE lock) 4 s.
SELECT public.cloud_upsert_deal('__A__'::uuid, jsonb_build_object('source_install_id', '__IA__', 'local_id', 'r1-new', 'content_hash', encode(sha256('r1-new'::bytea), 'hex'))) AS r,
       clock_timestamp() AS t_write, pg_sleep(4) /*p_hold:__RUN__*/ AS hold;
