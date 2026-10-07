-- X1: A cannot reference an object of its other uploading submission from S, so abandoning S2 cannot reach S
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.submission_attachments (submission_id, filename, storage_path) VALUES ('5b340300-0000-4000-8000-000000000001', 'o', '0e340300-0000-4000-8000-0000000000a1/5b340300-0000-4000-8000-000000000002/loc9/other.pdf');  -- pii-allow-uuid: invented fixture id
  RAISE EXCEPTION 'X1 was allowed';
EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.ok(true, 'X1 refused'); END $$;
RESET ROLE;
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.submission_attachments WHERE storage_path = :'POTHER'), 'X1 no row references S2');
