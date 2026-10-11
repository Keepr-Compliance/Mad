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
