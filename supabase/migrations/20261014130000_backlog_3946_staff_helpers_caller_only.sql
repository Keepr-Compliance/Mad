-- BACKLOG-3946 (A of 3): the internal-staff helpers answer only for the calling user.
--
-- has_internal_role(uuid), has_permission(uuid, text), has_any_permission(uuid, text[]),
-- is_super_admin(uuid) and get_user_permissions(uuid): each body adds
-- `AND check_user_id = (SELECT auth.uid())`. Every caller (row-level security policies,
-- SECURITY DEFINER functions, admin-portal RPC calls) passes the caller's own id, so their
-- results do not change.
--
-- A service-role or NULL-uid caller gets false (or no rows) by design. There is no
-- exemption for either: no such caller exists (caller enumeration recorded in the SR plan
-- review on BACKLOG-3946, pm_comments).
--
-- Bodies are the production definitions (pg_get_functiondef, read 2026-10-14) plus the
-- guard line. Signatures, SECURITY DEFINER, search_path, volatility and grants unchanged:
-- CREATE OR REPLACE keeps the ACL. Never drop and re-create these functions — a new
-- function in public receives the default privileges.
--
-- has_permission: PUBLIC and anon hold no EXECUTE today; the REVOKE at the end of this file
-- restates that (no change). The other three helpers keep their grants here; migration
-- 20261014130100 removes anon EXECUTE after moving the policies that call them.
--
-- Apply as one transaction. No BEGIN/COMMIT here.
-- Rollback: supabase/tests/backlog-3946/rollback-A.sql

-- Intentionally callable by anon: grant unchanged by this file; 20261014130100 removes anon EXECUTE
CREATE OR REPLACE FUNCTION public.get_user_permissions(check_user_id uuid)
 RETURNS TABLE(key text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT DISTINCT ap.key
  FROM public.internal_roles ir
  JOIN public.admin_role_permissions arp ON arp.role_id = ir.role_id
  JOIN public.admin_permissions ap ON ap.id = arp.permission_id
  WHERE ir.user_id = check_user_id
    AND check_user_id = (SELECT auth.uid());
$function$;

CREATE OR REPLACE FUNCTION public.has_any_permission(check_user_id uuid, permission_keys text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM internal_roles ir
    JOIN admin_role_permissions arp ON arp.role_id = ir.role_id
    JOIN admin_permissions ap ON ap.id = arp.permission_id
    WHERE ir.user_id = check_user_id
      AND check_user_id = (SELECT auth.uid())
      AND ap.key = ANY(permission_keys)
  );
$function$;

-- Intentionally callable by anon: grant unchanged by this file (TO public policies call it); 20261014130100 moves those policies TO authenticated and removes anon EXECUTE
CREATE OR REPLACE FUNCTION public.has_internal_role(check_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.internal_roles
    WHERE user_id = check_user_id
      AND check_user_id = (SELECT auth.uid())
  );
$function$;

CREATE OR REPLACE FUNCTION public.has_permission(check_user_id uuid, required_permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.internal_roles ir
    JOIN public.admin_role_permissions arp ON arp.role_id = ir.role_id
    JOIN public.admin_permissions ap ON ap.id = arp.permission_id
    WHERE ir.user_id = check_user_id
    AND check_user_id = (SELECT auth.uid())
    AND ap.key = required_permission
  );
$function$;

-- Intentionally callable by anon: grant unchanged by this file (TO public policies call it); 20261014130100 moves those policies TO authenticated and removes anon EXECUTE
CREATE OR REPLACE FUNCTION public.is_super_admin(check_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.internal_roles ir
    JOIN public.admin_roles ar ON ar.id = ir.role_id
    WHERE ir.user_id = check_user_id AND check_user_id = (SELECT auth.uid()) AND ar.is_system = true
  );
$function$;

REVOKE EXECUTE ON FUNCTION public.has_permission(uuid, text) FROM PUBLIC, anon;
