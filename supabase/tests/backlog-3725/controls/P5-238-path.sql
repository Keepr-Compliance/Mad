-- P5: 2.38 path after the migration: uploading insert, rows, client flip: submitted
DELETE FROM public.transaction_submissions WHERE id = :'S';
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
INSERT INTO public.transaction_submissions (id, organization_id, submitted_by, local_transaction_id, property_address, status, version)
  VALUES (:'S', :'ORG', :'A', 't1', 'Fixture Street 1', 'uploading', 1);
INSERT INTO public.submission_messages (submission_id, channel) VALUES (:'S', 'sms');
INSERT INTO public.submission_attachments (submission_id, filename, storage_path) VALUES (:'S', 'x', :'ORG' || '/' || :'S' || '/old.pdf');
UPDATE public.transaction_submissions SET status = 'submitted' WHERE id = :'S';
SELECT pg_temp.ok(status = 'submitted' AND jsonb_array_length(status_history) = 1, 'P5 ' || status) FROM public.transaction_submissions WHERE id = :'S';
