-- v3: guard only has_internal_role (the function named in the item), others untouched.
CREATE OR REPLACE FUNCTION public.has_internal_role(check_user_id uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.internal_roles WHERE user_id = check_user_id AND check_user_id = (SELECT auth.uid()));
$function$;
