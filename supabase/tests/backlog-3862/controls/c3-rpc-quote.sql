-- C3: the real RPC get_next_unlock_quote, called as service_role for users
-- whose next unlock is unit 1, 4, 11 and 26, quotes 1499 with no next band.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true),
       set_config('request.jwt.claim.role', 'service_role', true);
CREATE TEMP TABLE t3862_q ON COMMIT DROP AS
SELECT n, q.*
  FROM unnest(ARRAY[0, 3, 10, 25]) n,
       LATERAL public.get_next_unlock_quote(pg_temp.id('u_n' || n)) q;
SELECT 'QUOTE|' || n || '|' || row_to_json(q)::text FROM (SELECT * FROM t3862_q ORDER BY n) q;
SELECT pg_temp.check('c3 one quote row per user', count(*) = 4, 'rows=' || count(*)) FROM t3862_q;
SELECT pg_temp.check('c3 unit ' || (n + 1) || ' quote',
  next_unit_index = n + 1 AND unit_price_cents = 1499 AND currency = 'usd'
    AND current_band_max_units IS NULL AND units_until_next_band IS NULL
    AND next_band_unit_price_cents IS NULL AND base_unit_price_cents = 1499,
  'unit=' || next_unit_index || ' price=' || unit_price_cents
    || ' max=' || coalesce(current_band_max_units::text, 'null')
    || ' until=' || coalesce(units_until_next_band::text, 'null')
    || ' next=' || coalesce(next_band_unit_price_cents::text, 'null')
    || ' base=' || coalesce(base_unit_price_cents::text, 'null'))
FROM unnest(ARRAY[0, 3, 10, 25]) n LEFT JOIN t3862_q USING (n);
