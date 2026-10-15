-- BACKLOG-3862: flat pay-as-you-go price.
-- Ends every open individual pricing band except a flat 1..unlimited band at
-- 1499 usd, opens that flat band if none is open, then asserts the result.
-- Data only. No DELETE: other tables reference tier rows by id, and ended rows
-- keep describing the price they were quoted at. Idempotent: a second run
-- updates nothing, inserts nothing, and passes the assertion.

-- End every open individual band that is not already the flat band.
UPDATE public.credit_pricing_tiers
   SET effective_to = now()
 WHERE scope = 'individual'
   AND effective_to IS NULL
   AND NOT (min_units = 1 AND max_units IS NULL AND unit_price_cents = 1499 AND currency = 'usd');

-- Open one flat band, only if none is open.
INSERT INTO public.credit_pricing_tiers (min_units, max_units, unit_price_cents, currency, scope, metadata)
SELECT 1, NULL, 1499, 'usd', 'individual', '{"backlog":"BACKLOG-3862","note":"flat PAYG price"}'::jsonb
 WHERE NOT EXISTS (SELECT 1 FROM public.credit_pricing_tiers
                    WHERE scope = 'individual' AND effective_to IS NULL);

-- Fail the migration unless the result is exactly one flat open band.
DO $$
DECLARE v_n int; v_bad int;
BEGIN
  SELECT count(*) INTO v_n FROM public.credit_pricing_tiers WHERE scope = 'individual' AND effective_to IS NULL;
  SELECT count(*) INTO v_bad FROM generate_series(1, 100) k
   WHERE (SELECT count(*) FROM public.credit_pricing_tiers t
           WHERE t.scope = 'individual' AND t.effective_to IS NULL
             AND k >= t.min_units AND (k <= t.max_units OR t.max_units IS NULL)
             AND t.unit_price_cents = 1499) <> 1;
  IF v_n <> 1 OR v_bad <> 0 THEN
    RAISE EXCEPTION '3862: expected one open 1499 band covering units 1..100 (open=%, bad units=%)', v_n, v_bad;
  END IF;
END $$;
