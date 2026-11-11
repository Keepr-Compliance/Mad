-- C1a: a write that holds its transaction 4 s after the upsert (settings row held FOR SHARE).
SELECT public.cloud_upsert_messages('__I__'::uuid, '__DEAL__'::uuid, jsonb_build_array(jsonb_build_object('local_id', 'cc-m2-' || pg_backend_pid(),
         'content_hash', encode(sha256('cc-m2'::bytea), 'hex'), 'channel_kind', 'email', 'hidden_from_export', false))) AS r, pg_sleep(4) AS hold;
