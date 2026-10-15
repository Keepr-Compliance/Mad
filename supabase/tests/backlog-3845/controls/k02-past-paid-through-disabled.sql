-- Control (2): a past paid_through disables the override in ALL THREE resolvers
-- (falls through to the Individual plan's unlimited=false). A future one keeps it.
SELECT pg_temp.set_override(pg_temp.porg('u_live'), 'unlimited_transactions',
  '{"enabled": true, "paid_through": "2020-01-01T00:00:00Z", "source": "stripe"}');
SELECT pg_temp.check3('past paid_through -> plan answer', pg_temp.id('u_live'), pg_temp.porg('u_live'), 'unlimited_transactions', 'OK false/plan');
SELECT pg_temp.set_override(pg_temp.porg('u_live'), 'unlimited_transactions',
  '{"enabled": true, "paid_through": "2098-01-01T00:00:00Z", "source": "stripe"}');
SELECT pg_temp.check3('future paid_through -> override', pg_temp.id('u_live'), pg_temp.porg('u_live'), 'unlimited_transactions', 'OK true/override');
