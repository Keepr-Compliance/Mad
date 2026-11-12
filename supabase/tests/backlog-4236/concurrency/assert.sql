-- State after a case, for the fixture user.
SELECT json_build_object(
  'deals', (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = '__A__'::uuid),
  'new_deal', (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = '__A__'::uuid AND local_transaction_id = 'cc-new'),
  'messages', (SELECT count(*) FROM public.cloud_deal_messages WHERE owner_user_id = '__A__'::uuid),
  'live_blobs', (SELECT count(*) FROM public.cloud_blobs WHERE owner_user_id = '__A__'::uuid AND purge_requested_at IS NULL),
  'live_new_blob', (SELECT count(*) FROM public.cloud_blobs WHERE owner_user_id = '__A__'::uuid AND purge_requested_at IS NULL
                     AND sha256 = encode(sha256('cc-new-blob-__RUN__'::bytea), 'hex')),
  'live_cc_blob', (SELECT count(*) FROM public.cloud_blobs WHERE owner_user_id = '__A__'::uuid AND purge_requested_at IS NULL
                     AND sha256 = encode(sha256('cc-blob-__RUN__'::bytea), 'hex')),
  'files', (SELECT count(*) FROM public.cloud_deal_files WHERE owner_user_id = '__A__'::uuid),
  'enabled', (SELECT enabled FROM public.cloud_autosave_settings WHERE user_id = '__A__'::uuid)) AS j;
