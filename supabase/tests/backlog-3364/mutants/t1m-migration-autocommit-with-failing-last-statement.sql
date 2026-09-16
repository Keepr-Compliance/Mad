-- BACKLOG-3364: personal organizations — a plan on record for solo users.
--
-- A solo user gets a one-person organization holding a shared individual-tier
-- plan. This file adds the database side only. Nothing here creates a personal
-- organization on its own: one is created when a signed-in user calls
-- public.ensure_personal_organization(), and no released client calls it yet.
--
-- WHAT THIS FILE DOES, in order:
--
--   1. organizations.personal_owner_user_id — nullable, no default. Not null
--      means "personal organization of this user". A partial unique index
--      allows one personal organization per user.
--   2. A BEFORE INSERT / UPDATE trigger on organizations: only the functions
--      in this file may set or change personal_owner_user_id.
--   3. public._ensure_personal_organization_for(uuid) (internal; not
--      executable by anon or authenticated) and its wrapper
--      public.ensure_personal_organization() (authenticated; takes no
--      argument, uses auth.uid()).
--   4. An AFTER INSERT / UPDATE trigger on organization_members: when a user
--      gains a membership in a non-personal organization, their membership in
--      their personal organization is removed. The personal organization and
--      its plan row are kept.
--   5. transaction_submissions INSERT policy "agents_can_create_submissions"
--      and storage.objects INSERT policy "Members can upload submission
--      attachments": both keep their current rule and additionally require
--      the organization to be non-personal.
--
-- NOT IN THIS FILE: any trigger on auth.users; any change to handle_new_user,
-- create_active_individual_license or admin_assign_org_plan; the backfill
-- (parked in supabase/parked/backlog-3364/).
--
-- The legacy organizations.plan column is not named in the INSERT, so a
-- personal organization stores the column default ('trial'), the same as
-- admin_create_organization.
--
-- One transaction. Re-running the file changes nothing.
-- Tested by supabase/tests/backlog-3364/.


SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Column and index
-- ---------------------------------------------------------------------------

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS personal_owner_user_id uuid NULL
  REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS organizations_personal_owner_user_id_key
  ON public.organizations (personal_owner_user_id)
  WHERE personal_owner_user_id IS NOT NULL;

COMMENT ON COLUMN public.organizations.personal_owner_user_id IS
  'BACKLOG-3364: not null = the personal organization of this user. Set only by public._ensure_personal_organization_for.';

