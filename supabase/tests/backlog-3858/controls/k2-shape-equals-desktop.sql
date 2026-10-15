-- k2: every organization the migration created has the shape of a personal
-- organization made by the desktop (d_desk, created in fixtures through
-- ensure_personal_organization() as the signed-in user), and the values
-- transcribed from production personal orgs (2026-10-10, SELECT over the two
-- newest organizations WHERE personal_owner_user_id IS NOT NULL with their
-- organization_plans and organization_members rows, ids/timestamps dropped).
CREATE TEMP TABLE t3858_k2 ON COMMIT DROP AS
SELECT n,
  (SELECT to_jsonb(o) - ARRAY['id','slug','personal_owner_user_id','created_at','updated_at'] FROM public.organizations o WHERE o.id = pg_temp.porg(n)) AS org,
  (SELECT jsonb_agg(to_jsonb(p) - ARRAY['id','organization_id','assigned_at','created_at','updated_at']) FROM public.organization_plans p WHERE p.organization_id = pg_temp.porg(n)) AS plan,
  (SELECT jsonb_agg(to_jsonb(m) - ARRAY['id','organization_id','user_id','created_at','updated_at','joined_at','invited_at']) FROM public.organization_members m WHERE m.organization_id = pg_temp.porg(n)) AS mem,
  (SELECT o.slug FROM public.organizations o WHERE o.id = pg_temp.porg(n)) AS slug
FROM (SELECT n FROM pg_temp.cohort() n UNION ALL SELECT 'd_desk') s;

SELECT pg_temp.check('k2 ' || c.n || ' org row = desktop org row', c.org = d.org, c.org::text || ' vs ' || d.org::text)
  FROM t3858_k2 c, t3858_k2 d WHERE d.n = 'd_desk' AND c.n <> 'd_desk';
SELECT pg_temp.check('k2 ' || c.n || ' plan row = desktop plan row', c.plan = d.plan, coalesce(c.plan::text, '<none>') || ' vs ' || d.plan::text)
  FROM t3858_k2 c, t3858_k2 d WHERE d.n = 'd_desk' AND c.n <> 'd_desk';
SELECT pg_temp.check('k2 ' || c.n || ' member rows = desktop member rows', c.mem = d.mem, coalesce(c.mem::text, '<none>') || ' vs ' || d.mem::text)
  FROM t3858_k2 c, t3858_k2 d WHERE d.n = 'd_desk' AND c.n <> 'd_desk';
SELECT pg_temp.check('k2 ' || n || ' slug = personal-<user id hex>', slug = 'personal-' || replace(pg_temp.id(n)::text, '-', ''), slug)
  FROM t3858_k2;
-- Transcribed production values (organizations / organization_plans / organization_members).
SELECT pg_temp.check('k2 ' || n || ' org = prod personal org values',
  org->>'name' = 'Personal' AND org->>'plan' = 'trial' AND org->'settings' = '{}'::jsonb
  AND (org->>'max_seats')::int = 1 AND (org->>'sso_enabled')::boolean = false AND (org->>'scim_enabled')::boolean = false
  AND (org->>'jit_provisioning_enabled')::boolean = false AND org->>'default_member_role' = 'agent'
  AND (org->>'retention_years')::int = 7 AND org->'microsoft_tenant_id' = 'null'::jsonb, org::text)
  FROM t3858_k2;
SELECT pg_temp.check('k2 ' || n || ' plan = prod default individual plan, no overrides',
  jsonb_array_length(plan) = 1
  AND (plan->0->>'plan_id')::uuid = (SELECT id FROM public.plans WHERE tier = 'individual' AND is_default AND is_active ORDER BY sort_order LIMIT 1)
  AND plan->0->'feature_overrides' = '{}'::jsonb AND plan->0->'expires_at' = 'null'::jsonb AND plan->0->'assigned_by' = 'null'::jsonb,
  coalesce(plan::text, '<none>'))
  FROM t3858_k2;
SELECT pg_temp.check('k2 ' || n || ' member = prod personal member values',
  jsonb_array_length(mem) = 1 AND mem->0->>'role' = 'agent' AND mem->0->>'license_status' = 'active'
  AND mem->0->'invited_by' = 'null'::jsonb AND mem->0->'invited_email' = 'null'::jsonb
  AND mem->0->'provisioned_by' = 'null'::jsonb AND mem->0->'invitation_token' = 'null'::jsonb,
  coalesce(mem::text, '<none>'))
  FROM t3858_k2;
