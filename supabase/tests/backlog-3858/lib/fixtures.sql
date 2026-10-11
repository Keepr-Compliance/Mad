-- BACKLOG-3858 fixtures. Synthetic ids and addresses only.
--
-- Shapes transcribed from production, 2026-10-10 (SELECT only, no ids copied):
--   * default plan: `select * from plans where tier='individual' and is_default and is_active`
--     -> name 'Individual', slug 'individual', tier 'individual', is_active, is_default,
--        sort_order 10, description 'Free trial with basic features'.
--   * cohort mix: licences without any organization_members row, grouped by
--     license_type / licences.status / users.status -> individual/active/active,
--     individual/suspended/suspended (excluded), team/active/active; one has an
--     EXPIRED unclaimed invite (user_id NULL, invited_email = their address).
--   * licence rows: 'individual' max_devices 2, transaction_limit 99999 (as in
--     the BACKLOG-3856 fixtures).
-- The venue (NAS keepr-test) holds no plans rows, so the plan is inserted here.
INSERT INTO public.plans (name, slug, tier, is_active, is_default, sort_order, description)
SELECT 'Individual', 'individual', 'individual', true, true, 10, 'Free trial with basic features'
 WHERE NOT EXISTS (SELECT 1 FROM public.plans WHERE tier = 'individual' AND is_default AND is_active);

INSERT INTO auth.users (id, email, aud, role)
SELECT pg_temp.id(n), n || '-3858@example.test', 'authenticated', 'authenticated' FROM pg_temp.users() n;
INSERT INTO public.users (id, email, oauth_provider, oauth_id)
SELECT pg_temp.id(n), n || '-3858@example.test', 'email', n || '3858' FROM pg_temp.users() n
ON CONFLICT (id) DO NOTHING;
UPDATE public.users SET status = 'active', suspended_at = NULL, suspension_reason = NULL
 WHERE id IN (SELECT pg_temp.id(n) FROM pg_temp.users() n);
-- s_user: admin-suspended user with an active licence row; s_lic: active user
-- whose licence row is suspended (prod has one user with both; the founder's
-- rule, BACKLOG-3858, excludes either).
UPDATE public.users
   SET status = 'suspended', suspended_at = now() - interval '3 days', suspension_reason = 'fixture reason'
 WHERE id = pg_temp.id('s_user');

INSERT INTO public.licenses (user_id, license_key, license_type, status, max_devices, transaction_limit)
SELECT pg_temp.id(n), 'FX3858-' || n,
       CASE WHEN n = 'c_team' THEN 'team' ELSE 'individual' END,
       CASE WHEN n = 's_lic' THEN 'suspended' ELSE 'active' END,
       CASE WHEN n = 'c_team' THEN 10 ELSE 2 END, 99999
  FROM pg_temp.users() n WHERE n <> 'u_nolic';

-- A brokerage with an active, a pending and a suspended member, plus an
-- expired unclaimed invite for c_expinv.
INSERT INTO public.organizations (id, name, slug, max_seats)
VALUES (pg_temp.id('b_org'), 'Fixture Brokerage 3858', 'fixture-brokerage-3858', 10);
INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at)
VALUES (pg_temp.id('b_org'), pg_temp.id('m_active'),  'agent', 'active',    now() - interval '30 days'),
       (pg_temp.id('b_org'), pg_temp.id('m_pending'), 'agent', 'pending',   NULL),
       (pg_temp.id('b_org'), pg_temp.id('m_susp'),    'agent', 'suspended', now() - interval '30 days');
INSERT INTO public.organization_members (organization_id, user_id, role, license_status, invited_email, invitation_expires_at)
VALUES (pg_temp.id('b_org'), NULL, 'agent', 'pending', 'c_expinv-3858@example.test', now() - interval '1 day');

-- d_desk's personal organization, made exactly as an installed desktop makes
-- it: ensure_personal_organization() as the signed-in user.
SELECT pg_temp.check('pre: desktop path creates d_desk personal org', r = 'OK created', r)
  FROM (SELECT pg_temp.as_role('authenticated', pg_temp.id('d_desk'),
          'SELECT public.ensure_personal_organization()->>''status''') AS r) s;

-- Preconditions.
SELECT pg_temp.check('pre: venue has the production function body', pg_temp.fp() = 'bcfe51daa44bb65ceb7c120a44d5eec2', pg_temp.fp());
SELECT pg_temp.check('pre: every fixture cohort user lacks a membership',
  (SELECT count(*) FROM pg_temp.cohort() n
    WHERE NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = pg_temp.id(n))) = 4
  AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id IN (pg_temp.id('s_lic'), pg_temp.id('s_user'))));
SELECT pg_temp.check('pre: no cohort outside the fixtures',
  NOT EXISTS (SELECT 1 FROM public.licenses l
               WHERE l.user_id NOT IN (SELECT pg_temp.id(n) FROM pg_temp.users() n)
                 AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = l.user_id)));
SELECT pg_temp.check('pre: bookkeeping table absent', to_regclass('public.backlog_3858_personal_org_backfill') IS NULL);
