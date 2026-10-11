-- C-8a / D7: stripe_mode='test' rows need an is_test organization; NULL is_test
-- (no personal org) is refused; 'live' is never refused by the trigger.
SELECT pg_temp.check('stripe_customers test row, non-test user -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.stripe_customers (user_id, stripe_customer_id, stripe_mode) VALUES (''{u_live}'', ''cus_FX3845t1'', ''test'')') r) s;
SELECT pg_temp.check('stripe_customers test row, user with no personal org -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.stripe_customers (user_id, stripe_customer_id, stripe_mode) VALUES (''{u_noorg}'', ''cus_FX3845t2'', ''test'')') r) s;
SELECT pg_temp.check('stripe_customers test row, is_test user -> allowed', r = 'OK <null>', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.stripe_customers (user_id, stripe_customer_id, stripe_mode) VALUES (''{u_test}'', ''cus_FX3845t3'', ''test'')') r) s;
SELECT pg_temp.check('stripe_customers live row, user with no personal org -> allowed', r = 'OK <null>', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.stripe_customers (user_id, stripe_customer_id, stripe_mode) VALUES (''{u_noorg}'', ''cus_FX3845l2'', ''live'')') r) s;
SELECT pg_temp.check('stripe_customers UPDATE live -> test, non-test user -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.try('UPDATE public.stripe_customers SET stripe_mode = ''test'' WHERE user_id = ''{u_live}''') r) s;
SELECT pg_temp.check('payment_intents test row, non-test user -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.payment_intents (user_id, local_transaction_id, stripe_checkout_session_id, quoted_unit_price_cents, status, stripe_mode) VALUES (''{u_live}'', ''tx-fx-1'', ''cs_test_FX3845a'', 1499, ''created'', ''test'')') r) s;
SELECT pg_temp.check('payment_intents test row, is_test user -> allowed', r = 'OK <null>', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.payment_intents (user_id, local_transaction_id, stripe_checkout_session_id, quoted_unit_price_cents, status, stripe_mode) VALUES (''{u_test}'', ''tx-fx-2'', ''cs_test_FX3845b'', 1499, ''created'', ''test'')') r) s;
-- Tables with organization_id: the row's org decides when it is set.
SELECT pg_temp.check('billing_subscriptions test row, non-test user, no org -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.billing_subscriptions (stripe_mode, user_id, stripe_customer_id, stripe_subscription_id, status) VALUES (''test'', ''{u_live}'', ''cus_FX3845x'', ''sub_FX3845a'', ''active'')') r) s;
SELECT pg_temp.check('billing_subscriptions test row, org is_test -> allowed', r = 'OK <null>', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.billing_subscriptions (stripe_mode, user_id, organization_id, stripe_customer_id, stripe_subscription_id, status) VALUES (''test'', ''{u_live}'', ''{x_org}'', ''cus_FX3845x'', ''sub_FX3845b'', ''active'')') r) s;
SELECT pg_temp.check('billing_subscriptions test row, is_test user but non-test org -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.billing_subscriptions (stripe_mode, user_id, organization_id, stripe_customer_id, stripe_subscription_id, status) VALUES (''test'', ''{u_test}'', ''{t_org}'', ''cus_FX3845y'', ''sub_FX3845c'', ''active'')') r) s;
SELECT pg_temp.check('billing_outbox test job for a non-test org -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key) VALUES (''test'', ''fx'', ''{t_org}'', ''fx-3845-1'')') r) s;
SELECT pg_temp.check('billing_outbox test job for an is_test org -> allowed', r = 'OK <null>', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key) VALUES (''test'', ''fx'', ''{x_org}'', ''fx-3845-2'')') r) s;
-- UPDATE path (R1; re-point probes reuse the test rows inserted above: cus_FX3845t3, sub_FX3845b): flipping a row to 'test', or re-pointing a test row at a non-test subject, is refused.
SELECT pg_temp.check('stripe_customers UPDATE user_id of a test row onto a non-test user -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.try('UPDATE public.stripe_customers SET user_id = ''{u_live}'' WHERE stripe_customer_id = ''cus_FX3845t3''') r) s;
SELECT pg_temp.check('payment_intents UPDATE live -> test, non-test user -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.try('UPDATE public.payment_intents SET stripe_mode = ''test'' WHERE user_id = ''{u_live}''') r) s;
SELECT pg_temp.check('payment_intents test row for is_test user (setup for re-point)', r = 'OK <null>', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.payment_intents (user_id, local_transaction_id, stripe_checkout_session_id, quoted_unit_price_cents, status, stripe_mode) VALUES (''{u_test}'', ''tx-fx-3'', ''cs_test_FX3845c'', 1499, ''created'', ''test'')') r) s;
SELECT pg_temp.check('payment_intents UPDATE user_id of a test row onto a non-test user -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.try('UPDATE public.payment_intents SET user_id = ''{u_live}'' WHERE stripe_checkout_session_id = ''cs_test_FX3845c''') r) s;
SELECT pg_temp.check('billing_subscriptions live row for non-test user (setup)', r = 'OK <null>', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.billing_subscriptions (stripe_mode, user_id, stripe_customer_id, stripe_subscription_id, status) VALUES (''live'', ''{u_live}'', ''cus_FX3845z'', ''sub_FX3845l'', ''active'')') r) s;
SELECT pg_temp.check('billing_subscriptions UPDATE live -> test, non-test user -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.try('UPDATE public.billing_subscriptions SET stripe_mode = ''test'' WHERE stripe_subscription_id = ''sub_FX3845l''') r) s;
SELECT pg_temp.check('billing_subscriptions UPDATE organization_id of a test row onto a non-test org -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.try('UPDATE public.billing_subscriptions SET organization_id = ''{t_org}'' WHERE stripe_subscription_id = ''sub_FX3845b''') r) s;
SELECT pg_temp.check('billing_subscriptions test row for is_test user, no org (setup for re-point)', r = 'OK <null>', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.billing_subscriptions (stripe_mode, user_id, stripe_customer_id, stripe_subscription_id, status) VALUES (''test'', ''{u_test}'', ''cus_FX3845v'', ''sub_FX3845e'', ''active'')') r) s;
SELECT pg_temp.check('billing_subscriptions UPDATE user_id of a test row onto a non-test user -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.try('UPDATE public.billing_subscriptions SET user_id = ''{u_live}'' WHERE stripe_subscription_id = ''sub_FX3845e''') r) s;
SELECT pg_temp.check('billing_outbox live job for non-test user (setup)', r = 'OK <null>', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.billing_outbox (stripe_mode, kind, user_id, dedupe_key) VALUES (''live'', ''fx'', ''{u_live}'', ''fx-3845-l'')') r) s;
SELECT pg_temp.check('billing_outbox UPDATE live -> test, non-test user -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.try('UPDATE public.billing_outbox SET stripe_mode = ''test'' WHERE dedupe_key = ''fx-3845-l''') r) s;
SELECT pg_temp.check('billing_outbox test job for is_test org (setup for re-point)', r = 'OK <null>', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key) VALUES (''test'', ''fx'', ''{x_org}'', ''fx-3845-3'')') r) s;
SELECT pg_temp.check('billing_outbox UPDATE organization_id of a test job onto a non-test org -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.try('UPDATE public.billing_outbox SET organization_id = ''{t_org}'' WHERE dedupe_key = ''fx-3845-3''') r) s;
SELECT pg_temp.check('billing_outbox test job for is_test user, no org (setup for re-point)', r = 'OK <null>', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.billing_outbox (stripe_mode, kind, user_id, dedupe_key) VALUES (''test'', ''fx'', ''{u_test}'', ''fx-3845-4'')') r) s;
SELECT pg_temp.check('billing_outbox UPDATE user_id of a test job onto a non-test user -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.try('UPDATE public.billing_outbox SET user_id = ''{u_live}'' WHERE dedupe_key = ''fx-3845-4''') r) s;
SELECT pg_temp.check('billing_outbox UPDATE of a test job non-guarded column -> allowed', r = 'OK <null>', r)
  FROM (SELECT pg_temp.try('UPDATE public.billing_outbox SET attempts = 1 WHERE dedupe_key = ''fx-3845-4''') r) s;
