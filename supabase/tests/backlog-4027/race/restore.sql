-- restore the migration body of _guard_last_admin after the C-race mutant
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
