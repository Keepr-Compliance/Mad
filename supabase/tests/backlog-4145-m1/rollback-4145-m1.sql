-- BACKLOG-4145 M1 rollback (keepr-test, or production with a go).
-- Restores admin_list_user_devices(uuid) to the body production held before 20261108150000. The body
-- below is prosrc exactly as SELECTed from production on 2026-11-07 (byte-identical on keepr-test;
-- md5(prosrc) 37208d52da7d6bc50307173b6a104422), with its previous config (search_path public,
-- extensions) and previous EXECUTE grants (PUBLIC, anon, authenticated, service_role). Removes the
-- three new functions and the version row.

CREATE OR REPLACE FUNCTION public.admin_list_user_devices(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $rbf$
DECLARE
  v_devices JSONB;
BEGIN
  IF NOT public.has_internal_role(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF NOT public.has_permission(auth.uid(), 'users.view') THEN
    RAISE EXCEPTION 'Missing permission: users.view';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', d.id,
      'device_name', d.device_name,
      'device_id', d.device_id,
      'os', d.os,
      'app_version', d.app_version,
      'platform', d.platform,
      'is_active', d.is_active,
      'last_seen_at', d.last_seen_at,
      'activated_at', d.activated_at
    ) ORDER BY d.last_seen_at DESC NULLS LAST
  ), '[]'::jsonb)
  INTO v_devices
  FROM public.devices d
  WHERE d.user_id = p_user_id;

  RETURN v_devices;
END;
$rbf$;

GRANT EXECUTE ON FUNCTION public.admin_list_user_devices(uuid) TO PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.pm_list_backlog_ticket_links(uuid);
DROP FUNCTION IF EXISTS public.support_can_view_requester(uuid);
DROP FUNCTION IF EXISTS public.support_my_requester_ids();

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261108150000';
