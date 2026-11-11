SELECT public.cloud_upsert_files('__I__'::uuid, '__DEAL4A__'::uuid, jsonb_build_array(
  jsonb_build_object('local_id', 'cc-f1', 'content_hash', encode(sha256('cc-f1'::bytea), 'hex'), 'filename', 'a.pdf', 'blob_sha256', '__LOW_SHA__'),
  jsonb_build_object('local_id', 'cc-f2', 'content_hash', encode(sha256('cc-f2'::bytea), 'hex'), 'filename', 'b.pdf', 'blob_sha256', '__HIGH_SHA__'))) AS r;
