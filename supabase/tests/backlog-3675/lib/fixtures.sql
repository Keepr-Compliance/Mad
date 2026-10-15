-- BACKLOG-3675 fixtures. Runs inside the harness transaction, as postgres.
-- A solo account with a personal organization on the Individual plan, and an
-- unrelated user in another organization. Synthetic ids and addresses only.
INSERT INTO auth.users (id, email, aud, role) VALUES
 (pg_temp.id('u_owner'), 'owner-3675@example.test', 'authenticated', 'authenticated'),
 (pg_temp.id('u_other'), 'other-3675@example.test', 'authenticated', 'authenticated');
INSERT INTO public.users (id, email, oauth_provider, oauth_id) VALUES
 (pg_temp.id('u_owner'), 'owner-3675@example.test', 'google', 'owner3675'),
 (pg_temp.id('u_other'), 'other-3675@example.test', 'google', 'other3675');
INSERT INTO public.organizations (id, name, slug, personal_owner_user_id) VALUES
 (pg_temp.id('org_p'), 'Personal 3675', 'personal-3675', pg_temp.id('u_owner')),
 (pg_temp.id('org_o'), 'Other Org 3675', 'other-org-3675', NULL);
INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status) VALUES
 (pg_temp.id('m_owner'), pg_temp.id('org_p'), pg_temp.id('u_owner'), 'agent', 'active'),
 (pg_temp.id('m_other'), pg_temp.id('org_o'), pg_temp.id('u_other'), 'agent', 'active');
-- The Individual plan. A test database may have the schema without the seed
-- rows, so the plan is inserted here when absent (rolled back with the run).
-- Values transcribed from production, 2026-10-07:
--   SELECT name, slug, tier, description, is_default, is_active, sort_order
--     FROM public.plans WHERE tier = 'individual';
--   -> Individual | individual | individual | Free trial with basic features | true | true | 10
-- is_default is the one value not copied verbatim: idx_plans_single_default allows
-- one default plan, so it is true only when the database has none. No control reads it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.plans WHERE tier = 'individual') THEN
    INSERT INTO public.plans (name, slug, tier, description, is_default, is_active, sort_order)
    VALUES ('Individual', 'individual', 'individual', 'Free trial with basic features',
            NOT EXISTS (SELECT 1 FROM public.plans WHERE is_default), true, 10);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.plans WHERE tier = 'individual') THEN
    RAISE EXCEPTION 'fixture: no individual plan in this database (plans: %)',
      coalesce((SELECT string_agg(tier || ':' || slug, ', ' ORDER BY slug) FROM public.plans), 'none');
  END IF;
END $$;
INSERT INTO public.organization_plans (organization_id, plan_id)
SELECT o, (SELECT id FROM public.plans WHERE tier = 'individual' ORDER BY created_at LIMIT 1)
  FROM unnest(ARRAY[pg_temp.id('org_p'), pg_temp.id('org_o')]) AS o;
DO $$ BEGIN
  IF (SELECT count(*) FROM public.organization_plans
       WHERE organization_id IN (pg_temp.id('org_p'), pg_temp.id('org_o')) AND plan_id IS NOT NULL) <> 2 THEN
    RAISE EXCEPTION 'fixture: no individual plan in this database';
  END IF;
END $$;
