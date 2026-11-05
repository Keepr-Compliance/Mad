-- BACKLOG-4144 M1 — per-report access (additive)
--
-- A catalog of the admin-portal reports and, per report, who may open it.
--
-- Rules (founder answers on BACKLOG-4144, pm_comments):
--   * every Super Admin owns and sees every report. "Super Admin" here = an internal role whose
--     admin_roles.is_system is true. ANY future is_system role becomes an owner of all reports;
--   * access starts closed: no report_access rows are seeded;
--   * viewer = may open the report and apply saved views shared with them;
--   * editor = viewer, plus may share their own saved views on that report with people who already
--     have access to it;
--   * only owners (Super Admins) grant or change report access;
--   * a saved view shared with someone stays hidden from them until they have access to its report.
--
-- ELIGIBILITY. Any access (owner included) also needs an internal role that grants analytics.view
-- (public._report_share_eligible, BACKLOG-4087). It is re-checked on every call, so a role change or a
-- removed row takes effect on the next read.
--
-- ONE REFUSAL. Every report_access_* RPC answers an unknown key, a non-owner caller, an ineligible
-- grantee, an owner as grantee, and the caller as grantee with the same message, 'Report not found'.
-- The four BACKLOG-4087 functions amended here keep their own single message, 'Saved view not found'.
--
-- NOT IN THIS MIGRATION: no RLS policy changes (that is M2, 20261105110000).
--
-- The four amended 4087 functions (report_list_saved_views, report_save_view, report_share_candidates,
-- report_share_set) start from the bodies pg_get_functiondef printed on keepr-test after 20261104200000;
-- signatures are unchanged (CREATE OR REPLACE; no overloads).
--
-- Idempotent: every statement can run twice.
-- Rollback: supabase/tests/backlog-4144/rollback-4144.sql.

