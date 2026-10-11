-- billing_outbox_claim: one mode only, due rows only, leased (a second claim
-- inside the lease returns nothing), attempts counted.
INSERT INTO public.billing_outbox (stripe_mode, kind, user_id, dedupe_key, run_after, processed_at) VALUES
  ('live', 'fx', pg_temp.id('u_live'), 'fx-due-1',     now() - interval '1 minute', NULL),
  ('live', 'fx', pg_temp.id('u_live'), 'fx-due-2',     now() - interval '2 minute', NULL),
  ('live', 'fx', pg_temp.id('u_live'), 'fx-future',    now() + interval '1 hour',   NULL),
  ('live', 'fx', pg_temp.id('u_live'), 'fx-done',      now() - interval '1 hour',   now()),
  ('test', 'fx', pg_temp.id('u_test'), 'fx-test-mode', now() - interval '1 minute', NULL);
SELECT pg_temp.check('first live claim takes the two due live rows', r = 'OK fx-due-1,fx-due-2', r)
  FROM (SELECT pg_temp.try('SELECT string_agg(dedupe_key, '','' ORDER BY dedupe_key) FROM public.billing_outbox_claim(''live'', 10)') r) s;
SELECT pg_temp.check('claimed rows leased and counted',
  (SELECT bool_and(claimed_until > now() AND attempts = 1) FROM public.billing_outbox WHERE dedupe_key IN ('fx-due-1', 'fx-due-2')));
SELECT pg_temp.check('second live claim inside the lease returns nothing', r = 'OK <null>', r)
  FROM (SELECT pg_temp.try('SELECT string_agg(dedupe_key, '','') FROM public.billing_outbox_claim(''live'', 10)') r) s;
UPDATE public.billing_outbox SET claimed_until = now() - interval '1 second' WHERE dedupe_key = 'fx-due-1';
SELECT pg_temp.check('expired lease is claimable again', r = 'OK fx-due-1', r)
  FROM (SELECT pg_temp.try('SELECT string_agg(dedupe_key, '','') FROM public.billing_outbox_claim(''live'', 10)') r) s;
SELECT pg_temp.check('test claim takes only the test row', r = 'OK fx-test-mode', r)
  FROM (SELECT pg_temp.try('SELECT string_agg(dedupe_key, '','') FROM public.billing_outbox_claim(''test'', 10)') r) s;
UPDATE public.billing_outbox SET claimed_until = NULL;
SELECT pg_temp.check('limit respected', r = 'OK 1', r)
  FROM (SELECT pg_temp.try('SELECT count(*) FROM public.billing_outbox_claim(''live'', 1)') r) s;
SELECT pg_temp.check('invalid mode -> 22023', r LIKE 'ERR 22023 %', r)
  FROM (SELECT pg_temp.try('SELECT count(*) FROM public.billing_outbox_claim(''prod'', 1)') r) s;
SELECT pg_temp.check('duplicate dedupe_key -> 23505', r LIKE 'ERR 23505 %', r)
  FROM (SELECT pg_temp.try('INSERT INTO public.billing_outbox (stripe_mode, kind, user_id, dedupe_key) VALUES (''live'', ''fx'', ''{u_live}'', ''fx-due-1'')') r) s;
