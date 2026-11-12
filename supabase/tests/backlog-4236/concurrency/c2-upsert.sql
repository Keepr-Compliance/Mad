SELECT public.cloud_upsert_messages('__I__'::uuid, '__DEAL__'::uuid, jsonb_build_array(jsonb_build_object('local_id', 'cc-m1',
         'content_hash', encode(sha256('cc-m1-v2'::bytea), 'hex'), 'channel_kind', 'email', 'hidden_from_export', false))) AS r;