-- ============================================================
-- 1. Report catalog
-- ============================================================
CREATE TABLE IF NOT EXISTS public.reports (
  report_key  TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The registry slugs (admin-portal/lib/reports/registry.ts); reportViewKey(slug) returns the slug, so
-- these are also the saved-view keys.
INSERT INTO public.reports (report_key) VALUES
  ('analytics'),
  ('iphone-sync'),
  ('google-messages-sync'),
  ('submissions'),
  ('exports'),
  ('support-sla'),
  ('user-activity'),
  ('funnel')
ON CONFLICT (report_key) DO NOTHING;

REVOKE ALL ON public.reports FROM PUBLIC, anon, authenticated;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.reports IS
  'BACKLOG-4144: the admin-portal report keys (registry slugs). Read only through report_list_my_reports.';

-- ============================================================
-- 2. Report access grants
-- ============================================================
CREATE TABLE IF NOT EXISTS public.report_access (
  report_key  TEXT NOT NULL REFERENCES public.reports(report_key) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  -- The owner who granted it. No FK: the row must not block or follow a user removal.
  granted_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (report_key, user_id)
);

CREATE INDEX IF NOT EXISTS idx_report_access_user
  ON public.report_access(user_id);

-- Reachable only through the SECURITY DEFINER functions below. No client privilege at all (this
-- includes the TRUNC privilege, which RLS never evaluates). RLS on with no policies.
REVOKE ALL ON public.report_access FROM PUBLIC, anon, authenticated;
ALTER TABLE public.report_access ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.report_access IS
  'BACKLOG-4144: who may open a report (viewer | editor). Owners (Super Admins) have no rows. Written only by report_access_set / report_access_remove.';

-- ============================================================
-- 3. Access helper — PRIVATE
--    Answers for ANY user (owner checks, grantees, candidates), so it is a direct join, not
--    is_super_admin() / has_permission(), which answer for the caller only. Not callable by any
--    client role. Returns 'owner' | 'editor' | 'viewer' | NULL.
-- ============================================================
CREATE OR REPLACE FUNCTION public._report_access_role(p_user UUID, p_key TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_user IS NULL OR p_key IS NULL THEN NULL
    WHEN NOT EXISTS (SELECT 1 FROM reports k WHERE k.report_key = p_key) THEN NULL
    WHEN NOT public._report_share_eligible(p_user) THEN NULL
    WHEN EXISTS (
      SELECT 1
      FROM internal_roles ir
      JOIN admin_roles ar ON ar.id = ir.role_id
      WHERE ir.user_id = p_user
        AND ar.is_system
    ) THEN 'owner'
    ELSE (SELECT ra.role FROM report_access ra WHERE ra.report_key = p_key AND ra.user_id = p_user)
  END
$$;

REVOKE EXECUTE ON FUNCTION public._report_access_role(UUID, TEXT) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._report_access_role(UUID, TEXT) IS
  'BACKLOG-4144: a user''s access to one report (owner | editor | viewer | NULL). Private: called only by the report RPCs.';

-- ============================================================
-- 4. report_my_access — the CALLER's access to one report (for RLS in M2 and for the pages)
-- ============================================================
CREATE OR REPLACE FUNCTION public.report_my_access(p_key TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public._report_access_role(auth.uid(), p_key)
$$;

REVOKE EXECUTE ON FUNCTION public.report_my_access(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_my_access(TEXT) TO authenticated;

COMMENT ON FUNCTION public.report_my_access(TEXT) IS
  'BACKLOG-4144: the caller''s access to one report (owner | editor | viewer | NULL). Caller-bound: no user parameter.';

-- ============================================================
-- 5. report_list_my_reports — the reports the caller may open
-- ============================================================
CREATE OR REPLACE FUNCTION public.report_list_my_reports()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_out JSONB;
BEGIN
  IF v_caller_id IS NULL OR NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('report_key', x.report_key, 'access', x.access)
                            ORDER BY x.report_key), '[]'::jsonb)
  INTO v_out
  FROM (
    SELECT k.report_key, public._report_access_role(v_caller_id, k.report_key) AS access
    FROM reports k
  ) x
  WHERE x.access IS NOT NULL;

  RETURN v_out;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.report_list_my_reports() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_list_my_reports() TO authenticated;

-- ============================================================
-- 6. report_access_list — OWNER: every grant on one report
-- ============================================================
CREATE OR REPLACE FUNCTION public.report_access_list(p_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_out JSONB;
BEGIN
  IF v_caller_id IS NULL OR NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required' USING ERRCODE = '42501';
  END IF;

  IF public._report_access_role(v_caller_id, p_key) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Report not found';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'user_id', ra.user_id,
    'display_name', coalesce(nullif(btrim(u.display_name), ''), 'Unnamed user'),
    'role', ra.role,
    'created_at', ra.created_at
  ) ORDER BY u.display_name, ra.user_id), '[]'::jsonb)
  INTO v_out
  FROM report_access ra
  LEFT JOIN users u ON u.id = ra.user_id
  WHERE ra.report_key = p_key;

  RETURN v_out;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.report_access_list(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_access_list(TEXT) TO authenticated;

-- ============================================================
-- 7. report_access_set — OWNER grants or changes access (viewer | editor)
-- ============================================================
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

REVOKE EXECUTE ON FUNCTION public.report_access_set(TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_access_set(TEXT, UUID, TEXT) TO authenticated;

-- ============================================================
-- 8. report_access_remove — an owner removes anyone's access; a grantee may remove their own
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

REVOKE EXECUTE ON FUNCTION public.report_access_remove(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_access_remove(TEXT, UUID) TO authenticated;

-- ============================================================
-- 9. report_access_candidates — OWNER: who may be granted access (id + display name only)
-- ============================================================
CREATE OR REPLACE FUNCTION public.report_access_candidates(p_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_out JSONB;
BEGIN
  IF v_caller_id IS NULL OR NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required' USING ERRCODE = '42501';
  END IF;

  IF public._report_access_role(v_caller_id, p_key) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Report not found';
  END IF;

  -- Eligible internal users other than the caller, never an owner (owners cannot be granted).
  SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id', c.user_id, 'display_name', c.nm)
                            ORDER BY c.nm, c.user_id), '[]'::jsonb)
  INTO v_out
  FROM (
    SELECT DISTINCT ir.user_id, coalesce(nullif(btrim(u.display_name), ''), 'Unnamed user') AS nm
    FROM internal_roles ir
    LEFT JOIN users u ON u.id = ir.user_id
    WHERE ir.user_id <> v_caller_id
      AND public._report_share_eligible(ir.user_id)
      AND public._report_access_role(ir.user_id, p_key) IS DISTINCT FROM 'owner'
  ) c;

  RETURN v_out;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.report_access_candidates(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_access_candidates(TEXT) TO authenticated;

COMMENT ON FUNCTION public.report_access_candidates(TEXT) IS
  'BACKLOG-4144: owner only. Lists every other analytics-eligible internal user who is not an owner (user id + display name).';

-- ============================================================
-- 10. BACKLOG-4087 report_list_saved_views — shared rows need report access
--     (4087 body; one predicate added to the shared branch)
-- ============================================================
CREATE OR REPLACE FUNCTION public.report_list_saved_views(p_report_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID := auth.uid();
  v_views JSONB;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required';
  END IF;

  SELECT COALESCE(jsonb_agg(x.j ORDER BY x.grp, x.nm, x.id), '[]'::jsonb)
  INTO v_views
  FROM (
    -- Own views. This function is SECURITY DEFINER, so the table's RLS policy does not apply here;
    -- this predicate does.
    SELECT 0 AS grp, v.name AS nm, v.id AS id, jsonb_build_object(
      'id', v.id,
      'name', v.name,
      'filters', v.filters,
      'metric', v.metric,
      'pinned', v.pinned,
      'is_default', v.is_default,
      'created_at', v.created_at,
      'access', 'owner'
    ) AS j
    FROM report_saved_views v
    WHERE v.user_id = v_caller_id
      AND v.report_key = p_report_key

    UNION ALL

    -- Views shared with the caller. Masked: a shared view is apply-only, so the owner's pin and
    -- default never reach the recipient. Both users' eligibility is re-checked on every read.
    -- BACKLOG-4144: hidden until the caller has access to the report.
    SELECT 1, v.name, v.id, jsonb_build_object(
      'id', v.id,
      'name', v.name,
      'filters', v.filters,
      'metric', v.metric,
      'pinned', false,
      'is_default', false,
      'created_at', v.created_at,
      'access', s.role,
      'owner_name', coalesce(nullif(btrim(u.display_name), ''), 'Unnamed user')
    )
    FROM report_saved_view_shares s
    JOIN report_saved_views v ON v.id = s.view_id
    LEFT JOIN users u ON u.id = v.user_id
    WHERE s.user_id = v_caller_id
      AND v.user_id <> v_caller_id
      AND v.report_key = p_report_key
      AND public._report_share_eligible(v_caller_id)
      AND public._report_share_eligible(v.user_id)
      AND public._report_access_role(v_caller_id, v.report_key) IS NOT NULL
  ) x;

  RETURN v_views;
END;
$function$;

-- ============================================================
-- 11. BACKLOG-4087 report_save_view — the editor path needs access to the VIEW's report
--     (4087 body; the row's report_key is read with the owner, never the caller's p_report_key)
-- ============================================================
CREATE OR REPLACE FUNCTION public.report_save_view(p_report_key text, p_name text, p_filters jsonb, p_metric jsonb, p_pinned boolean DEFAULT false, p_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID := auth.uid();
  v_owner_id UUID;
  v_view_key TEXT;
  v_is_editor BOOLEAN := false;
  v_pinned_count INT;
  v_view_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required';
  END IF;

  IF p_metric IS NULL OR p_metric->>'col' IS NULL OR p_metric->>'fn' IS NULL THEN
    RAISE EXCEPTION 'A saved view needs a column and a function';
  END IF;

  IF p_id IS NOT NULL THEN
    -- Decide owner vs editor first, on a locked row. A p_id that matches no row RAISES: it must
    -- never insert under an id the caller chose.
    SELECT v.user_id, v.report_key INTO v_owner_id, v_view_key FROM report_saved_views v WHERE v.id = p_id FOR UPDATE;

    v_is_editor := v_owner_id IS NOT NULL
      AND v_owner_id <> v_caller_id
      AND EXISTS (
        SELECT 1 FROM report_saved_view_shares s
        WHERE s.view_id = p_id AND s.user_id = v_caller_id AND s.role = 'editor'
      )
      AND public._report_share_eligible(v_caller_id)
      AND public._report_share_eligible(v_owner_id)
      AND public._report_access_role(v_caller_id, v_view_key) IS NOT NULL;

    -- One message for a missing id, another user's view, a viewer, and an ineligible editor or owner.
    IF v_owner_id IS NULL OR (v_owner_id <> v_caller_id AND NOT v_is_editor) THEN
      RAISE EXCEPTION 'Saved view not found';
    END IF;

    IF v_is_editor THEN
      -- An editor changes the filters and the card metric only. The name, the pin and the default
      -- flag stay the owner's, whatever the client sends; the pin cap is the owner's and is not run.
      UPDATE report_saved_views
      SET filters = coalesce(p_filters, '{}'::jsonb),
          metric = p_metric,
          updated_at = now()
      WHERE id = p_id
      RETURNING id INTO v_view_id;

      RETURN jsonb_build_object('id', v_view_id);
    END IF;
  END IF;

  -- Owner path (insert, or update of the caller's own view).
  IF coalesce(btrim(p_name), '') = '' THEN
    RAISE EXCEPTION 'A saved view needs a name';
  END IF;

  -- The pin cap is enforced HERE, not only in the browser: two tabs defeat a client-side guard and
  -- the sixth card is then a permanent render bug. The row being updated is excluded from its own
  -- count, so renaming or re-saving an already-pinned card cannot refuse itself.
  IF p_pinned THEN
    SELECT count(*) INTO v_pinned_count
    FROM report_saved_views
    WHERE user_id = v_caller_id
      AND report_key = p_report_key
      AND pinned
      AND (p_id IS NULL OR id IS DISTINCT FROM p_id);

    IF v_pinned_count >= 5 THEN
      RAISE EXCEPTION 'At most 5 pinned cards per report. Unpin one first.';
    END IF;
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO report_saved_views (user_id, report_key, name, filters, metric, pinned)
    VALUES (v_caller_id, p_report_key, btrim(p_name), coalesce(p_filters, '{}'::jsonb), p_metric, p_pinned)
    RETURNING id INTO v_view_id;
  ELSE
    UPDATE report_saved_views
    SET name = btrim(p_name),
        filters = coalesce(p_filters, '{}'::jsonb),
        metric = p_metric,
        pinned = p_pinned,
        updated_at = now()
    WHERE id = p_id
      AND user_id = v_caller_id
    RETURNING id INTO v_view_id;
  END IF;

  RETURN jsonb_build_object('id', v_view_id);
END;
$function$;

-- ============================================================
-- 12. BACKLOG-4087 report_share_candidates — only people with access to the view's report
--     (4087 body; the caller must also be allowed to share on that report: editor or owner)
-- ============================================================
CREATE OR REPLACE FUNCTION public.report_share_candidates(p_view_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID := auth.uid();
  v_view_key TEXT;
  v_out JSONB;
BEGIN
  IF v_caller_id IS NULL OR NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required' USING ERRCODE = '42501';
  END IF;

  SELECT v.report_key INTO v_view_key
  FROM report_saved_views v
  WHERE v.id = p_view_id
    AND v.user_id = v_caller_id
    AND public._report_share_eligible(v_caller_id)
    AND public._report_access_role(v_caller_id, v.report_key) IN ('editor', 'owner');

  IF v_view_key IS NULL THEN
    RAISE EXCEPTION 'Saved view not found';
  END IF;

  -- Id and display name only: no email, no role.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id', c.user_id, 'display_name', c.nm)
                            ORDER BY c.nm, c.user_id), '[]'::jsonb)
  INTO v_out
  FROM (
    SELECT ir.user_id, coalesce(nullif(btrim(u.display_name), ''), 'Unnamed user') AS nm
    FROM internal_roles ir
    LEFT JOIN users u ON u.id = ir.user_id
    WHERE ir.user_id <> v_caller_id
      AND public._report_share_eligible(ir.user_id)
      AND public._report_access_role(ir.user_id, v_view_key) IS NOT NULL
  ) c;

  RETURN v_out;
END;
$function$;

-- ============================================================
-- 13. BACKLOG-4087 report_share_set — the sharer needs editor or owner access to the view's report,
--     and the grantee needs access to it (4087 body; two predicates added)
-- ============================================================
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