-- ---------------------------------------------------------------------------
-- 2. Internal: create or re-attach a user's personal organization
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._ensure_personal_organization_for(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email   text;
  v_plan_id uuid;
  v_org_id  uuid;
  v_created boolean := false;
  v_rows    integer;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('status', 'no_user');
  END IF;

  -- One ensure / retirement at a time per user.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 3364));

  -- Any membership in a non-personal organization, whatever its status.
  IF EXISTS (
    SELECT 1
    FROM public.organization_members m
    JOIN public.organizations o ON o.id = m.organization_id
    WHERE m.user_id = p_user_id
      AND o.personal_owner_user_id IS NULL
  ) THEN
    RETURN jsonb_build_object('status', 'has_membership');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.licenses WHERE user_id = p_user_id) THEN
    RETURN jsonb_build_object('status', 'no_license');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id) THEN
    RETURN jsonb_build_object('status', 'no_user');
  END IF;

  -- An unclaimed invite that has not expired: the invite decides. Same email
  -- source, match and expiry rule as public.claim_pending_invite.
  SELECT COALESCE(
           NULLIF(TRIM(email), ''),
           NULLIF(TRIM(raw_user_meta_data->>'email'), ''),
           raw_user_meta_data->>'mail',
           raw_user_meta_data->>'preferred_username'
         )
    INTO v_email
    FROM auth.users
   WHERE id = p_user_id;

  IF v_email IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.organization_members
    WHERE user_id IS NULL
      AND LOWER(TRIM(invited_email)) = LOWER(TRIM(v_email))
      AND (invitation_expires_at IS NULL OR invitation_expires_at >= NOW())
  ) THEN
    RETURN jsonb_build_object('status', 'pending_invite');
  END IF;

  SELECT id
    INTO v_plan_id
    FROM public.plans
   WHERE tier = 'individual'
     AND is_default
     AND is_active
   ORDER BY sort_order, created_at, id
   LIMIT 1;

  IF v_plan_id IS NULL THEN
    RETURN jsonb_build_object('status', 'no_default_plan');
  END IF;

  INSERT INTO public.organizations
    (name, slug, max_seats, jit_provisioning_enabled, default_member_role, personal_owner_user_id)
  VALUES
    ('Personal', 'personal-' || replace(p_user_id::text, '-', ''), 1, false, 'agent', p_user_id)
  ON CONFLICT (personal_owner_user_id) WHERE personal_owner_user_id IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_org_id;

  IF v_org_id IS NOT NULL THEN
    v_created := true;
  ELSE
    SELECT id INTO v_org_id
      FROM public.organizations
     WHERE personal_owner_user_id = p_user_id;
  END IF;

  -- Attach only to an organization that holds no other membership row.
  IF EXISTS (
    SELECT 1
    FROM public.organization_members
    WHERE organization_id = v_org_id
      AND user_id IS DISTINCT FROM p_user_id
  ) THEN
    RETURN jsonb_build_object('status', 'conflict');
  END IF;

  INSERT INTO public.organization_plans (organization_id, plan_id)
  VALUES (v_org_id, v_plan_id)
  ON CONFLICT (organization_id) DO NOTHING;

  INSERT INTO public.organization_members
    (organization_id, user_id, role, license_status, joined_at, provisioned_by)
  VALUES
    (v_org_id, p_user_id, 'agent', 'active', NOW(), NULL)
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_created THEN 'created'
                   WHEN v_rows > 0 THEN 'attached'
                   ELSE 'exists' END,
    'organization_id', v_org_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public._ensure_personal_organization_for(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._ensure_personal_organization_for(uuid) FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Wrapper for signed-in users
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ensure_personal_organization()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('status', 'not_authenticated');
  END IF;
  RETURN public._ensure_personal_organization_for(v_uid);
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_personal_organization() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_personal_organization() FROM anon;
GRANT EXECUTE ON FUNCTION public.ensure_personal_organization() TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Column guard on organizations.personal_owner_user_id
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._guard_personal_owner_user_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_owner name;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.personal_owner_user_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.personal_owner_user_id IS NOT DISTINCT FROM OLD.personal_owner_user_id THEN
    RETURN NEW;
  END IF;

  SELECT pg_get_userbyid(p.proowner)
    INTO v_owner
    FROM pg_catalog.pg_proc p
   WHERE p.oid = 'public._ensure_personal_organization_for(uuid)'::regprocedure;

  IF v_owner IS NOT NULL AND current_user = v_owner THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'organizations.personal_owner_user_id can only be set by the database'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public._guard_personal_owner_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._guard_personal_owner_user_id() FROM anon, authenticated;

CREATE OR REPLACE TRIGGER guard_personal_owner_user_id
  BEFORE INSERT OR UPDATE OF personal_owner_user_id ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public._guard_personal_owner_user_id();

-- ---------------------------------------------------------------------------
-- 5. Retire the personal membership when a non-personal one arrives
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._retire_personal_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.organizations
    WHERE id = NEW.organization_id
      AND personal_owner_user_id IS NOT NULL
  ) THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 3364));

  DELETE FROM public.organization_members m
   USING public.organizations o
   WHERE m.organization_id = o.id
     AND o.personal_owner_user_id IS NOT NULL
     AND m.user_id = NEW.user_id;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public._retire_personal_membership() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._retire_personal_membership() FROM anon, authenticated;

CREATE OR REPLACE TRIGGER retire_personal_membership
  AFTER INSERT OR UPDATE OF user_id, organization_id ON public.organization_members
  FOR EACH ROW
  WHEN (NEW.user_id IS NOT NULL)
  EXECUTE FUNCTION public._retire_personal_membership();

-- ---------------------------------------------------------------------------
-- 6. Submissions: not into a personal organization
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "agents_can_create_submissions" ON public.transaction_submissions;
CREATE POLICY "agents_can_create_submissions" ON public.transaction_submissions
  FOR INSERT
  TO public
  WITH CHECK (
    submitted_by = (SELECT auth.uid())
    AND organization_id IN (
      SELECT om.organization_id
      FROM public.organization_members om
      JOIN public.organizations o ON o.id = om.organization_id
      WHERE om.user_id = (SELECT auth.uid())
        AND o.personal_owner_user_id IS NULL
    )
  );

-- ---------------------------------------------------------------------------
-- 7. Submission attachment uploads: not under a personal organization
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Members can upload submission attachments" ON storage.objects;
CREATE POLICY "Members can upload submission attachments" ON storage.objects
  FOR INSERT
  TO public
  WITH CHECK (
    bucket_id = 'submission-attachments'
    AND split_part(name, '/', 1) IN (
      SELECT om.organization_id::text
      FROM public.organization_members om
      JOIN public.organizations o ON o.id = om.organization_id
      WHERE om.user_id = auth.uid()
        AND o.personal_owner_user_id IS NULL
    )
  );


SELECT 1/0 AS injected_failure;
