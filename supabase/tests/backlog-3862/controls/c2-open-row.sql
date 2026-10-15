-- C2: exactly one open individual row, and it is the flat band; it starts the
-- instant the old bands end (no gap).
SELECT pg_temp.check('c2 exactly one open individual row', count(*) = 1, 'open=' || count(*))
FROM public.credit_pricing_tiers WHERE scope = 'individual' AND effective_to IS NULL;
SELECT pg_temp.check('c2 open row is 1..NULL at 1499 usd',
  count(*) = 1, 'matching=' || count(*))
FROM public.credit_pricing_tiers
WHERE scope = 'individual' AND effective_to IS NULL
  AND min_units = 1 AND max_units IS NULL AND unit_price_cents = 1499 AND currency = 'usd';
SELECT pg_temp.check('c2 old bands end when the flat band starts',
  (SELECT bool_and(o.effective_to = f.effective_from)
     FROM public.credit_pricing_tiers o
    WHERE o.id IN (pg_temp.id('t_1499'), pg_temp.id('t_1300'), pg_temp.id('t_1200'), pg_temp.id('t_1100'))),
  NULL)
FROM public.credit_pricing_tiers f
WHERE f.scope = 'individual' AND f.effective_to IS NULL
LIMIT 1;
SELECT pg_temp.check('c2 open row present for gap check', count(*) >= 1, NULL)
FROM public.credit_pricing_tiers WHERE scope = 'individual' AND effective_to IS NULL;
