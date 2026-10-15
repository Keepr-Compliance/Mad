-- billing_subscriptions: one open subscription per user per mode in the DB;
-- clients read their own rows and write nothing.
INSERT INTO public.billing_subscriptions (stripe_mode, user_id, organization_id, stripe_customer_id, stripe_subscription_id, status, "interval")
VALUES ('live', pg_temp.id('u_live'), pg_temp.porg('u_live'), 'cus_FX3845live', 'sub_FX3845l1', 'active', 'month');
SELECT pg_temp.check('second open live subscription for the same user -> 23505', r LIKE 'ERR 23505 %', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.billing_subscriptions (stripe_mode, user_id, stripe_customer_id, stripe_subscription_id, status) VALUES (''live'', ''{u_live}'', ''cus_FX3845live'', ''sub_FX3845l2'', ''incomplete'')') r) s;
SELECT pg_temp.check('a canceled one alongside -> allowed', r = 'OK <null>', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.billing_subscriptions (stripe_mode, user_id, stripe_customer_id, stripe_subscription_id, status) VALUES (''live'', ''{u_live}'', ''cus_FX3845live'', ''sub_FX3845l3'', ''canceled'')') r) s;
SELECT pg_temp.check('open test subscription for an is_test user alongside a live one -> allowed', r = 'OK <null>', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.billing_subscriptions (stripe_mode, user_id, stripe_customer_id, stripe_subscription_id, status) VALUES (''live'', ''{u_test}'', ''cus_FX3845tl'', ''sub_FX3845t1'', ''active''), (''test'', ''{u_test}'', ''cus_FX3845tt'', ''sub_FX3845t2'', ''active'')') r) s;
SELECT pg_temp.check('client reads only its own rows', r = 'OK 2', r)
  FROM (SELECT pg_temp.as_role('authenticated', pg_temp.id('u_live'), 'SELECT count(*) FROM public.billing_subscriptions') r) s;
SELECT pg_temp.check('client cannot insert', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.as_role('authenticated', pg_temp.id('u_live'), 'INSERT INTO public.billing_subscriptions (stripe_mode, user_id, stripe_customer_id, stripe_subscription_id, status) VALUES (''live'', ''{u_live}'', ''c'', ''sub_FX3845x'', ''canceled'')') r) s;
SELECT pg_temp.check('client cannot update', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.as_role('authenticated', pg_temp.id('u_live'), 'UPDATE public.billing_subscriptions SET status = ''active''') r) s;
SELECT pg_temp.check('anon reads nothing', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.as_role('anon', NULL, 'SELECT count(*) FROM public.billing_subscriptions') r) s;
SELECT pg_temp.check('client cannot read the outbox', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.as_role('authenticated', pg_temp.id('u_live'), 'SELECT count(*) FROM public.billing_outbox') r) s;
