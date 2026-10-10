-- BACKLOG-3856 fixtures. Synthetic ids and addresses only. Row shape
-- transcribed from production (2026-10-10, SELECT over public.users JOIN
-- auth.users LEFT JOIN public.licenses WHERE users.status = 'suspended'; no ids
-- copied): status 'suspended', suspended_at and suspension_reason set,
-- subscription_tier 'free', subscription_status 'trial', provisioning_source
-- 'manual', is_active true, oauth_provider 'email' / 'azure', auth user NOT
-- banned; one such user has no licence row, the other has an
-- 'individual' row, max_devices 2, transaction_limit 99999.
--   u_susp      admin-suspended, no licence row (the case the fix is for)
--   u_susp2     admin-suspended, no licence row (service_role path)
--   u_susp_lic  admin-suspended, already holds an 'active' licence row
--   u_active    active, no licence row
--   u_admin     active, internal role
INSERT INTO auth.users (id, email, aud, role)
SELECT pg_temp.id(n), n || '-3856@example.test', 'authenticated', 'authenticated' FROM pg_temp.id_names() n;
INSERT INTO public.users (id, email, oauth_provider, oauth_id)
SELECT pg_temp.id(n), n || '-3856@example.test', 'email', n || '3856' FROM pg_temp.id_names() n
ON CONFLICT (id) DO NOTHING;
UPDATE public.users
   SET subscription_tier = 'free', subscription_status = 'trial', provisioning_source = 'manual',
       is_active = true, status = 'active', suspended_at = NULL, suspension_reason = NULL
 WHERE id IN (SELECT pg_temp.id(n) FROM pg_temp.id_names() n);
UPDATE public.users
   SET status = 'suspended', suspended_at = now() - interval '3 days', suspension_reason = 'fixture reason'
 WHERE id IN (pg_temp.id('u_susp'), pg_temp.id('u_susp2'), pg_temp.id('u_susp_lic'));
UPDATE public.users SET oauth_provider = 'azure' WHERE id = pg_temp.id('u_susp_lic');
DELETE FROM public.licenses WHERE user_id IN (SELECT pg_temp.id(n) FROM pg_temp.id_names() n);
INSERT INTO public.licenses (user_id, license_key, license_type, status, max_devices, transaction_limit)
VALUES (pg_temp.id('u_susp_lic'), 'IND-fixture3856', 'individual', 'active', 2, 99999);
INSERT INTO public.admin_roles (name, slug) VALUES ('fixture 3856', 'fixture-3856');
INSERT INTO public.internal_roles (user_id, role_id)
SELECT pg_temp.id('u_admin'), id FROM public.admin_roles WHERE slug = 'fixture-3856';

-- Preconditions: the venue holds the pre-3856 body (production fingerprint).
SELECT pg_temp.check('pre: venue has the production pre-3856 body', pg_temp.fp() = 'f5f432e32c93707a74002363b99bd18c', pg_temp.fp());
SELECT pg_temp.check('pre: auth users not banned', NOT EXISTS (SELECT 1 FROM auth.users WHERE id IN (SELECT pg_temp.id(n) FROM pg_temp.id_names() n) AND banned_until IS NOT NULL));
