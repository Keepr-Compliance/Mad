-- harness: apply-twice
-- C5: a second apply changes nothing: five rows total, one open.
SELECT pg_temp.check('c5 total rows after two applies = 5', count(*) = 5, 'rows=' || count(*))
FROM public.credit_pricing_tiers;
SELECT pg_temp.check('c5 open rows after two applies = 1', count(*) = 1, 'open=' || count(*))
FROM public.credit_pricing_tiers WHERE scope = 'individual' AND effective_to IS NULL;
