-- W13: a user with a customer in each mode -> one row per mode (the drain of each mode runs its own).
INSERT INTO public.stripe_customers (user_id, stripe_customer_id, stripe_mode) VALUES (pg_temp.id('u_test'), 'cus_FX3878live', 'live');
SELECT pg_temp.suspend_test_user();
SELECT pg_temp.check('pause rows: one test, one live',
  (SELECT array_agg(stripe_mode ORDER BY stripe_mode) = ARRAY['live', 'test'] FROM public.billing_outbox
    WHERE user_id = pg_temp.id('u_test') AND kind = 'pause_agent_subscription'), pg_temp.ob_all('u_test'));
-- u_live (live customer only, from the 3845 fixtures) -> one live row.
SELECT pg_temp.admin_ok('SELECT public.admin_suspend_user(''{u_live}'', ''fixture'')::text');
SELECT pg_temp.check('u_live: one live pause row', (SELECT count(*) = 1 AND bool_and(stripe_mode = 'live') FROM public.billing_outbox
  WHERE user_id = pg_temp.id('u_live') AND kind = 'pause_agent_subscription'), pg_temp.ob_all('u_live'));
