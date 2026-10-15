-- W7 (C8 / SR R6): no stripe_customers row -> no row, the suspension still lands. A
-- billing_subscriptions mirror row alone does not enqueue (R6 keys on the customer).
DELETE FROM public.stripe_customers WHERE user_id = pg_temp.id('u_test');
SELECT pg_temp.check('pre: u_test keeps its open mirror row', EXISTS (SELECT 1 FROM public.billing_subscriptions WHERE user_id = pg_temp.id('u_test')));
SELECT pg_temp.suspend_test_user();
SELECT pg_temp.admin_ok('SELECT public.admin_unsuspend_user(''{u_test}'')::text');
SELECT pg_temp.check('no outbox rows', NOT EXISTS (SELECT 1 FROM public.billing_outbox WHERE user_id = pg_temp.id('u_test')), pg_temp.ob_all('u_test'));
