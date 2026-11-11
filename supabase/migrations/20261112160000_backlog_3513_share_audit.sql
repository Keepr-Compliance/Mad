-- BACKLOG-3513 PR-5 — every sharing change writes one admin_audit_logs row
--
-- The four sharing RPCs now record the level that was set:
--   report_access_set(text, uuid, text)     action report_access.set
--   report_access_remove(text, uuid)        action report_access.remove
--   report_share_set(uuid, uuid, text)      action report_share.set
--   report_share_remove(uuid, uuid)         action report_share.remove
-- Each row is written through public.log_admin_action (actor_id = auth.uid()), with
-- target_type 'user' and target_id = the grantee, so the admin Audit Log page names the person.
-- metadata, keys always present (JSON null when there is no value):
--   access: {report_key, user_id, from_level, to_level}
--   share:  {view_id, report_key (the VIEW's report), user_id, from_level, to_level}
-- from_level is NULL on a first grant; to_level is NULL on a remove.
--
-- Unchanged level: a set to the level the user already holds writes NO audit row. The existing upsert
-- still runs on that call, so granted_by and updated_at on the grant row are bumped (unchanged from
-- before this file). An unchanged re-grant therefore leaves no trace in the audit log.
--
-- Not audited by this file (out of scope): rows removed by foreign-key cascades —
--   a saved view deleted          -> its report_saved_view_shares rows
--   an auth user deleted          -> their report_access and report_saved_view_shares rows
--   a report deleted from reports -> its report_access rows
--
-- Bodies start from the current ones (report_access_set, report_access_remove and report_share_set
-- from 20261105100000; report_share_remove from 20261104200000). Signatures, caller checks, refusal
-- text and return values are unchanged; only the old-level read and the audit call are added.
-- report_access_set also takes a transaction advisory lock per (report, user) before reading the old
-- level, so two concurrent first grants are serialized and the second records the first's level.
-- No new function; the existing grants are restated unchanged.
--
-- Pre-pin: stops unless 20261105100000 is recorded, each of the four bodies is the text this file
-- replaces or this file's text, and exactly one public.log_admin_action exists with the known body.
-- Rollback: supabase/tests/backlog-3513-p5/rollback-3513-p5.sql.

DO $pin$
DECLARE r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261105100000') THEN
    RAISE EXCEPTION 'BACKLOG-3513 PR-5: migration 20261105100000 (BACKLOG-4144) is not recorded; apply it first';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'log_admin_action') <> 1
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.log_admin_action(text,text,text,jsonb,inet,text)'))
        IS DISTINCT FROM '4793571138164901ad451d3cc09b2224' THEN
    RAISE EXCEPTION 'BACKLOG-3513 PR-5: public.log_admin_action is not the single known function; re-review before applying';
  END IF;
  FOR r IN
    SELECT v.sig, v.prev, v.post, md5(p.prosrc) AS cur
      FROM (VALUES
        ('public.report_access_set(text,uuid,text)', 'cce862164b14e9f6cf48f62ec875b226', 'f990c203ad8bbb7e1ae3ac5567cb9224'),
        ('public.report_access_remove(text,uuid)', '48f078c8dba63a4bfb90b3cb59df1672', 'a8e59d9c838f2e4ae4e37787b5fe5817'),
        ('public.report_share_set(uuid,uuid,text)', '6cc31aece22873a562551ed0c7265620', '14f7bb3d73f8caa3abf884a95cc8a688'),
        ('public.report_share_remove(uuid,uuid)', 'c8af0079e34f296a7c245d3ac1a4f837', '15ac98396af7aa635006be8fb0c6eef7')
      ) AS v(sig, prev, post)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(v.sig)
  LOOP
    IF r.cur IS NULL THEN
      RAISE EXCEPTION 'BACKLOG-3513 PR-5: % not found', r.sig;
    END IF;
    IF r.cur NOT IN (r.prev, r.post) THEN
      RAISE EXCEPTION 'BACKLOG-3513 PR-5: % body changed (md5 %); re-review before applying', r.sig, r.cur;
    END IF;
  END LOOP;
END
$pin$;

-- ============================================================
-- 1. report_access_set — OWNER grants or changes access (viewer | editor)
-- ============================================================
CREATE OR REPLACE FUNCTION public.report_access_set(p_key TEXT, p_user_id UUID, p_role TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_old TEXT;
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

  -- Serialize sets on one (report, user), so the level read below is the one this call replaces,
  -- including when no row exists yet (FOR UPDATE alone cannot lock a missing row).
  PERFORM pg_advisory_xact_lock(hashtextextended('report_access:' || p_key || ':' || p_user_id::text, 3513));

  SELECT ra.role INTO v_old
  FROM report_access ra
  WHERE ra.report_key = p_key AND ra.user_id = p_user_id
  FOR UPDATE;

  INSERT INTO report_access (report_key, user_id, role, granted_by)
  VALUES (p_key, p_user_id, p_role, v_caller_id)
  ON CONFLICT (report_key, user_id)
  DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, updated_at = now();

  IF v_old IS DISTINCT FROM p_role THEN
    PERFORM public.log_admin_action('report_access.set', 'user', p_user_id::text,
      jsonb_build_object('report_key', p_key, 'user_id', p_user_id, 'from_level', v_old, 'to_level', p_role));
  END IF;

  RETURN jsonb_build_object('report_key', p_key, 'user_id', p_user_id, 'role', p_role);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.report_access_set(TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_access_set(TEXT, UUID, TEXT) TO authenticated;

-- ============================================================
-- 2. report_access_remove — an owner removes anyone's access; a grantee may remove their own
-- ============================================================
CREATE OR REPLACE FUNCTION public.report_access_remove(p_key TEXT, p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_removed INT;
  v_old TEXT;
BEGIN
  IF v_caller_id IS NULL OR NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required' USING ERRCODE = '42501';
  END IF;

  DELETE FROM report_access ra
  WHERE ra.report_key = p_key
    AND ra.user_id = p_user_id
    AND (ra.user_id = v_caller_id
         OR public._report_access_role(v_caller_id, p_key) IS NOT DISTINCT FROM 'owner')
  RETURNING ra.role INTO v_old;
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  IF v_removed = 0 THEN
    RAISE EXCEPTION 'Report not found';
  END IF;

  PERFORM public.log_admin_action('report_access.remove', 'user', p_user_id::text,
    jsonb_build_object('report_key', p_key, 'user_id', p_user_id, 'from_level', v_old, 'to_level', NULL));

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.report_access_remove(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_access_remove(TEXT, UUID) TO authenticated;

-- ============================================================
-- 3. report_share_set — the view owner shares a saved view (viewer | editor)
-- ============================================================
CREATE OR REPLACE FUNCTION public.report_share_set(p_view_id UUID, p_user_id UUID, p_role TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_view_id UUID;
  v_report_key TEXT;
  v_old TEXT;
BEGIN
  IF v_caller_id IS NULL OR NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required' USING ERRCODE = '42501';
  END IF;

  IF p_role IS NULL OR p_role NOT IN ('viewer', 'editor') THEN
    RAISE EXCEPTION 'A share role must be viewer or editor';
  END IF;

  -- One lookup, one combined condition. Owner only (an editor cannot re-share); the owner and the
  -- principal must both be eligible; never the owner themself. Every failure: the same message.
  -- The view-row lock serializes every set on this view.
  SELECT v.id, v.report_key INTO v_view_id, v_report_key
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

  SELECT s.role INTO v_old
  FROM report_saved_view_shares s
  WHERE s.view_id = v_view_id AND s.user_id = p_user_id
  FOR UPDATE;

  INSERT INTO report_saved_view_shares (view_id, user_id, role, granted_by)
  VALUES (v_view_id, p_user_id, p_role, v_caller_id)
  ON CONFLICT (view_id, user_id)
  DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, updated_at = now();

  IF v_old IS DISTINCT FROM p_role THEN
    PERFORM public.log_admin_action('report_share.set', 'user', p_user_id::text,
      jsonb_build_object('view_id', v_view_id, 'report_key', v_report_key, 'user_id', p_user_id,
                         'from_level', v_old, 'to_level', p_role));
  END IF;

  RETURN jsonb_build_object('view_id', v_view_id, 'user_id', p_user_id, 'role', p_role);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.report_share_set(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_share_set(UUID, UUID, TEXT) TO authenticated;

-- ============================================================
-- 4. report_share_remove — the owner removes any grantee; a grantee removes only themself
-- ============================================================
CREATE OR REPLACE FUNCTION public.report_share_remove(p_view_id UUID, p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_removed INT;
  v_old TEXT;
  v_report_key TEXT;
BEGIN
  IF v_caller_id IS NULL OR NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required' USING ERRCODE = '42501';
  END IF;

  DELETE FROM report_saved_view_shares s
  USING report_saved_views v
  WHERE v.id = s.view_id
    AND s.view_id = p_view_id
    AND s.user_id = p_user_id
    AND (v.user_id = v_caller_id OR s.user_id = v_caller_id)
  RETURNING s.role, v.report_key INTO v_old, v_report_key;
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  IF v_removed = 0 THEN
    RAISE EXCEPTION 'Saved view not found';
  END IF;

  PERFORM public.log_admin_action('report_share.remove', 'user', p_user_id::text,
    jsonb_build_object('view_id', p_view_id, 'report_key', v_report_key, 'user_id', p_user_id,
                       'from_level', v_old, 'to_level', NULL));

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.report_share_remove(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_share_remove(UUID, UUID) TO authenticated;
