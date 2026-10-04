-- P4: attachment row into a submitted submission (own folder): refused
UPDATE public.transaction_submissions SET status = 'submitted' WHERE id = :'S';
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.submission_attachments (submission_id, filename, storage_path) VALUES ('5b340300-0000-4000-8000-000000000001', 'x', '0e340300-0000-4000-8000-0000000000a1/5b340300-0000-4000-8000-000000000001/loc3/x.pdf');  -- pii-allow-uuid: invented fixture id
  RAISE EXCEPTION 'P4 was allowed';
EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.ok(true, 'P4 refused'); END $$;
