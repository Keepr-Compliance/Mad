-- BACKLOG-3845 fixtures. Synthetic ids, addresses and Stripe ids only.
--
-- Shapes transcribed from production, 2026-10-11 (SELECT only, no ids copied):
--   * feature_definitions (`select key,name,value_type,default_value,min_tier,sort_order
--     from feature_definitions where key in ('unlimited_transactions','transaction_checklists')`):
--       unlimited_transactions  'Unlimited transactions', boolean, 'false', min_tier NULL, 162
--       transaction_checklists  'Transaction checklists', boolean, 'false', min_tier 'individual', 135
--   * plan_features (`... join plans ... where key in (...)`): Individual plan
--     transaction_checklists=true, unlimited=false; Team plan transaction_checklists=false,
--     unlimited=false. The Team unlimited=true row below is the founder's decided
--     state (pm_comments on BACKLOG-3648, 2026-10-10), not today's production.
--   * default plan: as BACKLOG-3858 fixtures ('Individual', slug 'individual', tier
--     'individual', is_default, sort_order 10).
--   * personal organizations: made by the real producer,
--     public._ensure_personal_organization_for(uuid) (name 'Personal', max_seats 1,
--     organization_plans row on the default plan with '{}' overrides).
--   * existing Stripe rows (`select left(stripe_customer_id,4), left(default_payment_method_id,3)
--     from stripe_customers`; `select left(stripe_checkout_session_id,8), status,
--     quoted_unit_price_cents from payment_intents`): cus_ + pm_ customer;
--     cs_live_ session, status created, 1499 cents, local_transaction_id a uuid.
-- The venue (NAS keepr-test) holds no plans and no unlimited_transactions
-- definition, so both are inserted here when absent.

INSERT INTO public.feature_definitions (key, name, value_type, default_value, min_tier, sort_order)
SELECT 'unlimited_transactions', 'Unlimited transactions', 'boolean', 'false', NULL, 162
 WHERE NOT EXISTS (SELECT 1 FROM public.feature_definitions WHERE key = 'unlimited_transactions');
INSERT INTO public.feature_definitions (key, name, value_type, default_value, min_tier, sort_order)
SELECT 'transaction_checklists', 'Transaction checklists', 'boolean', 'false', 'individual', 135
 WHERE NOT EXISTS (SELECT 1 FROM public.feature_definitions WHERE key = 'transaction_checklists');

INSERT INTO public.plans (name, slug, tier, is_active, is_default, sort_order, description)
SELECT 'Individual', 'individual', 'individual', true, true, 10, 'Free trial with basic features'
 WHERE NOT EXISTS (SELECT 1 FROM public.plans WHERE tier = 'individual' AND is_default AND is_active);
INSERT INTO public.plans (id, name, slug, tier, is_active, is_default, sort_order)
VALUES (pg_temp.id('p_team'), 'Team fx 3845', 'team-fx-3845', 'team', true, false, 20);

-- Individual (default) plan: transaction_checklists on, unlimited off (production).
INSERT INTO public.plan_features (plan_id, feature_id, enabled, value)
SELECT p.id, fd.id, fd.key = 'transaction_checklists', (fd.key = 'transaction_checklists')::text
  FROM public.plans p, public.feature_definitions fd
 WHERE p.tier = 'individual' AND p.is_default AND p.is_active
   AND fd.key IN ('unlimited_transactions', 'transaction_checklists')
   AND NOT EXISTS (SELECT 1 FROM public.plan_features x WHERE x.plan_id = p.id AND x.feature_id = fd.id);
-- Team plan: transaction_checklists off (production), unlimited on (decided state).
INSERT INTO public.plan_features (plan_id, feature_id, enabled, value)
SELECT pg_temp.id('p_team'), fd.id, fd.key = 'unlimited_transactions', (fd.key = 'unlimited_transactions')::text
  FROM public.feature_definitions fd WHERE fd.key IN ('unlimited_transactions', 'transaction_checklists');

INSERT INTO auth.users (id, email, aud, role)
SELECT pg_temp.id(n), n || '-3845@example.test', 'authenticated', 'authenticated' FROM pg_temp.users() n;
INSERT INTO public.users (id, email, oauth_provider, oauth_id)
SELECT pg_temp.id(n), n || '-3845@example.test', 'email', n || '3845' FROM pg_temp.users() n
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.licenses (user_id, license_key, license_type, status, max_devices, transaction_limit)
SELECT pg_temp.id(n), 'FX3845-' || n, 'individual', 'active', 2, 99999
  FROM pg_temp.users() n WHERE n IN ('u_live', 'u_test', 'u_susp');

-- Personal organizations through the real producer.
SELECT pg_temp.check('pre: personal org created for ' || n, (public._ensure_personal_organization_for(pg_temp.id(n)) ->> 'status') = 'created')
  FROM pg_temp.users() n WHERE n IN ('u_live', 'u_test', 'u_susp');
UPDATE public.licenses SET status = 'suspended' WHERE user_id = pg_temp.id('u_susp');

-- Brokerages: t_org on the Team plan (u_team a member), x_org (flagged is_test after apply).
INSERT INTO public.organizations (id, name, slug, max_seats)
VALUES (pg_temp.id('t_org'), 'Fixture Team 3845', 'fixture-team-3845', 10),
       (pg_temp.id('x_org'), 'Fixture Test Brokerage 3845', 'fixture-test-brokerage-3845', 10);
INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
VALUES (pg_temp.id('t_org'), pg_temp.id('p_team'), '{}'),
       (pg_temp.id('x_org'), pg_temp.id('p_team'), '{}');
INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at)
VALUES (pg_temp.id('t_org'), pg_temp.id('u_team'), 'agent', 'active', now() - interval '30 days');

-- A submission of u_team's in t_org still uploading (the state in which the
-- submission_checklists_insert policy lets the submitter add checklists).
INSERT INTO public.transaction_submissions (id, organization_id, submitted_by, local_transaction_id, property_address, status)
VALUES (pg_temp.id('s_upload'), pg_temp.id('t_org'), pg_temp.id('u_team'), pg_temp.id('s_upload')::text, '1 Fixture Way', 'uploading');

-- Pre-existing Stripe rows, written the way today's code writes them (no stripe_mode).
INSERT INTO public.stripe_customers (user_id, stripe_customer_id, default_payment_method_id)
VALUES (pg_temp.id('u_live'), 'cus_FX3845live', 'pm_FX3845live');
INSERT INTO public.payment_intents (user_id, local_transaction_id, stripe_checkout_session_id, quoted_unit_price_cents, status)
VALUES (pg_temp.id('u_live'), gen_random_uuid()::text, 'cs_live_FX3845a', 1499, 'created');

-- Preconditions.
SELECT pg_temp.check('pre: every personal org has a plan row',
  (SELECT count(*) FROM public.organization_plans op WHERE op.organization_id IN
     (SELECT pg_temp.porg(n) FROM unnest(ARRAY['u_live','u_test','u_susp']) n)) = 3);
SELECT pg_temp.check('pre: u_noorg and u_team have no personal org',
  pg_temp.porg('u_noorg') IS NULL AND pg_temp.porg('u_team') IS NULL);
