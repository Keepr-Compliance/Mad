-- X2b: broker UPDATE submitted to needs_changes: allowed
UPDATE public.transaction_submissions SET status = 'submitted' WHERE id = :'S';
SELECT pg_temp.claims(:'K'); SET LOCAL ROLE authenticated;
UPDATE public.transaction_submissions SET status = 'needs_changes' WHERE id = :'S';
RESET ROLE;
SELECT pg_temp.ok((SELECT status FROM public.transaction_submissions WHERE id = :'S') = 'needs_changes', 'X2b');
