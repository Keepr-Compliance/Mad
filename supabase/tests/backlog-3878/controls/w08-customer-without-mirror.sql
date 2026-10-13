-- W8 (SR R6): a customer row and NO mirror row (the webhook has not landed yet) -> a pause row anyway.
DELETE FROM public.billing_subscriptions WHERE user_id = pg_temp.id('u_test');
SELECT pg_temp.suspend_test_user();
SELECT pg_temp.check('one pause row with no mirror row', pg_temp.ob('u_test', 'pause_agent_subscription') = 1, pg_temp.ob_all('u_test'));
