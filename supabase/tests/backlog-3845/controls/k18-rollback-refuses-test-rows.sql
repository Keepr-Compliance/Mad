-- harness: rollback
-- harness: expect-raise
-- harness: pre-rollback: INSERT INTO public.stripe_customers (user_id, stripe_customer_id, stripe_mode) VALUES (pg_temp.id('u_test'), 'cus_FX3845rb', 'test');
SELECT pg_temp.check('migration applied', pg_temp.step_ok('apply1'), pg_temp.step_err('apply1'));
SELECT pg_temp.check('rollback refuses while a test-mode customer row exists',
  pg_temp.step_ok('rollback') IS FALSE AND pg_temp.step_err('rollback') LIKE '%non-live stripe_customers%', pg_temp.step_err('rollback'));
