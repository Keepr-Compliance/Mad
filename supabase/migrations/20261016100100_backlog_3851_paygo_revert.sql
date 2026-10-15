-- BACKLOG-3851 M2: a deactivated brokerage member reverts to individual pay-as-you-go.
--
-- APPLY ORDER: only after M1 (20261016100000) AND only after the production broker portal
-- reads a user with two membership rows (PR-2a deployed on main). Before that, the
-- portal's single-row readers fail for a user holding a deactivated brokerage row and a
-- personal row. The precondition below refuses to run without M1.
--
-- 1. _ensure_personal_organization_for(uuid): refuses a personal organization only while
--    the user has a non-personal membership that is NOT deactivated (suspended/expired).
-- 2. _retire_personal_membership(): does nothing when the new row is deactivated. Its
--    trigger now also fires on license_status (reactivation retires the personal row).
-- 3. _revert_deactivated_member_to_paygo() + AFTER UPDATE OF license_status trigger
--    revert_deactivated_member: on a move into a deactivated status, attaches the user's
--    personal organization. A failure there raises a WARNING and never blocks the
--    deactivation.
--
-- Replaced functions are CREATE OR REPLACE (ACL, SECURITY DEFINER, search_path unchanged).
-- Apply as one transaction. No BEGIN/COMMIT here.

DO $pre$
DECLARE
  bad text;
BEGIN
  IF to_regprocedure('public.member_status_is_deactivated(text)') IS NULL THEN
    RAISE EXCEPTION 'BACKLOG-3851 M2: M1 (20261016100000) is not applied';
  END IF;
  -- old = production body (read 2026-10-14); new = this file's body (a second apply).
  SELECT string_agg(v.fn || ' actual=' || coalesce(md5(p.prosrc), '<missing>'), '; ')
    INTO bad
    FROM (VALUES
      ('_ensure_personal_organization_for', 'bcfe51daa44bb65ceb7c120a44d5eec2', '831f08148d71458c8aa66e106304d6af'),
      ('_retire_personal_membership',       'dd505c04b375c309acab6ae2d5744d3a', 'a3201c3a731a968397bebe5ccc1b1421')
    ) AS v(fn, old_md5, new_md5)
    LEFT JOIN pg_proc p ON p.proname = v.fn AND p.pronamespace = 'public'::regnamespace
   WHERE md5(p.prosrc) IS NULL OR md5(p.prosrc) NOT IN (v.old_md5, v.new_md5);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'BACKLOG-3851 M2: a replaced function differs from the expected body: %', bad;
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. Personal organization allowed beside a deactivated brokerage membership
-- ---------------------------------------------------------------------------
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

  -- Any membership in a non-personal organization that is not deactivated
  -- (BACKLOG-3851: a deactivated member reverts to individual pay-as-you-go).
  IF EXISTS (
    SELECT 1
    FROM public.organization_members m
    JOIN public.organizations o ON o.id = m.organization_id
    WHERE m.user_id = p_user_id
      AND o.personal_owner_user_id IS NULL
      AND NOT public.member_status_is_deactivated(m.license_status)
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

-- ---------------------------------------------------------------------------
-- 2. Retirement skips a deactivated row; trigger also fires on license_status
-- ---------------------------------------------------------------------------
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

  -- BACKLOG-3851: a deactivated brokerage membership keeps the personal one.
  IF public.member_status_is_deactivated(NEW.license_status) THEN
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

DROP TRIGGER IF EXISTS retire_personal_membership ON public.organization_members;
CREATE TRIGGER retire_personal_membership
  AFTER INSERT OR UPDATE OF user_id, organization_id, license_status ON public.organization_members
  FOR EACH ROW WHEN (new.user_id IS NOT NULL)
  EXECUTE FUNCTION public._retire_personal_membership();

-- ---------------------------------------------------------------------------
-- 3. Revert to pay-as-you-go on deactivation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._revert_deactivated_member_to_paygo()
 RETURNS trigger
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.user_id IS NULL
     OR NOT public.member_status_is_deactivated(NEW.license_status)
     OR public.member_status_is_deactivated(OLD.license_status) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.organizations o
              WHERE o.id = NEW.organization_id AND o.personal_owner_user_id IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  -- Deactivation is a security action: it always commits, whatever happens here.
  BEGIN
    PERFORM public._ensure_personal_organization_for(NEW.user_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'revert_deactivated_member: personal organization not attached for member % (%: %)',
      NEW.id, SQLSTATE, SQLERRM;
  END;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public._revert_deactivated_member_to_paygo() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._revert_deactivated_member_to_paygo() TO service_role;

DROP TRIGGER IF EXISTS revert_deactivated_member ON public.organization_members;
CREATE TRIGGER revert_deactivated_member
  AFTER UPDATE OF license_status ON public.organization_members
  FOR EACH ROW
  EXECUTE FUNCTION public._revert_deactivated_member_to_paygo();
