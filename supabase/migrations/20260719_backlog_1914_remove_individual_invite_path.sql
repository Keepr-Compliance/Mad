-- BACKLOG-1914: Remove the dead individual (no-org) invite path from admin_invite_user.
--
-- Context
-- -------
-- The RPC had two paths. The ORG path (p_organization_id NOT NULL) writes an
-- organization_members row whose token the acceptance side resolves correctly —
-- it works and is kept untouched here. The INDIVIDUAL path (p_organization_id
-- NULL) wrote an individual_invitations row whose token NO acceptance code ever
-- read (public_validate_invitation_token + auth/callback only look at
-- organization_members). That link was dead on arrival: 0 of 8 rows were ever
-- organically accepted. Individuals are already served by desktop self-serve
-- sign-in, which auto-provisions a 14-day trial (create_trial_license) with no
-- org gate.
--
-- Change
-- ------
-- This migration replaces admin_invite_user so that a NULL p_organization_id
-- now hard-errors ('organization_required') instead of inserting an orphan
-- individual_invitations row. Admin-initiated individual invites are handled
-- entirely in the portal (a branded "Get Keepr" download email); they no longer
-- touch this RPC. The individual_invitations TABLE is intentionally left in
-- place (founder-approved scope: Option A capabilities are not foreclosed).
--
-- Down migration
-- --------------
-- To restore the individual INSERT branch, re-apply the prior definition from
-- supabase/migrations/20260422_fix_search_path_for_pgcrypto_functions.sql
-- (the ELSE branch removed below). The org path is unchanged, so a revert only
-- needs to re-add that branch.

CREATE OR REPLACE FUNCTION public.admin_invite_user(
  p_organization_id uuid DEFAULT NULL::uuid,
  p_email text DEFAULT NULL::text,
  p_role text DEFAULT NULL::text,
  p_invited_by uuid DEFAULT NULL::uuid,
  p_license_status text DEFAULT 'trial'::text,
  p_plan_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_caller_id uuid := auth.uid();
  v_token text;
  v_expires_at timestamptz;
  v_org_name text;
  v_existing_invite uuid;
  v_existing_user_id uuid;
  v_existing_member uuid;
  v_max_seats integer;
  v_member_count bigint;
  v_existing_org_id uuid;
  v_existing_org_name text;
BEGIN
  -- Auth checks
  IF v_caller_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;

  IF NOT has_internal_role(v_caller_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_internal_user');
  END IF;

  IF NOT has_permission(v_caller_id, 'users.edit') THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_permissions');
  END IF;

  -- BACKLOG-1914: individual (no-org) invites are no longer created here. The
  -- old individual_invitations token link was never resolvable on the
  -- acceptance side; individuals now receive a branded download email and
  -- self-serve a trial on first desktop sign-in.
  IF p_organization_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'organization_required');
  END IF;

  -- Validate email
  IF p_email IS NULL OR trim(p_email) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'email_required');
  END IF;

  -- Validate license_status
  IF p_license_status IS NOT NULL AND p_license_status NOT IN ('trial', 'active') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_license_status');
  END IF;

  -- Normalize email
  p_email := lower(trim(p_email));

  -- Generate token and expiry
  v_token := encode(gen_random_bytes(32), 'hex');
  v_expires_at := now() + interval '7 days';

  -- ORG PATH (unchanged)
  SELECT name, max_seats INTO v_org_name, v_max_seats
  FROM organizations WHERE id = p_organization_id;

  IF v_org_name IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'organization_not_found');
  END IF;

  -- Check duplicate within same org (existing check)
  SELECT id INTO v_existing_invite
  FROM organization_members
  WHERE organization_id = p_organization_id AND invited_email = p_email;

  IF v_existing_invite IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'duplicate_invitation',
      'existing_org_id', p_organization_id, 'existing_org_name', v_org_name);
  END IF;

  -- Check duplicate across OTHER orgs (pending invites only)
  SELECT om.organization_id, o.name INTO v_existing_org_id, v_existing_org_name
  FROM organization_members om
  JOIN organizations o ON o.id = om.organization_id
  WHERE om.invited_email = p_email AND om.license_status = 'pending'
  LIMIT 1;

  IF v_existing_org_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'duplicate_invitation',
      'existing_org_id', v_existing_org_id, 'existing_org_name', v_existing_org_name);
  END IF;

  -- Cross-table check — also check individual_invitations for pending invite.
  -- Retained so an admin can't create an org invite that collides with a
  -- legacy pending individual_invitations row (the table still exists).
  SELECT id INTO v_existing_invite
  FROM individual_invitations
  WHERE invited_email = p_email AND accepted_at IS NULL;

  IF v_existing_invite IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'duplicate_invitation',
      'existing_org_id', null, 'existing_org_name', null);
  END IF;

  SELECT id INTO v_existing_user_id FROM users WHERE email = p_email;
  IF v_existing_user_id IS NOT NULL THEN
    SELECT id INTO v_existing_member
    FROM organization_members
    WHERE organization_id = p_organization_id AND user_id = v_existing_user_id;

    IF v_existing_member IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'already_member');
    END IF;
  END IF;

  IF v_max_seats IS NOT NULL THEN
    SELECT count(*) INTO v_member_count
    FROM organization_members
    WHERE organization_id = p_organization_id
      AND license_status IN ('active', 'pending');

    IF v_member_count >= v_max_seats THEN
      RETURN jsonb_build_object('success', false, 'error', 'seat_limit_reached');
    END IF;
  END IF;

  INSERT INTO organization_members (
    organization_id, invited_email, role, license_status,
    invitation_token, invitation_expires_at, invited_by, invited_at,
    provisioned_by, provisioning_metadata
  ) VALUES (
    p_organization_id, p_email, COALESCE(p_role, 'agent'), 'pending',
    v_token, v_expires_at, p_invited_by, now(),
    'invite', jsonb_build_object('intended_license_status', p_license_status, 'plan_id', p_plan_id)
  );

  INSERT INTO admin_audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (v_caller_id, 'invite_user', 'organization_member', p_organization_id,
    jsonb_build_object('email', p_email, 'role', p_role, 'org_name', v_org_name));

  RETURN jsonb_build_object('success', true, 'invitation_token', v_token, 'org_name', v_org_name);
END;
$function$;
