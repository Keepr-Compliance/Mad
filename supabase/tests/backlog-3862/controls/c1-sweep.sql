-- C1: every unit 1..100 is priced by exactly one open band, at 1499.
-- Original rows are ended, not deleted.
SELECT pg_temp.check('c1 units 1..100 each match exactly one open 1499 band',
  bad = 0, 'units not matching exactly one=' || bad)
FROM (SELECT count(*) AS bad FROM generate_series(1, 100) k
       WHERE (SELECT count(*) FROM public.credit_pricing_tiers t
               WHERE t.scope = 'individual' AND t.effective_to IS NULL
                 AND k >= t.min_units AND (k <= t.max_units OR t.max_units IS NULL)
                 AND t.unit_price_cents = 1499) <> 1) s;
SELECT pg_temp.check('c1 units 1..100 match no open band at another price',
  bad = 0, 'units with a non-1499 open band=' || bad)
FROM (SELECT count(*) AS bad FROM generate_series(1, 100) k
       WHERE EXISTS (SELECT 1 FROM public.credit_pricing_tiers t
               WHERE t.scope = 'individual' AND t.effective_to IS NULL
                 AND k >= t.min_units AND (k <= t.max_units OR t.max_units IS NULL)
                 AND t.unit_price_cents <> 1499)) s;
SELECT pg_temp.check('c1 four original rows still exist and are ended',
  count(*) = 4 AND bool_and(effective_to IS NOT NULL), 'rows=' || count(*) || ' ended=' || count(effective_to))
FROM public.credit_pricing_tiers
WHERE id IN (pg_temp.id('t_1499'), pg_temp.id('t_1300'), pg_temp.id('t_1200'), pg_temp.id('t_1100'));
