-- Control (4): revoke removes only a source:'stripe' override; a support grant stays.
SELECT pg_temp.set_override(pg_temp.porg('u_live'), 'unlimited_transactions', '{"enabled": true}');
SELECT pg_temp.set_override(pg_temp.porg('u_live'), 'transaction_checklists', '{"enabled": true}');
SELECT pg_temp.run('SELECT public.revoke_unlimited_from_subscription(''{u_live}'', ''live'')::text');
SELECT pg_temp.check('revoke leaves a support override untouched', pg_temp.last() LIKE 'OK %"status": "noop"%'
         AND pg_temp.overrides(pg_temp.porg('u_live'))
             = '{"unlimited_transactions": {"enabled": true}, "transaction_checklists": {"enabled": true}}'::jsonb,
         pg_temp.last() || ' / ' || pg_temp.overrides(pg_temp.porg('u_live'))::text);
SELECT pg_temp.clear_override(pg_temp.porg('u_live'), 'unlimited_transactions');
SELECT pg_temp.try('SELECT public.grant_unlimited_from_subscription(''{u_live}'', ''2098-01-01T00:00:00Z''::timestamptz, ''live'')::text');
SELECT pg_temp.run('SELECT public.revoke_unlimited_from_subscription(''{u_live}'', ''live'')::text');
SELECT pg_temp.check('revoke removes the stripe grant and only that key', pg_temp.last() LIKE 'OK %"status": "revoked"%'
         AND pg_temp.overrides(pg_temp.porg('u_live')) = '{"transaction_checklists": {"enabled": true}}'::jsonb,
         pg_temp.last() || ' / ' || pg_temp.overrides(pg_temp.porg('u_live'))::text);
SELECT pg_temp.check3('revoked user is not Unlimited', pg_temp.id('u_live'), pg_temp.porg('u_live'), 'unlimited_transactions', 'OK false/plan');
SELECT pg_temp.check('revoke with nothing to revoke -> noop', r LIKE 'OK %"reason": "no_override"%', r)
  FROM (SELECT pg_temp.try('SELECT public.revoke_unlimited_from_subscription(''{u_live}'', ''live'')::text') r) s;
SELECT pg_temp.check('revoke in test mode for a non-test user -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.try('SELECT public.revoke_unlimited_from_subscription(''{u_live}'', ''test'')::text') r) s;
SELECT pg_temp.check('revoke in live mode for an is_test user -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.try('SELECT public.revoke_unlimited_from_subscription(''{u_test}'', ''live'')::text') r) s;
