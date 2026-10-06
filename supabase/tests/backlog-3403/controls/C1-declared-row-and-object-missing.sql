-- C1: declared attachment with no row and no object: incomplete
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((r->>'code') = 'incomplete' AND (r->>'attachment_rows_missing')::int = 1 AND (r->>'objects_missing')::int = 1, 'C1 ' || r::text)
  FROM (SELECT public.finalize_submission(:'S', pg_temp.mf() || jsonb_build_object('attachments',
          (pg_temp.mf()->'attachments') || jsonb_build_array(jsonb_build_object('id', :'AT2', 'storage_path', :'P2', 'message_id', null)))) r) x;
