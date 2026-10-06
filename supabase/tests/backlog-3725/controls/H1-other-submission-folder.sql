-- H1: attachment row whose path is in the folder of another submission: refused
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.submission_attachments (submission_id, filename, storage_path) VALUES ('5b340300-0000-4000-8000-000000000001', 'o', '0e340300-0000-4000-8000-0000000000a1/5b340300-0000-4000-8000-000000000002/loc9/other.pdf');  -- pii-allow-uuid: invented fixture id
  RAISE EXCEPTION 'H1 was allowed';
EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.ok(true, 'H1 refused'); END $$;
