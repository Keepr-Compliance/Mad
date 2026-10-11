-- harness: apply-twice
SELECT pg_temp.check('second apply succeeds', pg_temp.step_ok('apply2'), pg_temp.step_err('apply2'));
SELECT pg_temp.check('second apply changes nothing', pg_temp.snapshot('after1') = pg_temp.snapshot('after2'),
  pg_temp.diff(pg_temp.snapshot('after1'), pg_temp.snapshot('after2')));
SELECT pg_temp.set_override(pg_temp.porg('u_live'), 'unlimited_transactions', '{"enabled": true, "paid_through": "2020-01-01T00:00:00Z"}');
SELECT pg_temp.check3('resolvers still enforce paid_through after second apply', pg_temp.id('u_live'), pg_temp.porg('u_live'), 'unlimited_transactions', 'OK false/plan');
