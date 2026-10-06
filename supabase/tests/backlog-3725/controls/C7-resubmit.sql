-- C7: submission with a parent: resubmitted
INSERT INTO public.transaction_submissions (id, organization_id, submitted_by, local_transaction_id, property_address, status, version)
  VALUES (:'SP', :'ORG', :'A', 't1', 'Fixture Street 1', 'needs_changes', 0);
UPDATE public.transaction_submissions SET parent_submission_id = :'SP', version = 2 WHERE id = :'S';
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
SELECT pg_temp.ok((r->>'status') = 'resubmitted', 'C7 ' || r::text) FROM (SELECT public.finalize_submission(:'S', pg_temp.mf()) r) x;
