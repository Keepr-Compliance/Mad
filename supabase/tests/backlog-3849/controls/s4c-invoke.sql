-- S4c (SR R1, R11): the invoker accepts only live|test, before any vault read;
-- refuses when its URL is not configured; posts the secret header with the
-- route's timeout. The request is only queued: this transaction rolls back, so
-- nothing is ever sent. The URL below is a closed local port.
SELECT pg_temp.check('target ' || coalesce(quote_literal(t), 'NULL') || ' -> 22023', r LIKE 'ERR 22023 %', r)
  FROM unnest(ARRAY['x', 'LIVE', 'live ', '', 'test_live', NULL]) t,
       LATERAL (SELECT pg_temp.as_role(NULL, NULL, format('SELECT public.billing_drain_invoke(%L)::text', t)) r) s;
SELECT pg_temp.check('test with no URL configured -> 55000', r LIKE 'ERR 55000 %', r)
  FROM (SELECT pg_temp.as_role(NULL, NULL, $q$SELECT public.billing_drain_invoke('test')::text$q$) r) s;
SELECT vault.create_secret('http://127.0.0.1:9/billing-drain-3849', 'billing_drain_url_test', 'BACKLOG-3849 harness (rolled back)') IS NULL;
SELECT pg_temp.check('test with URL -> queued', r ~ '^OK [0-9]+$', r)
  FROM (SELECT pg_temp.as_role(NULL, NULL, $q$SELECT public.billing_drain_invoke('test')::text$q$) r) s;
SELECT pg_temp.check('live still unconfigured -> 55000 (URL is per target)', r LIKE 'ERR 55000 %', r)
  FROM (SELECT pg_temp.as_role(NULL, NULL, $q$SELECT public.billing_drain_invoke('live')::text$q$) r) s;
SELECT pg_temp.check('queued request: POST to the configured URL, 60 s, secret header',
  q.method = 'POST'
  AND q.url = 'http://127.0.0.1:9/billing-drain-3849'
  AND q.timeout_milliseconds = 60000
  AND q.headers ->> 'x-billing-drain-secret' = (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'billing_drain_secret')
  AND q.headers ->> 'Content-Type' = 'application/json',
  q.method || ' ' || q.url || ' ' || q.timeout_milliseconds || ' header_len=' || coalesce(length(q.headers ->> 'x-billing-drain-secret'), 0))
  FROM net.http_request_queue q WHERE q.url LIKE '%billing-drain-3849' ORDER BY q.id DESC LIMIT 1;
SELECT pg_temp.check('service_role cannot fire the job', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.as_role('service_role', 'service_role', $q$SELECT public.billing_drain_invoke('test')::text$q$) r) s;
SELECT pg_temp.check('authenticated cannot fire the job', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.as_role('authenticated', 'authenticated', $q$SELECT public.billing_drain_invoke('test')::text$q$) r) s;
