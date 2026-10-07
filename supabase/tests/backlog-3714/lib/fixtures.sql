-- BACKLOG-3714 fixtures. Runs inside the harness transaction, as postgres,
-- BEFORE the 3673 and 3714 migrations. Synthetic ids and addresses only.
--   u_self:  the signed-in user writing their own row
--   u_other: another user's row
--   u_admin: holds an internal role in c4 (inserted there)
-- The public.users row is created by the INSERT below, or already exists if
-- the venue has the auth.users signup trigger; either way the UPDATE that
-- follows sets the state every control assumes.
INSERT INTO auth.users (id, email, aud, role) VALUES
 (pg_temp.id('u_self'),  'self-3714@example.test',  'authenticated', 'authenticated'),
 (pg_temp.id('u_other'), 'other-3714@example.test', 'authenticated', 'authenticated'),
 (pg_temp.id('u_admin'), 'admin-3714@example.test', 'authenticated', 'authenticated');
INSERT INTO public.users (id, email, oauth_provider, oauth_id) VALUES
 (pg_temp.id('u_self'),  'self-3714@example.test',  'google', 'self3714'),
 (pg_temp.id('u_other'), 'other-3714@example.test', 'google', 'other3714'),
 (pg_temp.id('u_admin'), 'admin-3714@example.test', 'google', 'admin3714')
ON CONFLICT (id) DO NOTHING;
UPDATE public.users
   SET subscription_tier = 'free', subscription_status = 'trial', status = 'active',
       provisioning_source = 'manual', is_active = true, do_not_sell_data = false,
       is_managed = false, sso_only = false, jit_provisioned = false, login_count = 0,
       suspended_at = NULL, suspension_reason = NULL, idp_claims = NULL,
       email_onboarding_completed_at = NULL, onboarding_completed_at = NULL,
       display_name = 'Before 3714'
 WHERE id IN (pg_temp.id('u_self'), pg_temp.id('u_other'), pg_temp.id('u_admin'));

-- ACL and policy state before any migration in the run (c2 / c7 compare to it).
CREATE TEMP TABLE t3714_before ON COMMIT DROP AS
  SELECT (SELECT relacl::text FROM pg_class WHERE oid = 'public.users'::regclass) AS relacl,
         pg_temp.attacl_cols() AS attacl_cols,
         (SELECT md5(string_agg(policyname || '|' || cmd || '|' || roles::text || '|'
                                || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY policyname))
            FROM pg_policies WHERE schemaname = 'public' AND tablename = 'users') AS policies_md5;
