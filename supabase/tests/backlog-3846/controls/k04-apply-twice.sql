-- harness: apply-twice
-- K4: a second apply succeeds and leaves one trigger.
SELECT pg_temp.check('second apply succeeds', pg_temp.step_ok('apply2'), pg_temp.step_err('apply2'));
SELECT pg_temp.check('one trigger', (SELECT count(*) = 1 FROM pg_trigger WHERE tgrelid = 'public.licenses'::regclass AND tgname = 'billing_regrant_on_unsuspend'));
