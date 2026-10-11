-- Boundary (now() is constant inside the transaction): paid_through = now() is
-- expired; now() + 1 s is effective. Values written exactly as the grant RPC
-- writes them (to_jsonb(timestamptz)).
SELECT pg_temp.set_override(pg_temp.porg('u_live'), 'unlimited_transactions',
  jsonb_build_object('enabled', true, 'paid_through', to_jsonb(now()), 'source', 'stripe'));
SELECT pg_temp.check3('paid_through = now() -> expired', pg_temp.id('u_live'), pg_temp.porg('u_live'), 'unlimited_transactions', 'OK false/plan');
SELECT pg_temp.set_override(pg_temp.porg('u_live'), 'unlimited_transactions',
  jsonb_build_object('enabled', true, 'paid_through', to_jsonb(now() + interval '1 second'), 'source', 'stripe'));
SELECT pg_temp.check3('paid_through = now() + 1 s -> effective', pg_temp.id('u_live'), pg_temp.porg('u_live'), 'unlimited_transactions', 'OK true/override');
SELECT pg_temp.set_override(pg_temp.porg('u_live'), 'unlimited_transactions',
  jsonb_build_object('enabled', true, 'paid_through', to_jsonb(now() - interval '1 second'), 'source', 'stripe'));
SELECT pg_temp.check3('paid_through = now() - 1 s -> expired', pg_temp.id('u_live'), pg_temp.porg('u_live'), 'unlimited_transactions', 'OK false/plan');
