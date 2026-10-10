-- harness: pre-apply: SELECT public._ensure_personal_organization_for(pg_temp.id('c_ind1')); DELETE FROM public.organization_members WHERE user_id = pg_temp.id('c_ind1');
-- harness: expect-raise
-- k7: a cohort user for whom the function does not return 'created' (here:
-- c_ind1 already owns a personal org with no member row, so the function
-- returns 'attached'; production has 0 such users, step-0 query
-- has_personal_org = false for all 15) aborts the whole file: nothing written,
-- the user and status named in the error.
SELECT pg_temp.check('k7 migration raised, naming the user and status', pg_temp.step_ok('apply1') = false
  AND pg_temp.unsubst(pg_temp.step_err('apply1')) LIKE '%not created: {c_ind1}:attached%', pg_temp.step_err('apply1'));
SELECT pg_temp.check('k7 nothing written', pg_temp.snapshot('after1') = pg_temp.snapshot('pre'),
  pg_temp.diff(pg_temp.snapshot('pre'), pg_temp.snapshot('after1')));
