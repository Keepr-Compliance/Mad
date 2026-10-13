-- SR ruling req. 4: a user holding a test and a live stripe_customers row sees
-- exactly the live row through the client select (the desktop's maybeSingle()
-- read, electron/services/paymentService.ts). payment_intents select unchanged.
SELECT pg_temp.check('fixture: is_test user holds a live and a test customer row', r = 'OK <null>', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.stripe_customers (user_id, stripe_customer_id, stripe_mode) VALUES (''{u_test}'', ''cus_FX3845tl'', ''live''), (''{u_test}'', ''cus_FX3845tt'', ''test'')') r) s;
SELECT pg_temp.check('client sees exactly the live customer row', r = 'OK 1:cus_FX3845tl', r)
  FROM (SELECT pg_temp.as_role('authenticated', pg_temp.id('u_test'),
    'SELECT count(*) || '':'' || max(stripe_customer_id) FROM public.stripe_customers') r) s;
SELECT pg_temp.check('service role sees both rows', (SELECT count(*) FROM public.stripe_customers WHERE user_id = pg_temp.id('u_test')) = 2);
SELECT pg_temp.check('client still sees no other user''s row', r = 'OK 0', r)
  FROM (SELECT pg_temp.as_role('authenticated', pg_temp.id('u_test'),
    'SELECT count(*) FROM public.stripe_customers WHERE user_id = ''{u_live}''') r) s;
SELECT pg_temp.try('INSERT INTO public.payment_intents (user_id, local_transaction_id, stripe_checkout_session_id, quoted_unit_price_cents, status, stripe_mode) VALUES (''{u_test}'', ''tx-fx-a'', ''cs_test_FX3845c'', 1499, ''created'', ''test''), (''{u_test}'', ''tx-fx-b'', ''cs_live_FX3845c'', 1499, ''created'', ''live'')');
SELECT pg_temp.check('payment_intents client select unchanged (both modes)', r = 'OK 2', r)
  FROM (SELECT pg_temp.as_role('authenticated', pg_temp.id('u_test'), 'SELECT count(*) FROM public.payment_intents') r) s;
