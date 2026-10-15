-- v4: add a no-arg public.is_internal() and leave the uuid helpers as they are.
CREATE OR REPLACE FUNCTION public.is_internal() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.internal_roles WHERE user_id = (SELECT auth.uid())); $function$;
