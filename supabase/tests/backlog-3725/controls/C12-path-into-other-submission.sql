-- C12: declared path in the folder of another submission (object exists): incomplete
UPDATE public.submission_attachments SET storage_path = :'POTHER' WHERE id = :'AT1';
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((r->>'code') = 'incomplete' AND (r->>'paths_outside_submission')::int = 1 AND (r->>'objects_missing')::int = 0, 'C12 ' || r::text)
  FROM (SELECT public.finalize_submission(:'S', jsonb_set(pg_temp.mf(), '{attachments,0,storage_path}', to_jsonb(:'POTHER'::text))) r) x;
