-- BACKLOG-4012: no one joins a brokerage through Microsoft/Google auto-join (JIT), directory sync
-- or SCIM while its billing setup is pending; a $0 deal is never pending. JIT is restored in the
-- same change, bound to the caller's own fresh Microsoft/Google sign-in.
--
--  1. _billing_org_join_blocked(p_org)   the one "setup pending" predicate: a 'draft' deal whose
--                                        total is not $0 (some line > 0, or no line at all).
--                                        service_role only (no caller check).
--  2. _billing_org_setup_pending(p_org)  (4007, replaced body, same signature and grants): the
--                                        predicate above AND the caller is a member. Broker
--                                        invites therefore get the $0 bypass too.
--  3. _billing_guard_idp_join_while_setup_pending  BEFORE trigger on organization_members. Refuses
--                                        ('billing_setup_incomplete', P0001) an IdP-origin row
--                                        (provisioned_by jit | scim | directory_sync) that joins
--                                        a pending brokerage: any INSERT, a move to another
--                                        organization, or a service_role reactivation
--                                        (suspended/expired -> active/pending/unassigned).
--                                        Invite acceptance, staff invites, manual rows and the
--                                        broker's own set_member_license are not affected.
--  4. _org_feature_allowed(p_org, p_key) check_feature_access steps 1-5 without the caller check,
--                                        fail closed for an unknown key. service_role only.
--  5. jit_join_organization(text, text)  restored, two arguments. The identifier must be the tid
--                                        (Microsoft) / hd (Google) of one of the caller's own
--                                        auth.identities rows, that identity must have been
--                                        written by an OAuth sign-in in THIS session within the
--                                        last 15 minutes, auto-join must be on (column AND
--                                        feature), the setup must not be pending, and the role is
--                                        never admin. The 1-arg jit_join_organization(text) is
--                                        left as it is (no client grant).
--
-- CREATE OR REPLACE only; nothing is dropped. search_path '' on every function here.
-- Pre-check: org_deals exists, and _billing_org_setup_pending is the 4007 PR-1 body (or this
-- file's, on a re-run); jit_join_organization(text,text) is absent (or this file's).
-- Apply order: after 20261020100000 (4007 PR-1). Production has neither yet; the pre-check raises
-- there until the 3853 + 4007 chain is applied.
-- Rollback: supabase/tests/backlog-4012/rollback-4012.sql (run it BEFORE any 4007 rollback).

DO $pre$
DECLARE
  v_md5 text;
  v_src text;
BEGIN
  IF to_regclass('public.org_deals') IS NULL OR to_regclass('public.org_deal_lines') IS NULL THEN
    RAISE EXCEPTION '4012 pre-check: org_deals or org_deal_lines is missing';
  END IF;
  SELECT md5(prosrc), prosrc INTO v_md5, v_src FROM pg_proc
   WHERE oid = to_regprocedure('public._billing_org_setup_pending(uuid)');
  IF v_md5 IS NULL OR (v_md5 <> '5dd851c60b811825d10ab0f120a75228' AND v_src NOT LIKE '%_billing_org_join_blocked%') THEN
    RAISE EXCEPTION '4012 pre-check: _billing_org_setup_pending is not the 4007 PR-1 body (md5 %)', v_md5;
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE oid = to_regprocedure('public.jit_join_organization(text,text)');
  IF v_src IS NOT NULL AND v_src NOT LIKE '%reauth_required%' THEN
    RAISE EXCEPTION '4012 pre-check: jit_join_organization(text,text) exists with an unknown body';
  END IF;
END $pre$;

-- =====================================================================================
-- 1. The one "setup pending" predicate
-- =====================================================================================

