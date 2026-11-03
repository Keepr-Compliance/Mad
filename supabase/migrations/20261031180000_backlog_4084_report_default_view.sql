-- BACKLOG-4084 — a default saved view per report
--
-- Adds one flag to `report_saved_views` (BACKLOG-3450): the view a report
-- opens with when the URL names no filters and no period. At most ONE default
-- per user per report, enforced by a partial unique index.
--
-- The time range of a view is stored inside the existing `filters` JSONB as
-- `period: { key, from?, to? }`. The 3450 header ("the PERIOD is deliberately
-- not stored") is superseded by the founder's answer in pm_comments dbb69fd4
-- on BACKLOG-4083. No column and no parameter is added for it, so
-- `report_save_view` keeps its signature (a new parameter would create an
-- overload with its own grants).
--
-- Changes:
--   1. column is_default BOOLEAN NOT NULL DEFAULT false
--   2. unique index report_saved_views_one_default (user_id, report_key) WHERE is_default
--   3. NEW report_set_default_view(p_report_key TEXT, p_id UUID) RETURNS JSONB
--   4. report_list_saved_views(TEXT) returns is_default. Same signature and the
--      same JSONB return type, so CREATE OR REPLACE is enough (no DROP); its
--      grant pair is restated below anyway.
--   report_save_view and report_delete_saved_view are unchanged: a save never
--   touches is_default, and deleting the default view leaves no default.
--
-- Idempotent: every statement can run twice.
-- Rollback: supabase/tests/backlog-4084/rollback-4084.sql.

-- ============================================================
-- 1. Column
-- ============================================================
ALTER TABLE public.report_saved_views
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.report_saved_views.is_default IS
  'BACKLOG-4084: the view this report opens with when the URL names no filters and no period. At most one per (user_id, report_key); written only by report_set_default_view.';

-- ============================================================
-- 2. One default per user per report
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS report_saved_views_one_default
  ON public.report_saved_views (user_id, report_key)
  WHERE is_default;

-- ============================================================
-- 3. report_set_default_view — make one of the caller's views the default
--    for a report, or clear the default (p_id NULL)
-- ============================================================
CREATE OR REPLACE FUNCTION public.report_set_default_view(p_report_key TEXT, p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
BEGIN
  IF v_caller_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Access denied: internal role required' USING ERRCODE = '42501';
  END IF;

  IF coalesce(btrim(p_report_key), '') = '' THEN
    RAISE EXCEPTION 'A report key is required';
  END IF;

  -- Serialise concurrent calls by the same user for the same report.
  PERFORM 1
  FROM report_saved_views v
  WHERE v.user_id = v_caller_id
    AND v.report_key = p_report_key
  FOR UPDATE;

  -- Owner and report check. One message for a missing id, another user's
  -- view and a view of another report.
  IF p_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM report_saved_views v
    WHERE v.id = p_id
      AND v.user_id = v_caller_id
      AND v.report_key = p_report_key
  ) THEN
    RAISE EXCEPTION 'Saved view not found';
  END IF;

  -- Two statements: the unique index is checked per row, so the old default
  -- is cleared before the new one is set.
  UPDATE report_saved_views v
  SET is_default = false
  WHERE v.user_id = v_caller_id
    AND v.report_key = p_report_key
    AND v.is_default
    AND (p_id IS NULL OR v.id <> p_id);

  IF p_id IS NOT NULL THEN
    UPDATE report_saved_views v
    SET is_default = true
    WHERE v.id = p_id
      AND v.user_id = v_caller_id
      AND v.report_key = p_report_key
      AND NOT v.is_default;
  END IF;

  RETURN jsonb_build_object('default_id', p_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.report_set_default_view(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_set_default_view(TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION public.report_set_default_view(TEXT, UUID) IS
  'BACKLOG-4084: set (p_id) or clear (NULL) the caller''s default saved view for one report. Owner only.';

-- ============================================================
-- 4. report_list_saved_views — now returns is_default
-- ============================================================
CREATE OR REPLACE FUNCTION public.report_list_saved_views(p_report_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_views JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id,
    'name', v.name,
    'filters', v.filters,
    'metric', v.metric,
    'pinned', v.pinned,
    'is_default', v.is_default,
    'created_at', v.created_at
  ) ORDER BY v.name ASC), '[]'::jsonb)
  INTO v_views
  FROM report_saved_views v
  -- Owner only. This function is SECURITY DEFINER, so the table's RLS policy
  -- does not apply here; this predicate does.
  WHERE v.user_id = v_caller_id
    AND v.report_key = p_report_key;

  RETURN v_views;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.report_list_saved_views(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_list_saved_views(TEXT) TO authenticated;
