-- P1: parent insert retried ON CONFLICT (id) DO NOTHING as the agent: no error, 1 row
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
INSERT INTO public.transaction_submissions (id, organization_id, submitted_by, local_transaction_id, property_address, status, version)
  VALUES (:'S', :'ORG', :'A', 't1', 'Fixture Street 1', 'uploading', 1) ON CONFLICT (id) DO NOTHING;
RESET ROLE;
SELECT pg_temp.ok((SELECT count(*) FROM public.transaction_submissions WHERE id = :'S') = 1, 'P1');
