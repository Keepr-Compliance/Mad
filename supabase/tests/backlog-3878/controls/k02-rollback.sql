-- harness: rollback
-- K2: the rollback removes the trigger and its function and leaves the 3846 regrant trigger.
SELECT pg_temp.check('rollback succeeds', pg_temp.step_ok('rollback'), pg_temp.step_err('rollback'));
SELECT pg_temp.check('trigger and function gone', NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'billing_pause_resume_on_licence_status')
  AND to_regprocedure('public._billing_on_licence_suspension()') IS NULL);
SELECT pg_temp.check('3846 regrant trigger kept', EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.licenses'::regclass AND tgname = 'billing_regrant_on_unsuspend'));
SELECT pg_temp.suspend_test_user();
SELECT pg_temp.check('suspension enqueues nothing after the rollback', NOT EXISTS (SELECT 1 FROM public.billing_outbox));
