-- BACKLOG-3513 PR-5 rollback (keepr-test, or production with a go). Restores the four sharing RPCs to
-- the bodies 20261112160000 replaced (md5(prosrc): access_set cce86216, access_remove 48f078c8,
-- share_set 6cc31aec, share_remove c8af0079), copied verbatim from 20261105100000 and 20261104200000,
-- and removes the version row. CREATE OR REPLACE keeps the grants as they are.
-- Audit rows already written stay: admin_audit_logs is append-only (update and delete triggers).

CREATE OR REPLACE FUNCTION public.report_access_set(p_key TEXT, p_user_id UUID, p_role TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
BEGIN
  IF v_caller_id IS NULL OR NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required' USING ERRCODE = '42501';
  END IF;

  IF p_role IS NULL OR p_role NOT IN ('viewer', 'editor') THEN
    RAISE EXCEPTION 'A report access role must be viewer or editor';
  END IF;

  -- One combined condition, one message. Owner only; never the caller; the grantee must be eligible
  -- and must not already be an owner (owners have no rows).
  IF public._report_access_role(v_caller_id, p_key) IS DISTINCT FROM 'owner'
     OR p_user_id IS NULL
     OR p_user_id = v_caller_id
     OR NOT public._report_share_eligible(p_user_id)
     OR public._report_access_role(p_user_id, p_key) IS NOT DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Report not found';
  END IF;

  INSERT INTO report_access (report_key, user_id, role, granted_by)
  VALUES (p_key, p_user_id, p_role, v_caller_id)
  ON CONFLICT (report_key, user_id)
  DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, updated_at = now();

  RETURN jsonb_build_object('report_key', p_key, 'user_id', p_user_id, 'role', p_role);
END;
$$;

CREATE OR REPLACE FUNCTION public.report_access_remove(p_key TEXT, p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_removed INT;
BEGIN
  IF v_caller_id IS NULL OR NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required' USING ERRCODE = '42501';
  END IF;

  DELETE FROM report_access ra
  WHERE ra.report_key = p_key
    AND ra.user_id = p_user_id
    AND (ra.user_id = v_caller_id
         OR public._report_access_role(v_caller_id, p_key) IS NOT DISTINCT FROM 'owner');
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  IF v_removed = 0 THEN
    RAISE EXCEPTION 'Report not found';
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.report_share_set(p_view_id uuid, p_user_id uuid, p_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID := auth.uid();
  v_view_id UUID;
BEGIN
  IF v_caller_id IS NULL OR NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required' USING ERRCODE = '42501';
  END IF;

  IF p_role IS NULL OR p_role NOT IN ('viewer', 'editor') THEN
    RAISE EXCEPTION 'A share role must be viewer or editor';
  END IF;

  -- One lookup, one combined condition. Owner only (an editor cannot re-share); the owner and the
  -- principal must both be eligible; never the owner themself. Every failure: the same message.
  SELECT v.id INTO v_view_id
  FROM report_saved_views v
  WHERE v.id = p_view_id
    AND v.user_id = v_caller_id
    AND p_user_id IS NOT NULL
    AND p_user_id <> v_caller_id
    AND public._report_share_eligible(v_caller_id)
    AND public._report_share_eligible(p_user_id)
    AND public._report_access_role(v_caller_id, v.report_key) IN ('editor', 'owner')
    AND public._report_access_role(p_user_id, v.report_key) IS NOT NULL
  FOR UPDATE;

  IF v_view_id IS NULL THEN
    RAISE EXCEPTION 'Saved view not found';
  END IF;

  INSERT INTO report_saved_view_shares (view_id, user_id, role, granted_by)
  VALUES (v_view_id, p_user_id, p_role, v_caller_id)
  ON CONFLICT (view_id, user_id)
  DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, updated_at = now();

  RETURN jsonb_build_object('view_id', v_view_id, 'user_id', p_user_id, 'role', p_role);
END;
$function$;

CREATE OR REPLACE FUNCTION public.report_share_remove(p_view_id UUID, p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_removed INT;
BEGIN
  IF v_caller_id IS NULL OR NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required' USING ERRCODE = '42501';
  END IF;

  DELETE FROM report_saved_view_shares s
  USING report_saved_views v
  WHERE v.id = s.view_id
    AND s.view_id = p_view_id
    AND s.user_id = p_user_id
    AND (v.user_id = v_caller_id OR s.user_id = v_caller_id);
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  IF v_removed = 0 THEN
    RAISE EXCEPTION 'Saved view not found';
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261112160000';
