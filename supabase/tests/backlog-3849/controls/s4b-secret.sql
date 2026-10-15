-- harness: apply-twice
-- S4b: the secret is generated once (64 hex), survives a second apply, and only
-- service_role can read it. Values are compared, never printed.
SELECT pg_temp.check('one billing_drain_secret in vault',
  (SELECT count(*) FROM vault.secrets WHERE name = 'billing_drain_secret') = 1);
SELECT pg_temp.check('secret is 64 lowercase hex',
  (SELECT decrypted_secret ~ '^[0-9a-f]{64}$' FROM vault.decrypted_secrets WHERE name = 'billing_drain_secret'));
SELECT pg_temp.check('second apply kept the first value',
  current_setting('t3849.secret_md5_after1') = (SELECT md5(decrypted_secret) FROM vault.decrypted_secrets WHERE name = 'billing_drain_secret'));
SELECT pg_temp.check('service_role reads the stored value', r = 'OK true', r)
  FROM (SELECT pg_temp.as_role('service_role', 'service_role',
    $q$SELECT (public.billing_drain_secret() = (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'billing_drain_secret'))::text$q$) r) s;
SELECT pg_temp.check('authenticated -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.as_role('authenticated', 'authenticated', 'SELECT length(public.billing_drain_secret())::text') r) s;
SELECT pg_temp.check('anon -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.as_role('anon', 'anon', 'SELECT length(public.billing_drain_secret())::text') r) s;
-- The function's own role check (not only the grant): a caller holding EXECUTE
-- whose JWT role is not service_role is refused.
SELECT pg_temp.check('EXECUTE holder with an authenticated JWT -> 42501 service_role only', r = 'ERR 42501 service_role only', r)
  FROM (SELECT pg_temp.as_role(NULL, 'authenticated', 'SELECT length(public.billing_drain_secret())::text') r) s;
SELECT pg_temp.check('EXECUTE holder with no JWT -> 42501 service_role only', r = 'ERR 42501 service_role only', r)
  FROM (SELECT pg_temp.as_role(NULL, NULL, 'SELECT length(public.billing_drain_secret())::text') r) s;