CREATE OR REPLACE FUNCTION public._billing_org_join_blocked(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  -- Waiting for the broker's Billing step, unless staff saved the deal at $0.
  -- Total = sum(unit_price_cents x quantity); quantity is seats (> 0) or 1, so the total is
  -- $0 exactly when every line is 0. A draft with no line is not a $0 deal (fail closed).
  SELECT EXISTS (SELECT 1 FROM public.org_deals d
                  WHERE d.organization_id = p_org AND d.status = 'draft')
     AND (NOT EXISTS (SELECT 1 FROM public.org_deal_lines l WHERE l.organization_id = p_org)
          OR EXISTS (SELECT 1 FROM public.org_deal_lines l
                      WHERE l.organization_id = p_org AND l.unit_price_cents > 0))
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_org_join_blocked(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_org_join_blocked(uuid) TO service_role;
COMMENT ON FUNCTION public._billing_org_join_blocked(uuid) IS
  'BACKLOG-4012: true while the brokerage deal waits for setup (draft) and is not a $0 deal.';

-- =====================================================================================
-- 2. 4007 invite helper: same rule, so broker invites get the $0 bypass too
-- =====================================================================================

CREATE OR REPLACE FUNCTION public._billing_org_setup_pending(p_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT public._billing_org_join_blocked(p_org)
     AND EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.organization_id = p_org AND m.user_id = auth.uid())
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_org_setup_pending(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._billing_org_setup_pending(uuid) TO authenticated, service_role;

-- =====================================================================================
-- 3. IdP joins wait for setup, whoever writes them
-- =====================================================================================

-- SECURITY INVOKER: current_user is the real writer. JIT inserts run as the definer owner, so
-- the INSERT term ignores the role; the reactivation term is limited to service_role (directory
-- sync, SCIM) so the broker's own set_member_license (definer) still works.
CREATE OR REPLACE FUNCTION public._billing_guard_idp_join_while_setup_pending()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  IF NOT coalesce(NEW.provisioned_by IN ('jit', 'scim', 'directory_sync'), false) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT'
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR (current_user = 'service_role'
         AND OLD.license_status IN ('suspended', 'expired')
         AND NEW.license_status IN ('active', 'pending', 'unassigned')) THEN
    IF public._billing_org_join_blocked(NEW.organization_id) THEN
      RAISE EXCEPTION 'billing_setup_incomplete'
        USING ERRCODE = 'P0001',
              HINT = 'This brokerage has not finished billing setup in Keepr. People can join once it is done.';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
REVOKE EXECUTE ON FUNCTION public._billing_guard_idp_join_while_setup_pending() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER _billing_guard_idp_join_while_setup_pending
  BEFORE INSERT OR UPDATE OF license_status, organization_id, provisioned_by, user_id
  ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public._billing_guard_idp_join_while_setup_pending();

-- =====================================================================================
-- 4. Feature lookup without a caller check
-- =====================================================================================

-- check_feature_access steps 1-5 (same order, same override rules). JIT needs it because
-- organizations.jit_provisioning_enabled is client-writable and the plan feature is otherwise
-- enforced only in the UI.
CREATE OR REPLACE FUNCTION public._org_feature_allowed(p_org uuid, p_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_feature record;
  v_plan record;
  v_override jsonb;
  v_pf record;
BEGIN
  SELECT * INTO v_feature FROM public.feature_definitions WHERE key = p_key;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT op.*, p.tier INTO v_plan
    FROM public.organization_plans op JOIN public.plans p ON p.id = op.plan_id
   WHERE op.organization_id = p_org;
  IF NOT FOUND THEN RETURN v_feature.default_value = 'true'; END IF;
  v_override := v_plan.feature_overrides -> p_key;
  IF v_override IS NOT NULL AND NOT public._override_effective(v_override) THEN
    v_override := NULL;
  END IF;
  IF v_override IS NOT NULL
     AND NOT public._override_above_tier(p_key, v_feature.min_tier, v_plan.tier, v_override) THEN
    RETURN coalesce((v_override ->> 'enabled')::boolean, true);
  END IF;
  SELECT * INTO v_pf FROM public.plan_features pf
   WHERE pf.plan_id = v_plan.plan_id AND pf.feature_id = v_feature.id;
  IF FOUND THEN RETURN v_pf.enabled; END IF;
  RETURN v_feature.default_value = 'true';
END
$function$;
REVOKE EXECUTE ON FUNCTION public._org_feature_allowed(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._org_feature_allowed(uuid, text) TO service_role;

-- =====================================================================================
-- 5. jit_join_organization(p_provider_type, p_identifier)
-- =====================================================================================

CREATE OR REPLACE FUNCTION public.jit_join_organization(p_provider_type text, p_identifier text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ident text := lower(btrim(coalesce(p_identifier, '')));
  v_sid text := nullif(auth.jwt() ->> 'session_id', '');
  v_org public.organizations%ROWTYPE;
  v_role text;
  v_existing text;
  v_provider text;
  v_claim text;
  v_oauth_id text;
  v_identity_at timestamptz;
  v_signin_at timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authenticated');
  END IF;
  IF p_provider_type = 'azure_ad' THEN
    IF v_ident = '9188040d-6c67-4c5b-b112-36a304b66dad' THEN -- pii-allow-uuid: Microsoft's public personal-account tenant constant
      RETURN jsonb_build_object('success', false, 'error', 'consumer_tenant');
    END IF;
    v_provider := 'azure';
    v_claim := 'tid';
  ELSIF p_provider_type = 'google_workspace' THEN
    IF v_ident IN ('', 'gmail.com', 'googlemail.com') THEN
      RETURN jsonb_build_object('success', false, 'error', 'consumer_domain');
    END IF;
    v_provider := 'google';
    v_claim := 'hd';
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'unsupported_provider');
  END IF;

  -- The tenant / domain must be one the caller's own Microsoft / Google identity carries.
  -- identity_data is written by the auth server from the provider token, never by the user.
  SELECT i.provider_id, i.updated_at INTO v_oauth_id, v_identity_at
    FROM auth.identities i
   WHERE i.user_id = v_uid AND i.provider = v_provider
     AND lower(i.identity_data -> 'custom_claims' ->> v_claim) = v_ident
   ORDER BY i.updated_at DESC
   LIMIT 1;
  IF v_oauth_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'identity_mismatch');
  END IF;

  -- ... and that identity must come from an OAuth sign-in made in THIS session within the last
  -- 15 minutes: a password session, or a long-lived session refreshed after the person left the
  -- tenant, does not count. The auth server writes the identity just before the session's
  -- 'oauth' claim, so the identity must be no older than that claim minus 60 seconds.
  SELECT max(c.updated_at) INTO v_signin_at
    FROM auth.mfa_amr_claims c
    JOIN auth.sessions s ON s.id = c.session_id
   WHERE c.session_id::text = v_sid
     AND s.user_id = v_uid
     AND c.authentication_method = 'oauth'
     AND c.updated_at > now() - interval '15 minutes';
  IF v_signin_at IS NULL
     OR v_identity_at IS NULL
     OR v_identity_at < v_signin_at - interval '60 seconds' THEN
    RETURN jsonb_build_object('success', false, 'error', 'reauth_required');
  END IF;

  SELECT * INTO v_org FROM public.organizations o
   WHERE o.personal_owner_user_id IS NULL
     AND ((v_provider = 'azure' AND lower(o.microsoft_tenant_id) = v_ident)
          OR (v_provider = 'google' AND lower(o.google_domain) = v_ident))
   ORDER BY o.created_at
   LIMIT 1;
  IF v_org.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'org_not_found');
  END IF;

  SELECT m.role INTO v_existing FROM public.organization_members m
   WHERE m.organization_id = v_org.id AND m.user_id = v_uid;
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'organization_id', v_org.id, 'role', v_existing, 'already_member', true);
  END IF;

  -- Both gates: the org's own toggle (client-writable) AND the plan feature (staff-set).
  IF NOT coalesce(v_org.jit_provisioning_enabled, false)
     OR NOT public._org_feature_allowed(v_org.id, 'jit_provisioning') THEN
    RETURN jsonb_build_object('success', false, 'error', 'jit_disabled');
  END IF;
  IF public._billing_org_join_blocked(v_org.id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_setup_pending');
  END IF;

  -- Auto-join never grants admin (BACKLOG-3096).
  v_role := CASE WHEN v_org.default_member_role IN ('agent', 'broker') THEN v_org.default_member_role ELSE 'agent' END;

  INSERT INTO public.users (id, email, oauth_provider, oauth_id, provisioning_source, jit_provisioned, jit_provisioned_at)
  SELECT v_uid, u.email, v_provider, v_oauth_id, 'jit', true, now() FROM auth.users u WHERE u.id = v_uid
  ON CONFLICT (id) DO UPDATE SET
    provisioning_source = CASE WHEN public.users.provisioning_source = 'manual' THEN 'jit' ELSE public.users.provisioning_source END,
    jit_provisioned = true,
    jit_provisioned_at = coalesce(public.users.jit_provisioned_at, now());

  -- The seat trigger turns an over-limit JIT join into 'unassigned' (BACKLOG-3851).
  INSERT INTO public.organization_members (organization_id, user_id, role, joined_at, license_status, provisioned_by, provisioned_at)
  VALUES (v_org.id, v_uid, v_role, now(), 'active', 'jit', now());

  RETURN jsonb_build_object('success', true, 'organization_id', v_org.id, 'role', v_role, 'already_member', false);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.jit_join_organization(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.jit_join_organization(text, text) TO authenticated, service_role;
COMMENT ON FUNCTION public.jit_join_organization(text, text) IS
  'BACKLOG-4012: auto-join by the tenant/domain of the caller''s own fresh Microsoft/Google sign-in.';
