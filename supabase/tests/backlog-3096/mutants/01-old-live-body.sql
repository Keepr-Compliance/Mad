-- BACKLOG-3096 / MUTANT 01 -- the OLD LIVE BODY, verbatim.
--
-- This is not a hand-written mutant. It is the definition that was running in
-- production, captured on 2026-09-04 with
--
--   SELECT pg_get_functiondef('public.auto_provision_it_admin'::regproc);
--
-- and reproduced here unchanged. Applying it is the literal "revert the fix"
-- step. Note the hard-coded 'admin' near the bottom and the absence of any
-- lock on the organizations row.
--
-- EXPECTED: reds CONTROLS 2, 4, 6 (the caller lands as 'admin' in all three)
-- and CONTROL 5 (both racers become admin).
--
-- CONTROLS 1 AND 3 STAY GREEN UNDER THIS MUTANT, BY DESIGN. First-user-wins
-- agrees with a hard-coded 'admin' whenever the caller genuinely is the first
-- claimed member, which is exactly what controls 1 and 3 set up. "All six red
-- on revert" would be a false claim; the failing input for controls 1 and 3 is
-- mutant 04, not this one. See ../README.md for the full matrix.
--
-- Apply, run the controls, then restore with restore-shipped.sql.

CREATE OR REPLACE FUNCTION public.auto_provision_it_admin(p_tenant_id text, p_org_name text, p_org_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id UUID;
  v_user_email TEXT;
  v_oauth_id TEXT;
  v_org_id UUID;
  v_slug TEXT;
BEGIN
  -- Get the authenticated user
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  -- Get user email with fallback chain (SR Engineer C1 fix)
  -- Microsoft may not populate auth.users.email for external tenants
  SELECT
    COALESCE(
      email,
      raw_user_meta_data->>'email',
      raw_user_meta_data->>'mail',
      raw_user_meta_data->>'preferred_username'
    ),
    raw_user_meta_data->>'provider_id'
  INTO v_user_email, v_oauth_id
  FROM auth.users
  WHERE id = v_user_id;

  -- Use user_id as fallback for oauth_id if not found
  IF v_oauth_id IS NULL THEN
    v_oauth_id := v_user_id::text;
  END IF;

  -- Try to create organization with ON CONFLICT for TOCTOU race (SR Engineer I3 fix)
  v_slug := p_org_slug;
  
  INSERT INTO organizations (name, slug, microsoft_tenant_id, plan, max_seats)
  VALUES (p_org_name, v_slug, p_tenant_id, 'trial', 10)
  ON CONFLICT (microsoft_tenant_id) DO NOTHING;

  -- Get the org ID (either just created or already existed)
  SELECT id INTO v_org_id
  FROM organizations
  WHERE microsoft_tenant_id = p_tenant_id;

  -- If org still not found, slug collision may have occurred (SR Engineer I2 fix)
  IF v_org_id IS NULL THEN
    v_slug := p_org_slug || '-' || substr(gen_random_uuid()::text, 1, 6);
    INSERT INTO organizations (name, slug, microsoft_tenant_id, plan, max_seats)
    VALUES (p_org_name, v_slug, p_tenant_id, 'trial', 10)
    ON CONFLICT (microsoft_tenant_id) DO NOTHING;
    
    SELECT id INTO v_org_id
    FROM organizations
    WHERE microsoft_tenant_id = p_tenant_id;
  END IF;

  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Failed to create organization');
  END IF;

  -- Ensure user exists in public.users table with required columns
  INSERT INTO users (id, email, oauth_provider, oauth_id)
  VALUES (v_user_id, v_user_email, 'azure', v_oauth_id)
  ON CONFLICT (id) DO NOTHING;

  -- Check if membership already exists
  IF NOT EXISTS (
    SELECT 1 FROM organization_members
    WHERE user_id = v_user_id AND organization_id = v_org_id
  ) THEN
    -- Add user as admin (the person who sets up the org)
    INSERT INTO organization_members (organization_id, user_id, role, joined_at, license_status, provisioned_by)
    VALUES (v_org_id, v_user_id, 'admin', NOW(), 'active', 'jit');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'organization_id', v_org_id,
    'user_id', v_user_id
  );
END;
$function$;
