-- BACKLOG-3851 rollback of M2 ONLY (20261016100100). M1 (20261015152446) stays: production
-- already holds it. One transaction; run with psql, not as a migration.
--
-- PRECONDITION (operational, not checkable from SQL): the production broker portal AND admin
-- portal still contain PR-2a. The personal memberships the revert trigger attached stay after
-- this rollback, so a deactivated member keeps two membership rows; only PR-2a's readers handle
-- two rows. If PR-2a is ALSO being reverted, run rollback-3851-m2-paygo-cleanup.sql right after
-- this file and BEFORE the portal revert deploys.
--
-- PRECONDITION (checked below): M1 present and M2 applied (the revert function exists).
--
-- Order:
--   1. the revert trigger out first, so nothing below fires it;
--   2. the retire trigger back to its production column list (user_id, organization_id);
--   3. _ensure_personal_organization_for and _retire_personal_membership back to production's
--      bodies, verbatim (the bodies M2's precondition accepts as "old"); CREATE OR REPLACE keeps
--      their ACLs;
--   4. _revert_deactivated_member_to_paygo() removed (M2 created it);
--   5. organizations.jit_provisioning_enabled default back to true.
--
-- NOT undone: personal memberships the revert trigger (or the desktop self-heal) attached
-- beside a deactivated brokerage row. Listed by id before step 1. Organizations created while
-- M2 was live keep jit_provisioning_enabled = false (data, not rewritten).
BEGIN;

DO $pre$ BEGIN
  IF to_regprocedure('public.member_status_is_deactivated(text)') IS NULL THEN
    RAISE EXCEPTION 'rollback-3851-m2: M1 is not applied; use rollback-3851.sql';
  END IF;
  IF to_regprocedure('public._revert_deactivated_member_to_paygo()') IS NULL THEN
    RAISE EXCEPTION 'rollback-3851-m2: M2 is not applied; nothing to roll back';
  END IF;
END $pre$;

DO $list$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT m.id, m.user_id
      FROM public.organization_members m
      JOIN public.organizations o ON o.id = m.organization_id AND o.personal_owner_user_id = m.user_id
     WHERE EXISTS (SELECT 1 FROM public.organization_members b
                     JOIN public.organizations bo ON bo.id = b.organization_id
                    WHERE b.user_id = m.user_id AND bo.personal_owner_user_id IS NULL
                      AND b.license_status IN ('suspended', 'expired'))
     ORDER BY m.id
  LOOP
    RAISE NOTICE 'rollback-3851-m2: personal membership kept beside a deactivated brokerage row: member % user %', r.id, r.user_id;
  END LOOP;
END $list$;

-- 1.
DROP TRIGGER IF EXISTS revert_deactivated_member ON public.organization_members;

-- 2.
DROP TRIGGER IF EXISTS retire_personal_membership ON public.organization_members;
CREATE TRIGGER retire_personal_membership
  AFTER INSERT OR UPDATE OF user_id, organization_id ON public.organization_members
  FOR EACH ROW WHEN (new.user_id IS NOT NULL)
  EXECUTE FUNCTION public._retire_personal_membership();

-- 3.
CREATE OR REPLACE FUNCTION public._ensure_personal_organization_for(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public._retire_personal_membership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

-- 4.
DROP FUNCTION IF EXISTS public._revert_deactivated_member_to_paygo();

-- 5.
ALTER TABLE public.organizations ALTER COLUMN jit_provisioning_enabled SET DEFAULT true;

COMMIT;
