-- RC7 catalog control. Object list read from the migration file by run.sh
-- (t3845.objects); privileges read from pg_proc / pg_class at test time.
DO $c$
DECLARE
  -- name -> expectation class
  v_expect jsonb := '{
    "_override_effective": "service_fn", "_guard_stripe_mode_is_test": "service_fn",
    "billing_outbox_claim": "service_fn", "grant_unlimited_from_subscription": "service_fn",
    "revoke_unlimited_from_subscription": "service_fn",
    "get_org_features": "resolver", "broker_get_org_features": "resolver", "check_feature_access": "resolver",
    "billing_subscriptions": "own_select_table", "billing_outbox": "service_table"}';
  n text; cls text; f record; t regclass; r text; priv text;
BEGIN
  FOREACH n IN ARRAY string_to_array(current_setting('t3845.objects'), ',') LOOP
    cls := v_expect ->> n;
    PERFORM pg_temp.check('catalog: object ' || n || ' has an expectation', cls IS NOT NULL);
    IF cls IN ('service_fn', 'resolver') THEN
      FOR f IN SELECT p.oid, p.oid::regprocedure::text AS sig, p.prosecdef, p.proacl FROM pg_proc p
                WHERE p.pronamespace = 'public'::regnamespace AND p.proname = n LOOP
        IF cls = 'service_fn' THEN
          PERFORM pg_temp.check('catalog: ' || f.sig || ' not executable by anon / authenticated / PUBLIC',
            NOT has_function_privilege('anon', f.oid, 'EXECUTE')
            AND NOT has_function_privilege('authenticated', f.oid, 'EXECUTE')
            AND NOT EXISTS (SELECT 1 FROM aclexplode(f.proacl) a WHERE a.grantee = 0),
            coalesce(f.proacl::text, '<default acl>'));
          PERFORM pg_temp.check('catalog: ' || f.sig || ' is SECURITY INVOKER', NOT f.prosecdef);
          PERFORM pg_temp.check('catalog: ' || f.sig || ' executable by service_role',
            has_function_privilege('service_role', f.oid, 'EXECUTE'));
        ELSE
          PERFORM pg_temp.check('catalog: ' || f.sig || ' still executable by authenticated',
            has_function_privilege('authenticated', f.oid, 'EXECUTE'));
        END IF;
      END LOOP;
    ELSE
      t := to_regclass('public.' || n);
      PERFORM pg_temp.check('catalog: ' || n || ' has RLS enabled',
        (SELECT relrowsecurity FROM pg_class WHERE oid = t));
      FOREACH priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        PERFORM pg_temp.check('catalog: ' || n || ' no ' || priv || ' for anon / authenticated',
          NOT has_table_privilege('anon', t, priv) AND NOT has_table_privilege('authenticated', t, priv));
      END LOOP;
      PERFORM pg_temp.check('catalog: ' || n || ' no SELECT for anon', NOT has_table_privilege('anon', t, 'SELECT'));
      PERFORM pg_temp.check('catalog: ' || n || ' SELECT for authenticated = ' || (cls = 'own_select_table')::text,
        has_table_privilege('authenticated', t, 'SELECT') = (cls = 'own_select_table'));
      PERFORM pg_temp.check('catalog: ' || n || ' policies',
        (SELECT coalesce(string_agg(policyname || ':' || cmd || ':' || array_to_string(roles, '+'), ','), '') FROM pg_policies
          WHERE schemaname = 'public' AND tablename = n)
        = CASE cls WHEN 'own_select_table' THEN n || '_select_own:SELECT:authenticated' ELSE '' END,
        (SELECT string_agg(policyname, ',') FROM pg_policies WHERE schemaname = 'public' AND tablename = n));
    END IF;
  END LOOP;
END $c$;
-- Resolver attributes and ACLs unchanged by the migration.
SELECT pg_temp.check('catalog: resolver ACL / SECURITY DEFINER / volatility / search_path unchanged',
  (SELECT jsonb_object_agg(k, split_part(v, ' ', 2) || split_part(v, ' ', 3) || split_part(v, ' ', 4) || split_part(v, ' ', 5))
     FROM jsonb_each_text(pg_temp.snapshot('pre') -> 'resolvers') e(k, v))
  = (SELECT jsonb_object_agg(k, split_part(v, ' ', 2) || split_part(v, ' ', 3) || split_part(v, ' ', 4) || split_part(v, ' ', 5))
       FROM jsonb_each_text(pg_temp.snapshot('after1') -> 'resolvers') e(k, v)),
  (pg_temp.snapshot('after1') -> 'resolvers')::text);
-- Expand step: DEFAULT 'live' on the two existing tables. At go-live this
-- check flips to column_default IS NULL (runbook item).
SELECT pg_temp.check('catalog: stripe_mode default on ' || table_name || ' = ' || coalesce(column_default, '<none>'),
  column_default = CASE WHEN table_name IN ('stripe_customers', 'payment_intents') THEN '''live''::text' END
  OR (column_default IS NULL AND table_name IN ('billing_subscriptions', 'billing_outbox')))
  FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'stripe_mode'
   AND table_name IN ('stripe_customers', 'payment_intents', 'billing_subscriptions', 'billing_outbox');
SELECT pg_temp.check('catalog: stripe_mode on all four tables',
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'stripe_mode' AND is_nullable = 'NO'
     AND table_name IN ('stripe_customers', 'payment_intents', 'billing_subscriptions', 'billing_outbox')) = 4);
SELECT pg_temp.check('catalog: guard trigger on all four tables',
  (SELECT count(*) FROM pg_trigger WHERE tgname = 'guard_stripe_mode_is_test' AND NOT tgisinternal) = 4);
