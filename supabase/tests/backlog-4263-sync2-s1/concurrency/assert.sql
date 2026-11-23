-- State after a case, for the fixture user.
SELECT json_build_object(
  'active', (SELECT active_install_id FROM public.cloud_autosave_settings WHERE user_id = '__A__'::uuid),
  'enabled', (SELECT enabled FROM public.cloud_autosave_settings WHERE user_id = '__A__'::uuid),
  'deals', (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = '__A__'::uuid),
  'deal_r1', (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = '__A__'::uuid AND local_transaction_id = 'r1-new'),
  'deal_r6', (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = '__A__'::uuid AND local_transaction_id = 'r6-new'),
  'moves', (SELECT count(*) FROM public.cloud_computer_moves WHERE owner_user_id = '__A__'::uuid),
  'live_blobs', (SELECT count(*) FROM public.cloud_blobs WHERE owner_user_id = '__A__'::uuid AND purge_requested_at IS NULL)) AS j;
