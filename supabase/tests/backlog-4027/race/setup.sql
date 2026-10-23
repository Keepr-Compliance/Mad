-- C-race fixture (COMMITTED on keepr-test; cleanup.sql removes it). One test brokerage, two
-- manual admins. Ids are generated; the run script reads them back by the org slug.
DO $s$
DECLARE o uuid := gen_random_uuid(); a uuid := gen_random_uuid(); b uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT x, 'p4027r-' || left(x::text, 8) || '@example.test', 'authenticated', 'authenticated',
         '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now() FROM unnest(ARRAY[a, b]) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  SELECT x, (SELECT u.email FROM auth.users u WHERE u.id = x), 'email', x::text, 'P4027R' FROM unnest(ARRAY[a, b]) x
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug, max_seats, is_test) VALUES (o, 'P4027 race', 'p4027-race', 5, true);
  INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by)
  VALUES (o, a, 'admin', 'active', now(), 'invite'), (o, b, 'admin', 'active', now(), 'invite');
END $s$;
SELECT m.id, m.role FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id WHERE o.slug = 'p4027-race' ORDER BY m.created_at, m.id;
