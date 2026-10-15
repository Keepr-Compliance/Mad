-- Control (3): Team plan with plan_features.unlimited_transactions=true stays on
-- regardless of date: no override, an expired Stripe override, a malformed one.
SELECT pg_temp.check3('team, no override -> plan on', pg_temp.id('u_team'), pg_temp.id('t_org'), 'unlimited_transactions', 'OK true/plan');
SELECT pg_temp.set_override(pg_temp.id('t_org'), 'unlimited_transactions',
  '{"enabled": true, "paid_through": "2020-01-01T00:00:00Z", "source": "stripe"}');
SELECT pg_temp.check3('team, expired override -> plan on', pg_temp.id('u_team'), pg_temp.id('t_org'), 'unlimited_transactions', 'OK true/plan');
SELECT pg_temp.set_override(pg_temp.id('t_org'), 'unlimited_transactions', '{"enabled": true, "paid_through": "soon"}');
SELECT pg_temp.check3('team, malformed override -> plan on', pg_temp.id('u_team'), pg_temp.id('t_org'), 'unlimited_transactions', 'OK true/plan');
