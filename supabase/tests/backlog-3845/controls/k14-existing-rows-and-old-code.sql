-- Expand step (SR ruling 1): the rows that existed before the migration read
-- 'live'; an insert written the way today's production code writes it (no
-- stripe_mode) still succeeds and is 'live'; the PK lets an is_test user hold
-- one customer per mode.
SELECT pg_temp.check('pre-existing customer row backfilled live', r = 'OK live', r)
  FROM (SELECT pg_temp.try('SELECT stripe_mode FROM public.stripe_customers WHERE user_id = ''{u_live}''') r) s;
SELECT pg_temp.check('pre-existing payment_intents row backfilled live', r = 'OK live', r)
  FROM (SELECT pg_temp.try('SELECT string_agg(DISTINCT stripe_mode, '','') FROM public.payment_intents WHERE user_id = ''{u_live}''') r) s;
SELECT pg_temp.check('old-code customer insert (no stripe_mode) -> live', r = 'OK live', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.stripe_customers (user_id, stripe_customer_id) VALUES (''{u_susp}'', ''cus_FX3845old'') RETURNING stripe_mode') r) s;
SELECT pg_temp.check('old-code payment_intents insert (no stripe_mode) -> live', r = 'OK live', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.payment_intents (user_id, local_transaction_id, stripe_checkout_session_id, quoted_unit_price_cents, status) VALUES (''{u_susp}'', ''tx-fx-old'', ''cs_live_FX3845old'', 1499, ''created'') RETURNING stripe_mode') r) s;
SELECT pg_temp.check('second live customer row for the same user -> 23505', r LIKE 'ERR 23505 %', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.stripe_customers (user_id, stripe_customer_id, stripe_mode) VALUES (''{u_live}'', ''cus_FX3845dup'', ''live'')') r) s;
SELECT pg_temp.check('is_test user: one live + one test customer row -> allowed', r = 'OK <null>', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.stripe_customers (user_id, stripe_customer_id, stripe_mode) VALUES (''{u_test}'', ''cus_FX3845m1'', ''live''), (''{u_test}'', ''cus_FX3845m2'', ''test'')') r) s;
SELECT pg_temp.check('invalid stripe_mode -> 23514', r LIKE 'ERR 23514 %', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.payment_intents (user_id, local_transaction_id, quoted_unit_price_cents, status, stripe_mode) VALUES (''{u_live}'', ''tx-fx-bad'', 1499, ''created'', ''LIVE'')') r) s;
