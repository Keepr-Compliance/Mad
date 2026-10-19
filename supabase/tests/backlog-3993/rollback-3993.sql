-- BACKLOG-3993 rollback: restore admin_invite_user's cross-organisation duplicate check
-- to 'pending' only (the body before 20261019010000_backlog_3993_unlicensed_duplicate_invite.sql).
-- CREATE OR REPLACE only, same signature; ACL unchanged. Pre-check: the current body is
-- 3993's or the old one. Run in one transaction (BEGIN; \i rollback-3993.sql; COMMIT;)
-- or with \set ON_ERROR_STOP on. Under execute_sql one call is one transaction.
-- Also delete the ledger row: DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261019010000';

DO $pre$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.admin_invite_user(uuid,text,text,uuid,text,uuid)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('7b4795fa1c14779c2336b909a5ea3ed1', '6c7f379eab8423c17ca23e4f44b99ad6') THEN
    RAISE EXCEPTION '3993 rollback pre-check: admin_invite_user differs from the expected body (md5 %)', v_md5;
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.admin_invite_user(p_organization_id uuid DEFAULT NULL::uuid, p_email text DEFAULT NULL::text, p_role text DEFAULT NULL::text, p_invited_by uuid DEFAULT NULL::uuid, p_license_status text DEFAULT 'trial'::text, p_plan_id uuid DEFAULT NULL::uuid)
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

  -- ORG PATH
  IF p_organization_id IS NOT NULL THEN
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

    -- Cross-table check — also check individual_invitations for pending invite
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
      -- BACKLOG-3851: an expired, unclaimed invite holds no seat.
      SELECT count(*) INTO v_member_count
      FROM organization_members
      WHERE organization_id = p_organization_id
        AND public.member_row_holds_seat(license_status, invitation_expires_at, user_id);

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

  -- INDIVIDUAL PATH
  ELSE
    -- Check duplicate in individual_invitations (existing check)
    SELECT id INTO v_existing_invite
    FROM individual_invitations WHERE invited_email = p_email AND accepted_at IS NULL;

    IF v_existing_invite IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'duplicate_invitation',
        'existing_org_id', null, 'existing_org_name', null);
    END IF;

    -- Cross-table check — also check organization_members for pending invite
    SELECT om.organization_id, o.name INTO v_existing_org_id, v_existing_org_name
    FROM organization_members om
    JOIN organizations o ON o.id = om.organization_id
    WHERE om.invited_email = p_email AND om.license_status = 'pending'
    LIMIT 1;

    IF v_existing_org_id IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'duplicate_invitation',
        'existing_org_id', v_existing_org_id, 'existing_org_name', v_existing_org_name);
    END IF;

    INSERT INTO individual_invitations (
      invited_email, invitation_token, invitation_expires_at, invited_by,
      invited_at, license_status, plan_id
    ) VALUES (
      p_email, v_token, v_expires_at, p_invited_by,
      now(), COALESCE(p_license_status, 'trial'), p_plan_id
    );

    INSERT INTO admin_audit_logs (actor_id, action, target_type, target_id, metadata)
    VALUES (v_caller_id, 'invite_individual_user', 'user', v_caller_id,
      jsonb_build_object('email', p_email, 'license_status', p_license_status));

    RETURN jsonb_build_object('success', true, 'invitation_token', v_token, 'org_name', NULL);
  END IF;
END;
$function$;

DO $post$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.admin_invite_user(uuid,text,text,uuid,text,uuid)');
  IF v_md5 IS DISTINCT FROM '6c7f379eab8423c17ca23e4f44b99ad6' THEN
    RAISE EXCEPTION '3993 rollback post-check: admin_invite_user md5 % is not the expected %', v_md5, '6c7f379eab8423c17ca23e4f44b99ad6';
  END IF;
END $post$;
