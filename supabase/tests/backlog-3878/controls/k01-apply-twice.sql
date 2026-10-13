-- harness: apply-twice
-- K1: a second apply succeeds and leaves one trigger that still enqueues once.
SELECT pg_temp.check('second apply succeeds', pg_temp.step_ok('apply2'), pg_temp.step_err('apply2'));
SELECT pg_temp.check('one trigger', (SELECT count(*) = 1 FROM pg_trigger WHERE tgrelid = 'public.licenses'::regclass AND tgname = 'billing_pause_resume_on_licence_status'));
SELECT pg_temp.suspend_test_user();
SELECT pg_temp.check('one pause row', pg_temp.ob('u_test', 'pause_agent_subscription') = 1, pg_temp.ob_all('u_test'));
