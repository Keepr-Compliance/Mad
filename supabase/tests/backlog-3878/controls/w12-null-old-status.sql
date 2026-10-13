-- W12 (SR R9): a licence with status NULL (the column is nullable) -> suspended: one pause row.
UPDATE public.licenses SET status = NULL WHERE user_id = pg_temp.id('u_test');
SELECT pg_temp.check('no row from active -> NULL', NOT EXISTS (SELECT 1 FROM public.billing_outbox), pg_temp.ob_all('u_test'));
UPDATE public.licenses SET status = 'suspended' WHERE user_id = pg_temp.id('u_test');
SELECT pg_temp.check('NULL -> suspended: one pause row', pg_temp.ob('u_test', 'pause_agent_subscription') = 1, pg_temp.ob_all('u_test'));
