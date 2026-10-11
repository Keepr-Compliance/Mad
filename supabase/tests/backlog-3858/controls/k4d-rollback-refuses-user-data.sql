-- harness: rollback
-- harness: pre-rollback: INSERT INTO public.checklist_templates (organization_id, name, sort_order, created_by, owner_user_id) VALUES (pg_temp.porg('c_ind1'), 'User written 3858', 1, pg_temp.id('c_ind1'), pg_temp.id('c_ind1'));
-- harness: pre-rollback: INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address) VALUES (pg_temp.porg('c_ind2'), pg_temp.id('c_ind2'), 'fx-3858', '1 Fixture Way');
-- k4d: user data on a created org (a user-written checklist template on one, a
-- transaction submission on another; both tables cascade from organizations)
-- makes the rollback refuse, naming both, and delete nothing (p1 probe of the SR review).
SELECT pg_temp.check('k4d rollback refused', pg_temp.step_ok('rollback') = false
  AND pg_temp.step_err('rollback') LIKE '%rollback refused%'
  AND pg_temp.step_err('rollback') LIKE '%checklist template not an untouched seeded one%'
  AND pg_temp.step_err('rollback') LIKE '%1 row(s) in transaction_submissions%', pg_temp.step_err('rollback'));
SELECT pg_temp.check('k4d user template and submission remain',
  EXISTS (SELECT 1 FROM public.checklist_templates WHERE organization_id = pg_temp.porg('c_ind1') AND name = 'User written 3858')
  AND EXISTS (SELECT 1 FROM public.transaction_submissions WHERE organization_id = pg_temp.porg('c_ind2') AND local_transaction_id = 'fx-3858'));
SELECT pg_temp.check('k4d all four created orgs and the bookkeeping rows remain',
  jsonb_array_length(pg_temp.state()->'backfill') = 4
  AND pg_temp.porg('c_ind1') IS NOT NULL AND pg_temp.porg('c_ind2') IS NOT NULL
  AND pg_temp.porg('c_team') IS NOT NULL AND pg_temp.porg('c_expinv') IS NOT NULL);
