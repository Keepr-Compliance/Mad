-- invoke posts to the Vault URL with the secret header and a 150 s timeout.
DO $$ DECLARE rid bigint; q record;
BEGIN
  PERFORM vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'submission_sweep_url'), 'http://example.invalid/functions/v1/submission-sweep');
  rid := public.submission_sweep_invoke();
  SELECT * INTO q FROM net.http_request_queue WHERE id = rid;
  PERFORM pg_temp.ok(q.url = 'http://example.invalid/functions/v1/submission-sweep', 'S15 URL comes from Vault');
  PERFORM pg_temp.ok(q.timeout_milliseconds = 150000, 'S15 timeout 150000 ms');
  PERFORM pg_temp.ok(q.headers->>'x-webhook-secret' = (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'submission_sweep_secret')
                 AND length(q.headers->>'x-webhook-secret') = 64, 'S15 secret header = the Vault secret (64 hex)');
END $$;
