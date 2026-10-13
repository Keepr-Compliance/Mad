-- W16 (C9 / SR R9): reinstatement with the mirror row paused = true -> the 3846 regrant grants
-- nothing; the resume row is the only thing that happens (its charge grants through invoice.paid).
SELECT pg_temp.suspend_test_user();
UPDATE public.billing_subscriptions SET paused = true WHERE user_id = pg_temp.id('u_test');
SELECT pg_temp.admin_ok('SELECT public.admin_unsuspend_user(''{u_test}'')::text');
SELECT pg_temp.check('paused mirror: no grant, one resume row', pg_temp.unlimited('u_test') IS NULL
  AND pg_temp.ob('u_test', 'resume_agent_subscription') = 1, coalesce(pg_temp.unlimited('u_test')::text, '<none>') || ' ' || pg_temp.ob_all('u_test'));
-- Second cycle with the mirror paused = false (the pause row never drained): the regrant grants
-- once, and the resume row is still written (its handler then reads "not paused" in Stripe and
-- makes no call: jest, resume_agent_subscription 'not paused -> no update').
UPDATE public.billing_subscriptions SET paused = false WHERE user_id = pg_temp.id('u_test');
SELECT pg_temp.suspend_test_user();
SELECT pg_temp.admin_ok('SELECT public.admin_unsuspend_user(''{u_test}'')::text');
SELECT pg_temp.check('unpaused mirror: re-granted to cpe + 2 h, two resume rows', pg_temp.unlimited('u_test') = pg_temp.expected_grant('u_test')
  AND pg_temp.ob('u_test', 'resume_agent_subscription') = 2, coalesce(pg_temp.unlimited('u_test')::text, '<none>') || ' ' || pg_temp.ob_all('u_test'));
