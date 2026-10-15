-- Grant RPC (plan §2.3, RC8, SR ruling req. 2). Called as postgres here (the
-- service role's path); EXECUTE for clients is covered by k10.
SELECT pg_temp.check('live grant on a live user -> granted', r LIKE 'OK %"status": "granted"%', r)
  FROM (SELECT pg_temp.try('SELECT public.grant_unlimited_from_subscription(''{u_live}'', ''2098-01-01T00:00:00Z''::timestamptz, ''live'')::text') r) s;
-- Stored value: exactly the to_jsonb(timestamptz) rendering (ISO, 'T', offset),
-- which parsePaidThrough's ^\d{4}-\d{2}-\d{2}T accepts.
SELECT pg_temp.check('stored override shape', o = jsonb_build_object('enabled', true, 'paid_through', '2098-01-01T00:00:00+00:00', 'source', 'stripe'), o::text)
  FROM (SELECT feature_overrides -> 'unlimited_transactions' o FROM public.organization_plans WHERE organization_id = pg_temp.porg('u_live')) s;
SELECT pg_temp.check3('granted user is Unlimited', pg_temp.id('u_live'), pg_temp.porg('u_live'), 'unlimited_transactions', 'OK true/override');
-- Re-grant extends; a past period end makes the user not Unlimited.
SELECT pg_temp.try('SELECT public.grant_unlimited_from_subscription(''{u_live}'', ''2020-01-01T00:00:00Z''::timestamptz, ''live'')::text');
SELECT pg_temp.check3('re-grant to a past date -> not Unlimited', pg_temp.id('u_live'), pg_temp.porg('u_live'), 'unlimited_transactions', 'OK false/plan');

-- Refusals that raise (caller bugs).
SELECT pg_temp.run('SELECT public.grant_unlimited_from_subscription(''{u_live}'', NULL, ''live'')::text');
SELECT pg_temp.check('NULL paid_through -> raises 22004, nothing written', pg_temp.last() LIKE 'ERR 22004 %'
         AND pg_temp.overrides(pg_temp.porg('u_live')) -> 'unlimited_transactions' ->> 'paid_through' = '2020-01-01T00:00:00+00:00',
         pg_temp.last() || ' / ' || pg_temp.overrides(pg_temp.porg('u_live'))::text);
SELECT pg_temp.check('test grant on a non-test user -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.try('SELECT public.grant_unlimited_from_subscription(''{u_live}'', ''2098-01-01T00:00:00Z''::timestamptz, ''test'')::text') r) s;
SELECT pg_temp.check('live grant on an is_test user -> 42501', r LIKE 'ERR 42501 %', r)
  FROM (SELECT pg_temp.try('SELECT public.grant_unlimited_from_subscription(''{u_test}'', ''2098-01-01T00:00:00Z''::timestamptz, ''live'')::text') r) s;
SELECT pg_temp.check('test grant on an is_test user -> granted', r LIKE 'OK %"status": "granted"%', r)
  FROM (SELECT pg_temp.try('SELECT public.grant_unlimited_from_subscription(''{u_test}'', ''2098-01-01T00:00:00Z''::timestamptz, ''test'')::text') r) s;
SELECT pg_temp.check('user without personal org (test) -> 42501 no personal organization', r LIKE 'ERR 42501 %no personal organization%', r)
  FROM (SELECT pg_temp.try('SELECT public.grant_unlimited_from_subscription(''{u_noorg}'', ''2098-01-01T00:00:00Z''::timestamptz, ''test'')::text') r) s;
SELECT pg_temp.check('user without personal org (live) -> 42501 no personal organization', r LIKE 'ERR 42501 %no personal organization%', r)
  FROM (SELECT pg_temp.try('SELECT public.grant_unlimited_from_subscription(''{u_noorg}'', ''2098-01-01T00:00:00Z''::timestamptz, ''live'')::text') r) s;
SELECT pg_temp.check('invalid mode -> 22023', r LIKE 'ERR 22023 %', r)
  FROM (SELECT pg_temp.try('SELECT public.grant_unlimited_from_subscription(''{u_live}'', ''2098-01-01T00:00:00Z''::timestamptz, ''LIVE'')::text') r) s;

-- Refusals returned (business rules), nothing written.
SELECT pg_temp.run('SELECT public.grant_unlimited_from_subscription(''{u_susp}'', ''2098-01-01T00:00:00Z''::timestamptz, ''live'')::text');
SELECT pg_temp.check('suspended licence -> refused, nothing written', pg_temp.last() LIKE 'OK %"reason": "licence_suspended"%'
         AND pg_temp.overrides(pg_temp.porg('u_susp')) = '{}'::jsonb,
         pg_temp.last() || ' / ' || pg_temp.overrides(pg_temp.porg('u_susp'))::text);
SELECT pg_temp.set_override(pg_temp.porg('u_susp'), 'unlimited_transactions', '{"enabled": true}');
UPDATE public.licenses SET status = 'active' WHERE user_id = pg_temp.id('u_susp');
SELECT pg_temp.run('SELECT public.grant_unlimited_from_subscription(''{u_susp}'', ''2098-01-01T00:00:00Z''::timestamptz, ''live'')::text');
SELECT pg_temp.check('support override present -> refused, override unchanged', pg_temp.last() LIKE 'OK %"reason": "non_stripe_override"%'
         AND pg_temp.overrides(pg_temp.porg('u_susp')) = '{"unlimited_transactions": {"enabled": true}}'::jsonb,
         pg_temp.last() || ' / ' || pg_temp.overrides(pg_temp.porg('u_susp'))::text);
