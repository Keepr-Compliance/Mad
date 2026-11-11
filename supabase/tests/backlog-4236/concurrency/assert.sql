-- State after a case, for the fixture user.
SELECT json_build_object(
  'deals', (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = '__A__'::uuid),
  'messages', (SELECT count(*) FROM public.cloud_deal_messages WHERE owner_user_id = '__A__'::uuid),
  'live_messages', (SELECT count(*) FROM public.cloud_deal_messages WHERE owner_user_id = '__A__'::uuid AND removed_at IS NULL),
  'live_blobs', (SELECT count(*) FROM public.cloud_blobs WHERE owner_user_id = '__A__'::uuid AND purge_requested_at IS NULL),
  'enabled', (SELECT enabled FROM public.cloud_autosave_settings WHERE user_id = '__A__'::uuid)) AS j;
