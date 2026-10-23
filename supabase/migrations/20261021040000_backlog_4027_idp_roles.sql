-- BACKLOG-4027 PR-1: the identity provider owns roles when group mapping is on, and a brokerage
-- always keeps at least one active admin.
--
-- Founder decisions A and B and the PM calls on BACKLOG-4027; SR plan review R1-R9.
--
--  1. _member_role_idp_managed   one helper, now: the brokerage's ACTIVE identity provider has
--                                group mapping on (JSON true), the member was provisioned by SCIM or
--                                directory sync, and the member is not excluded (group_sync_enabled
--                                is not false). A manually added member is never IdP-managed.
--  2. _guard_idp_role            a client session (authenticated / anon, including definer RPCs it
--                                calls) cannot change the role of an IdP-managed member:
--                                managed_by_idp (42501).
--  3. _guard_last_admin          the brokerage's last active admin (role admin, licence active, an
--                                account) cannot be demoted, deactivated, moved or (from a client
--                                session) removed.
--                                - a sync write (service_role + scim_synced_at changed) is kept as
--                                  it was for role / licence and logged in billing_change_log
--                                  ('sync_change_skipped_last_admin'); the rest of the write applies
--                                - any other client or service_role write raises last_admin (P0001)
--                                - the database owner (migrations, support, cascades) passes
--                                - personal organizations are exempt (joining a brokerage retires
--                                  the personal membership)
-- No column default, data step or guard_invite_acceptance change (decision A): every existing
-- member stays as it is. Group mapping itself is deferred (founder 2026-10-21): the Exclude switch
-- and its RPC, the locked-role UI and the role-priority change are not in this migration.
-- Functions and triggers are CREATE OR REPLACE.

-- 1 -------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._member_role_idp_managed(p_member uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_members m
      JOIN public.organization_identity_providers idp ON idp.organization_id = m.organization_id
     WHERE m.id = p_member
       AND idp.is_active
       AND (idp.attribute_mapping -> 'group_sync_enabled') = 'true'::jsonb
       AND m.provisioned_by IN ('scim', 'directory_sync')
       AND m.group_sync_enabled IS DISTINCT FROM false)
$function$;
REVOKE ALL ON FUNCTION public._member_role_idp_managed(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._member_role_idp_managed(uuid) TO service_role;

-- 2 -------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._guard_idp_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF current_setting('role', true) IN ('authenticated', 'anon')
     AND public._member_role_idp_managed(OLD.id) THEN
    RAISE EXCEPTION 'managed_by_idp' USING ERRCODE = '42501',
      HINT = 'Managed by your identity provider.';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public._guard_idp_role() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER _guard_idp_role
  BEFORE UPDATE OF role ON public.organization_members
  FOR EACH ROW WHEN (NEW.role IS DISTINCT FROM OLD.role)
  EXECUTE FUNCTION public._guard_idp_role();

-- 3 -------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._guard_last_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_role text := coalesce(current_setting('role', true), 'none');
BEGIN
  -- Only a row that is an active admin now, and would not be one after this statement.
  IF NOT (OLD.role = 'admin' AND OLD.license_status = 'active' AND OLD.user_id IS NOT NULL) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.role = 'admin' AND NEW.license_status = 'active' AND NEW.user_id IS NOT NULL
     AND NEW.organization_id = OLD.organization_id THEN
    RETURN NEW;
  END IF;
  -- A removal from a privileged session (cascades, account removal) is not refused.
  IF TG_OP = 'DELETE' AND v_role NOT IN ('authenticated', 'anon') THEN
    RETURN OLD;
  END IF;
  -- The database owner passes (migrations, support).
  IF v_role NOT IN ('authenticated', 'anon', 'service_role') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- Personal organizations are exempt.
  IF EXISTS (SELECT 1 FROM public.organizations po
              WHERE po.id = OLD.organization_id AND po.personal_owner_user_id IS NOT NULL) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- Serialize per brokerage: two concurrent writes must not each see the other admin.
  PERFORM 1 FROM public.organizations o WHERE o.id = OLD.organization_id FOR UPDATE;

  IF public._org_account_admin_member(OLD.organization_id, OLD.id) IS NOT NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- The last active admin.
  IF TG_OP = 'UPDATE' AND v_role = 'service_role'
     AND NEW.scim_synced_at IS DISTINCT FROM OLD.scim_synced_at THEN
    INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
    VALUES (OLD.organization_id, NULL, 'sync_change_skipped_last_admin',
            jsonb_build_object('member_id', OLD.id, 'user_id', OLD.user_id,
                               'role', jsonb_build_array(OLD.role, NEW.role),
                               'license_status', jsonb_build_array(OLD.license_status, NEW.license_status)));
    NEW.role := OLD.role;
    NEW.license_status := OLD.license_status;
    NEW.user_id := OLD.user_id;
    NEW.organization_id := OLD.organization_id;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'last_admin' USING ERRCODE = 'P0001',
    HINT = 'A brokerage must keep at least one active admin. Name another admin first.';
END
$function$;
REVOKE ALL ON FUNCTION public._guard_last_admin() FROM PUBLIC, anon, authenticated;

-- Names sort before guard_invite_acceptance, org_billing_contact_member_suspend_guard and
-- seat_limit_enforce, so those see the kept values.
CREATE OR REPLACE TRIGGER _guard_last_admin_upd
  BEFORE UPDATE OF role, license_status, user_id, organization_id ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public._guard_last_admin();

CREATE OR REPLACE TRIGGER _guard_last_admin_del
  BEFORE DELETE ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public._guard_last_admin();
