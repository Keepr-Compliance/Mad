-- BACKLOG-3096: /setup hands admin to every employee in the tenant. It must not.
--
-- The live body inserted the caller with a hard-coded 'admin', guarded only by
-- "this user is not already a member of this org". So the second, third and
-- hundredth employee to open /setup each became an administrator of their
-- employer's organization. We now publish a guide that tells people to go to
-- /setup, which turns a latent flaw into a documented path.
--
-- EXACTLY TWO THINGS CHANGE:
--
--   1. The membership INSERT no longer hard-codes 'admin'. The role is resolved
--      from the state of the org: 'admin' if and only if the org has ZERO
--      CLAIMED members -- organization_members rows with user_id IS NOT NULL --
--      otherwise COALESCE(organizations.default_member_role, 'agent').
--
--   2. A row lock is taken on the organizations row (SELECT ... FOR UPDATE)
--      before that count, so two employees opening /setup in the same second
--      serialize and exactly one of them can observe "zero claimed members".
--      The lock is held to commit.
--
-- Everything else is carried over verbatim from the LIVE function body,
-- captured on 2026-09-04 with:
--
--   SELECT pg_get_functiondef('public.auto_provision_it_admin'::regproc);
--
-- That is: the signature, the return shape, the email fallback chain, the
-- ON CONFLICT (microsoft_tenant_id) org insert, the slug-collision retry, the
-- public.users upsert with oauth_provider 'azure', SECURITY DEFINER, and
-- SET search_path = public.
--
-- ---------------------------------------------------------------------------
-- DRIFT NOTE (repo vs live), because it changes what this file is
-- ---------------------------------------------------------------------------
-- Before this file, the repo had NO definition of auto_provision_it_admin.
-- 20260208_add_jit_join_organization_rpc.sql and
-- 20260320_generalize_jit_join_organization_rpc.sql only NAME it in comments
-- ("Pattern: Follows auto_provision_it_admin RPC", "same as
-- auto_provision_it_admin"); neither creates it.
--
-- Nor did anything else, ever, anywhere in the tree. Searched unscoped across
-- all history, not just supabase/migrations:
--
--   git log --all -S 'auto_provision_it_admin'
--       -> 11 commits, every one a call site, a comment, guide copy or a
--          planning doc. None a definition.
--   git log --all -S 'FUNCTION auto_provision_it_admin'
--       -> only the commit that adds THIS file.
--
-- So nothing was committed and later deleted; there never was a definition in
-- git. Production was the sole source of truth for this function. This file is
-- now the repo's copy of it.
--
-- ---------------------------------------------------------------------------
-- WHY "zero claimed members" and not "no admin yet"
-- ---------------------------------------------------------------------------
-- Two production facts, both of which break the simpler reading:
--
--   * White-glove organizations are pre-created by hand and carry an UNCLAIMED
--     invite row -- organization_members with user_id IS NULL, an invitation
--     nobody has accepted yet. A membership count that includes those rows sees
--     such an org as non-empty and lands its arriving IT admin as 'agent',
--     leaving nobody able to administer the org. Hence the user_id IS NOT NULL
--     filter: count only CLAIMED members.
--
--   * An org with claimed members and no admin exists. Under "admin iff no
--     admin yet", the next employee to open /setup would silently become its
--     administrator -- a demoted or departed admin would turn into an
--     escalation path for whoever arrived next. First user wins, literally. An
--     org that loses its last admin is repaired through the admin portal, not
--     by the next person through the door.
--
-- Founder decision, 2026-09-04: first-user-wins, with the same-day correction
-- above. Promoting to admin on completed tenant-wide Microsoft consent is the
-- stronger signal and a natural follow-up; it is NOT in this change.
--
-- ---------------------------------------------------------------------------
-- NOT APPLIED. This branch does not deploy the migration; that is the PM's
-- call after merge. Executable controls live in supabase/tests/backlog-3096/.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auto_provision_it_admin(
  p_tenant_id TEXT,
  p_org_name TEXT,
  p_org_slug TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id UUID;
  v_user_email TEXT;
  v_oauth_id TEXT;
  v_org_id UUID;
  v_slug TEXT;
  v_default_role TEXT;
  v_role TEXT;
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

  -- BACKLOG-3096: lock the organization row BEFORE reading its membership.
  --
  -- Without this, two employees opening /setup in the same second both read
  -- "zero claimed members" and both insert themselves as 'admin' -- the exact
  -- escalation this change exists to close. FOR UPDATE holds the row until
  -- commit, so the second caller blocks, then sees the first caller's row and
  -- resolves to the default role instead.
  --
  -- This one statement does double duty: it takes the lock AND reads the org's
  -- default member role, so there is no second trip to the table. Placing it
  -- before the member-exists check also means a same-user double-fire (a
  -- browser retry) sees the first transaction's row rather than colliding with
  -- the UNIQUE (organization_id, user_id) constraint.
  SELECT COALESCE(default_member_role, 'agent')
  INTO v_default_role
  FROM organizations
  WHERE id = v_org_id
  FOR UPDATE;

  -- Ensure user exists in public.users table with required columns
  INSERT INTO users (id, email, oauth_provider, oauth_id)
  VALUES (v_user_id, v_user_email, 'azure', v_oauth_id)
  ON CONFLICT (id) DO NOTHING;

  -- Check if membership already exists
  IF NOT EXISTS (
    SELECT 1 FROM organization_members
    WHERE user_id = v_user_id AND organization_id = v_org_id
  ) THEN
    -- BACKLOG-3096: first user wins. 'admin' only when this org has no CLAIMED
    -- member yet. user_id IS NOT NULL is load-bearing: pre-created white-glove
    -- orgs carry unclaimed invite rows (user_id IS NULL) and counting those
    -- would demote the org's own IT admin to 'agent' on arrival.
    v_role := CASE
                WHEN NOT EXISTS (
                  SELECT 1 FROM organization_members
                  WHERE organization_id = v_org_id
                    AND user_id IS NOT NULL
                ) THEN 'admin'
                ELSE v_default_role
              END;

    INSERT INTO organization_members (organization_id, user_id, role, joined_at, license_status, provisioned_by)
    VALUES (v_org_id, v_user_id, v_role, NOW(), 'active', 'jit');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'organization_id', v_org_id,
    'user_id', v_user_id
  );
END;
$function$;
