-- harness: drift
-- harness: expect-raise
-- k5a: with a non-empty cohort and a changed function body the migration
-- raises before writing.
SELECT pg_temp.check('k5a migration raised on body drift', pg_temp.step_ok('apply1') = false
  AND pg_temp.step_err('apply1') LIKE '%BACKLOG-3858: _ensure_personal_organization_for body changed%', pg_temp.step_err('apply1'));
SELECT pg_temp.check('k5a nothing written', pg_temp.snapshot('after1') = pg_temp.snapshot('pre'),
  pg_temp.diff(pg_temp.snapshot('pre'), pg_temp.snapshot('after1')));
