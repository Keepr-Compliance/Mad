-- harness: apply-twice
-- k4a: a second apply raises nothing and writes nothing.
SELECT pg_temp.check('k4a second apply raised nothing', pg_temp.step_ok('apply2'), pg_temp.step_err('apply2'));
SELECT pg_temp.check('k4a state after second apply = after first',
  pg_temp.snapshot('after2') = pg_temp.snapshot('after1'),
  pg_temp.diff(pg_temp.snapshot('after1'), pg_temp.snapshot('after2')));
SELECT pg_temp.check('k4a first apply wrote something', pg_temp.snapshot('after1') <> pg_temp.snapshot('pre'));
