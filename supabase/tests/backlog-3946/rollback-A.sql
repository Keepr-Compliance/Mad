-- BACKLOG-3946 rollback A (undoes 20261014152722): production's five helper definitions, verbatim from pg_get_functiondef (read 2026-10-14).
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
  WHERE ir.user_id = check_user_id;
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
      AND ap.key = ANY(permission_keys)
  );
$function$;
CREATE OR REPLACE FUNCTION public.has_internal_role(check_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.internal_roles
    WHERE user_id = check_user_id
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
    AND ap.key = required_permission
  );
$function$;
CREATE OR REPLACE FUNCTION public.is_super_admin(check_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.internal_roles ir
    JOIN public.admin_roles ar ON ar.id = ir.role_id
    WHERE ir.user_id = check_user_id AND ar.is_system = true
  );
$function$;
