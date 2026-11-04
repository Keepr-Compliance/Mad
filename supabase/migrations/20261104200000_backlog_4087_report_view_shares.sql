-- BACKLOG-4087 (+ BACKLOG-3511) — share a report saved view with named colleagues
--
-- A saved view (BACKLOG-3450, report_saved_views) stays owned by one user. The owner may share it with
-- other internal users who can open the analytics reports, as a VIEWER (apply only) or an EDITOR (may
-- change the view's filters and its card metric; never its name, its pin or its default flag).
--
-- Rules (founder answers on BACKLOG-4087, pm_comments):
--   * only the owner shares; an editor cannot re-share;
--   * admins see only views shared with them (no role sees every view);
--   * a shared view is apply-only for its recipient: the list reports pinned = false and
--     is_default = false on every shared row, whatever the owner's flags are;
--   * one owner per view.
--
-- ELIGIBILITY. A user may receive or hold a share only while they have an internal role whose role
-- grants the permission key 'analytics.view'. It is checked at READ time, for the recipient AND the
-- owner, on every call. A recipient or an owner who loses the permission (or the internal role) makes
-- the share inert: it is not listed and cannot be edited, without any row being removed.
--
-- ONE REFUSAL. Every id-taking RPC here answers a missing id, another user's view, an ineligible
-- principal and a role that does not allow the action with the same message, 'Saved view not found',
-- with no id in it. That includes report_save_view and report_delete_saved_view (3450), which used to
-- say 'Saved view not found: <id>' / 'Only the view owner can ...'.
--
-- Signatures of report_list_saved_views and report_save_view are unchanged (CREATE OR REPLACE; no
-- overloads). report_list_saved_views starts from the 4084 body; report_save_view and
-- report_delete_saved_view start from the 3450 bodies.
--
-- Idempotent: every statement can run twice.
-- Rollback: supabase/tests/backlog-4087/rollback-4087.sql.

-- ============================================================
-- 1. Table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.report_saved_view_shares (
  view_id     UUID NOT NULL REFERENCES public.report_saved_views(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  -- Always the owner at grant time. No FK: the row must not block or follow a user removal.
  granted_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (view_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_report_saved_view_shares_user
  ON public.report_saved_view_shares(user_id);

-- Reachable only through the SECURITY DEFINER RPCs below. No client privilege at all (this includes
-- the TRUNC privilege, which RLS never evaluates). RLS on with no policies: a direct read returns
-- nothing even if a grant is added by mistake.
REVOKE ALL ON public.report_saved_view_shares FROM PUBLIC, anon, authenticated;
ALTER TABLE public.report_saved_view_shares ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.report_saved_view_shares IS
  'BACKLOG-4087: who a report saved view is shared with (viewer | editor). Written only by report_share_set / report_share_remove; read only through report_list_saved_views / report_share_list.';

-- ============================================================
-- 2. Eligibility helper — PRIVATE
--    A direct join, not has_permission(): has_permission() answers for the CALLER only, and this
--    must answer for another user (the owner, a candidate, a grantee). Not callable by any client
--    role, so it cannot be used to ask "is user X analytics staff".
-- ============================================================
CREATE OR REPLACE FUNCTION public._report_share_eligible(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_user_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM internal_roles ir
    JOIN admin_role_permissions arp ON arp.role_id = ir.role_id
    JOIN admin_permissions ap ON ap.id = arp.permission_id
    WHERE ir.user_id = p_user_id
      AND ap.key = 'analytics.view'
  )
$$;

REVOKE EXECUTE ON FUNCTION public._report_share_eligible(UUID) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._report_share_eligible(UUID) IS
  'BACKLOG-4087: internal role whose role grants analytics.view. Private: called only by the report_share_* / saved-view RPCs.';

-- ============================================================
-- 3. report_list_saved_views — own views, then views shared with the caller
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
  ) x;

  RETURN v_views;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.report_list_saved_views(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_list_saved_views(TEXT) TO authenticated;

-- ============================================================
-- 4. report_save_view — owner: as before. Editor of a shared view: filters + metric only.
-- ============================================================
CREATE OR REPLACE FUNCTION public.report_save_view(
  p_report_key TEXT,
  p_name TEXT,
  p_filters JSONB,
  p_metric JSONB,
  p_pinned BOOLEAN DEFAULT false,
  p_id UUID DEFAULT NULL           -- defaulted parameters must trail
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_owner_id UUID;
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
    SELECT v.user_id INTO v_owner_id FROM report_saved_views v WHERE v.id = p_id FOR UPDATE;

    v_is_editor := v_owner_id IS NOT NULL
      AND v_owner_id <> v_caller_id
      AND EXISTS (
        SELECT 1 FROM report_saved_view_shares s
        WHERE s.view_id = p_id AND s.user_id = v_caller_id AND s.role = 'editor'
      )
      AND public._report_share_eligible(v_caller_id)
      AND public._report_share_eligible(v_owner_id);

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
$$;

REVOKE EXECUTE ON FUNCTION public.report_save_view(TEXT, TEXT, JSONB, JSONB, BOOLEAN, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_save_view(TEXT, TEXT, JSONB, JSONB, BOOLEAN, UUID) TO authenticated;

-- ============================================================
-- 5. report_delete_saved_view (3450) — owner only; one refusal message
-- ============================================================
CREATE OR REPLACE FUNCTION public.report_delete_saved_view(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_view_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required';
  END IF;

  -- One lookup, one combined condition: a missing id and another user's view do the same work and
  -- get the same message. SECURITY DEFINER bypasses RLS, so this predicate is the isolation.
  -- A share recipient (viewer or editor) cannot remove the view.
  SELECT v.id INTO v_view_id
  FROM report_saved_views v
  WHERE v.id = p_id
    AND v.user_id = v_caller_id
  FOR UPDATE;

  IF v_view_id IS NULL THEN
    RAISE EXCEPTION 'Saved view not found';
  END IF;

  DELETE FROM report_saved_views WHERE id = v_view_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.report_delete_saved_view(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_delete_saved_view(UUID) TO authenticated;

-- ============================================================
-- 6. report_share_candidates — who the OWNER may share a view with
-- ============================================================
CREATE OR REPLACE FUNCTION public.report_share_candidates(p_view_id UUID)
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

  IF NOT EXISTS (
    SELECT 1 FROM report_saved_views v
    WHERE v.id = p_view_id
      AND v.user_id = v_caller_id
      AND public._report_share_eligible(v_caller_id)
  ) THEN
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
  ) c;

  RETURN v_out;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.report_share_candidates(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_share_candidates(UUID) TO authenticated;

COMMENT ON FUNCTION public.report_share_candidates(UUID) IS
  'BACKLOG-4087: owner only. Lists every other internal user who can open analytics reports (user id + display name). This WIDENS staff visibility: listing internal users is otherwise gated by the internal_users.view permission, and here any owner of a saved view who holds analytics.view sees the names of all analytics-eligible colleagues.';

-- ============================================================
-- 7. report_share_list — the owner sees every grantee; a grantee sees only their own row
-- ============================================================
CREATE OR REPLACE FUNCTION public.report_share_list(p_view_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_owner_id UUID;
  v_out JSONB;
BEGIN
  IF v_caller_id IS NULL OR NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required' USING ERRCODE = '42501';
  END IF;

  SELECT v.user_id INTO v_owner_id FROM report_saved_views v WHERE v.id = p_view_id;

  IF v_owner_id IS NOT NULL AND v_owner_id = v_caller_id THEN
    -- Owner: every grantee, with whether the share is currently live.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'user_id', s.user_id,
      'display_name', coalesce(nullif(btrim(u.display_name), ''), 'Unnamed user'),
      'role', s.role,
      'active', public._report_share_eligible(s.user_id),
      'created_at', s.created_at
    ) ORDER BY u.display_name, s.user_id), '[]'::jsonb)
    INTO v_out
    FROM report_saved_view_shares s
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.view_id = p_view_id;
    RETURN v_out;
  END IF;

  -- Grantee: their own row only, and only while the share is live. Never other grantees.
  SELECT jsonb_agg(jsonb_build_object(
    'user_id', s.user_id,
    'display_name', coalesce(nullif(btrim(u.display_name), ''), 'Unnamed user'),
    'role', s.role,
    'active', true,
    'created_at', s.created_at
  ))
  INTO v_out
  FROM report_saved_view_shares s
  LEFT JOIN users u ON u.id = s.user_id
  WHERE s.view_id = p_view_id
    AND s.user_id = v_caller_id
    AND v_owner_id IS NOT NULL
    AND public._report_share_eligible(v_caller_id)
    AND public._report_share_eligible(v_owner_id);

  IF v_out IS NULL THEN
    RAISE EXCEPTION 'Saved view not found';
  END IF;
  RETURN v_out;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.report_share_list(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_share_list(UUID) TO authenticated;

-- ============================================================
-- 8. report_share_set — OWNER grants or changes a share (viewer | editor)
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
$$;

REVOKE EXECUTE ON FUNCTION public.report_share_set(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_share_set(UUID, UUID, TEXT) TO authenticated;

-- ============================================================
-- 9. report_share_remove — the owner removes any grantee; a grantee removes only themself
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

REVOKE EXECUTE ON FUNCTION public.report_share_remove(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_share_remove(UUID, UUID) TO authenticated;
