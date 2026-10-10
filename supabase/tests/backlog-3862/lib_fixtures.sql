-- BACKLOG-3862 fixtures. Runs as postgres inside the harness transaction,
-- BEFORE the migration.
--
-- Pricing rows TRANSCRIBED from production (read-only, 2026-10-10):
--   SELECT id, min_units, max_units, unit_price_cents, currency, scope,
--          effective_from, effective_to, metadata, created_at
--     FROM public.credit_pricing_tiers ORDER BY scope, min_units;
-- returned exactly four rows, all scope 'individual', currency 'usd',
-- effective_from = created_at = 2026-07-15 04:52:19.426793+00,
-- effective_to NULL, metadata {}:
--   [1..3] 1499 · [4..10] 1300 · [11..25] 1200 · [26..NULL] 1100
-- Production ids are replaced by derived ids; the migration never names an id.
-- The test venue's table starts empty; anything already there is cleared
-- inside this transaction so the run sees exactly production's shape.
DELETE FROM public.credit_pricing_tiers;
INSERT INTO public.credit_pricing_tiers
  (id, min_units, max_units, unit_price_cents, currency, scope, effective_from, effective_to, metadata, created_at)
VALUES
  (pg_temp.id('t_1499'),  1,    3, 1499, 'usd', 'individual', '2026-07-15 04:52:19.426793+00', NULL, '{}', '2026-07-15 04:52:19.426793+00'),
  (pg_temp.id('t_1300'),  4,   10, 1300, 'usd', 'individual', '2026-07-15 04:52:19.426793+00', NULL, '{}', '2026-07-15 04:52:19.426793+00'),
  (pg_temp.id('t_1200'), 11,   25, 1200, 'usd', 'individual', '2026-07-15 04:52:19.426793+00', NULL, '{}', '2026-07-15 04:52:19.426793+00'),
  (pg_temp.id('t_1100'), 26, NULL, 1100, 'usd', 'individual', '2026-07-15 04:52:19.426793+00', NULL, '{}', '2026-07-15 04:52:19.426793+00');

-- Synthetic users holding 0, 3, 10 and 25 tier-counting unlocks this year,
-- so their next unlock is unit 1, 4, 11 and 26.
INSERT INTO auth.users (id, email, aud, role) VALUES
 (pg_temp.id('u_n0'),  'n0-3862@example.test',  'authenticated', 'authenticated'),
 (pg_temp.id('u_n3'),  'n3-3862@example.test',  'authenticated', 'authenticated'),
 (pg_temp.id('u_n10'), 'n10-3862@example.test', 'authenticated', 'authenticated'),
 (pg_temp.id('u_n25'), 'n25-3862@example.test', 'authenticated', 'authenticated');
INSERT INTO public.transaction_unlocks (user_id, local_transaction_id, funding_source, counts_toward_tier, unlocked_at)
SELECT pg_temp.id('u_n' || n), 'tx-3862-' || n || '-' || i, 'purchase', true, now()
  FROM unnest(ARRAY[3, 10, 25]) n, generate_series(1, n) i;
