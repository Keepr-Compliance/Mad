-- BACKLOG-3846 fixtures, after the 3845 fixtures and post-apply step.
-- Synthetic ids (derived from names) and Stripe ids only.
--   a_admin: an internal user (admin portal staff), role row made here (the venue has none).
--   u_test : the 3845 is_test user with an active licence and a personal org on the
--            default plan; given an open, unpaused test-mode Agent subscription
--            ending in 10 days. Shapes: billing_subscriptions per 20261011230913.

INSERT INTO auth.users (id, email, aud, role)
VALUES (pg_temp.id('a_admin'), 'a_admin-3846@example.test', 'authenticated', 'authenticated');
INSERT INTO public.users (id, email, oauth_provider, oauth_id)
VALUES (pg_temp.id('a_admin'), 'a_admin-3846@example.test', 'email', 'a_admin3846')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.admin_roles (id, name, slug) VALUES (pg_temp.id('r_admin'), 'Fixture admin 3846', 'fixture-admin-3846');
INSERT INTO public.internal_roles (user_id, role_id) VALUES (pg_temp.id('a_admin'), pg_temp.id('r_admin'));

INSERT INTO public.billing_subscriptions
  (stripe_mode, user_id, organization_id, stripe_customer_id, stripe_subscription_id, status, "interval",
   current_period_end, paused)
VALUES ('test', pg_temp.id('u_test'), pg_temp.porg('u_test'), 'cus_FX3846t', 'sub_FX3846t', 'active', 'month',
        date_trunc('second', now()) + interval '10 days', false);

-- Helpers for the controls.
CREATE FUNCTION pg_temp.admin(p_sql text) RETURNS text LANGUAGE sql AS $f$
  SELECT pg_temp.as_role('authenticated', pg_temp.id('a_admin'), p_sql) $f$;
CREATE FUNCTION pg_temp.lic_status(p_name text) RETURNS text LANGUAGE sql AS $f$
  SELECT status FROM public.licenses WHERE user_id = pg_temp.id(p_name) $f$;
CREATE FUNCTION pg_temp.lic_id(p_name text) RETURNS uuid LANGUAGE sql AS $f$
  SELECT id FROM public.licenses WHERE user_id = pg_temp.id(p_name) $f$;
CREATE FUNCTION pg_temp.unlimited(p_name text) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT feature_overrides -> 'unlimited_transactions' FROM public.organization_plans
   WHERE organization_id = pg_temp.porg(p_name) $f$;
CREATE FUNCTION pg_temp.expected_grant(p_name text) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('enabled', true, 'paid_through', to_jsonb(bs.current_period_end + interval '2 hours'), 'source', 'stripe')
    FROM public.billing_subscriptions bs WHERE bs.user_id = pg_temp.id(p_name) AND bs.stripe_mode = 'test' $f$;
-- Suspend u_test the way admin staff do (admin portal SuspendDialog).
CREATE FUNCTION pg_temp.suspend_test_user() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN
  r := pg_temp.admin('SELECT public.admin_suspend_user(''{u_test}'', ''fixture'')::text');
  PERFORM pg_temp.check('setup: admin_suspend_user ok and licence suspended',
                        r LIKE 'OK %' AND pg_temp.lic_status('u_test') = 'suspended', r);
END $f$;

SELECT pg_temp.check('pre: u_test is_test, licence active, open sub, no override',
  (SELECT is_test FROM public.organizations WHERE id = pg_temp.porg('u_test'))
  AND pg_temp.lic_status('u_test') = 'active' AND pg_temp.unlimited('u_test') IS NULL);
