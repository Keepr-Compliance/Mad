-- C4 second session: attach both blobs to deal cc-4b, payload in the opposite order (high, low).
SELECT public.cloud_upsert_files('__I__'::uuid, '__DEAL4B__'::uuid, jsonb_build_array(
  jsonb_build_object('local_id', 'cc-f3', 'content_hash', encode(sha256('cc-f3'::bytea), 'hex'), 'filename', 'c.pdf', 'blob_sha256', '__HIGH_SHA__'),
  jsonb_build_object('local_id', 'cc-f4', 'content_hash', encode(sha256('cc-f4'::bytea), 'hex'), 'filename', 'd.pdf', 'blob_sha256', '__LOW_SHA__'))) AS r;
