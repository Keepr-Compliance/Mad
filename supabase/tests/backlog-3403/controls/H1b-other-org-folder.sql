-- H1b: attachment row whose first segment is another org: refused
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.submission_attachments (submission_id, filename, storage_path) VALUES ('5b340300-0000-4000-8000-000000000001', 'o', '0e340300-0000-4000-8000-0000000000a2/5b340300-0000-4000-8000-000000000001/loc9/o.pdf');  -- pii-allow-uuid: invented fixture id
  RAISE EXCEPTION 'H1b was allowed';
EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.ok(true, 'H1b refused'); END $$;
