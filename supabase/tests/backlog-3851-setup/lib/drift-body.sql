-- Venue-only: replaces auto_provision_it_admin's body with one neither expected md5 matches.
CREATE OR REPLACE FUNCTION public.auto_provision_it_admin(p_tenant_id TEXT, p_org_name TEXT, p_org_slug TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$ BEGIN RETURN jsonb_build_object('success', false, 'error', 'drifted'); END; $function$;
