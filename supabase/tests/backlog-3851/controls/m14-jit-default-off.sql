-- m14 (M1 + M2) founder 98ef4fc0: a new organization is created with JIT off.
-- Same column list as admin_create_organization's INSERT (name, slug, max_seats).
INSERT INTO public.organizations (name, slug, max_seats) VALUES ('m14 org', 'm14-org-3851', 5);
SELECT pg_temp.check('m14 new organization has jit_provisioning_enabled = false',
  (SELECT jit_provisioning_enabled FROM public.organizations WHERE slug = 'm14-org-3851') IS FALSE,
  (SELECT coalesce(jit_provisioning_enabled::text, 'NULL') FROM public.organizations WHERE slug = 'm14-org-3851'));
SELECT pg_temp.check('m14 column default is false',
  (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'jit_provisioning_enabled') = 'false',
  (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'jit_provisioning_enabled'));
