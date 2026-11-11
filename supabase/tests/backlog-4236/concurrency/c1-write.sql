-- C1b: a write started while the turn-off holds the settings row.
SELECT public.cloud_upsert_messages('__I__'::uuid, '__DEAL__'::uuid, jsonb_build_array(jsonb_build_object('local_id', 'cc-m3',
         'content_hash', encode(sha256('cc-m3'::bytea), 'hex'), 'channel_kind', 'email', 'hidden_from_export', false))) AS r;
