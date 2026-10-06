-- BACKLOG-3450 — saved views for the analytics reports
--
-- One table serves every report; `report_key` names which one. A saved view is
-- a set of client-side filters plus the column and function a pinned card
-- renders. The PERIOD is deliberately not stored: a pinned card keeps its
-- saved filters and follows whichever period is selected on the page, so a
-- stored period would let a card contradict the selector above it.
--
-- OWNER ONLY. Narrower than `pm_saved_views`, which also exposes
-- `is_shared = true` rows. There is no sharing requirement here, so `is_shared`
-- is omitted rather than added and left unused.
--
-- TWO LAYERS, ON PURPOSE.
--   1. The RLS policy below — defence in depth for any direct table read.
--   2. The three SECURITY DEFINER RPCs — what the running app actually calls.
--      A SECURITY DEFINER function BYPASSES RLS, so the policy does not guard
--      the app's path; each RPC isolates by its own `user_id = v_caller_id`.
--      That is the property the control script in
--      `supabase/tests/backlog-3450/` exercises, and it is why that script
--      calls the RPCs rather than only selecting from the table.

-- ============================================================
-- Table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.report_saved_views (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  report_key  TEXT NOT NULL,
  name        TEXT NOT NULL,
  -- {types, outcomes, platforms, search, stalledOnly} — read back defensively
  -- by the client, which falls back to "no filters" on anything unexpected.
  filters     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- {col, fn} — the column and function the pinned card renders.
  metric      JSONB NOT NULL,
  pinned      BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_saved_views_user_report
  ON public.report_saved_views(user_id, report_key);

-- ============================================================
-- Grants
--
-- A new table in `public` inherits default privileges that grant `anon` full
-- DML (INSERT/SELECT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER). RLS with no
-- write policy still denies the writes, but the privilege should not be there
-- to deny. Revoke first, then grant exactly what is needed: SELECT to
-- `authenticated`, which the policy below then narrows to the owner's rows.
-- Every write goes through an RPC, so no write privilege is granted to anyone.
-- ============================================================
REVOKE ALL ON public.report_saved_views FROM anon, authenticated;
GRANT SELECT ON public.report_saved_views TO authenticated;

-- ============================================================
-- RLS — owner only
-- ============================================================
ALTER TABLE public.report_saved_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read their own report views" ON public.report_saved_views;
CREATE POLICY "Users can read their own report views"
  ON public.report_saved_views FOR SELECT
  USING (
    -- `internal_roles.user_id` is qualified: unqualified it binds to the inner
    -- table by scoping luck, and a rename would silently rebind it to the
    -- outer `report_saved_views.user_id` while still compiling.
    EXISTS (
      SELECT 1 FROM internal_roles
      WHERE internal_roles.user_id = (select auth.uid())
    )
    AND user_id = (select auth.uid())
  );

-- `updated_at` maintenance mirrors `pm_saved_views`. The UPDATE branch of
-- `report_save_view` also sets it explicitly, so the RPC does not depend on
-- this trigger existing.
DROP TRIGGER IF EXISTS report_saved_views_updated_at ON public.report_saved_views;
CREATE TRIGGER report_saved_views_updated_at
  BEFORE UPDATE ON public.report_saved_views
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- report_list_saved_views — the caller's own views for one report
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
  IF NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id,
    'name', v.name,
    'filters', v.filters,
    'metric', v.metric,
    'pinned', v.pinned,
    'created_at', v.created_at
  ) ORDER BY v.name ASC), '[]'::jsonb)
  INTO v_views
  FROM report_saved_views v
  -- THE ISOLATION. This function is SECURITY DEFINER, so the RLS policy above
  -- does not apply to it: delete this line and every internal user sees every
  -- other internal user's saved views, with no error anywhere.
  WHERE v.user_id = v_caller_id
    AND v.report_key = p_report_key;

  RETURN v_views;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.report_list_saved_views(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_list_saved_views(TEXT) TO authenticated;

-- ============================================================
-- report_save_view — INSERT when p_id is NULL, otherwise UPDATE in place
--
-- An UPSERT rather than the delete-and-recreate `pm_saved_views` needs (it has
-- no update RPC, so `SavedViewSelector.handleToggleGauge` deletes and recreates
-- and the row's id changes on every pin toggle). Pinning is a first-class
-- action here — max five cards, click to apply — so the id has to survive it.
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
  v_pinned_count INT;
  v_view_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required';
  END IF;

  IF coalesce(btrim(p_name), '') = '' THEN
    RAISE EXCEPTION 'A saved view needs a name';
  END IF;

  IF p_metric IS NULL OR p_metric->>'col' IS NULL OR p_metric->>'fn' IS NULL THEN
    RAISE EXCEPTION 'A saved view needs a column and a function';
  END IF;

  -- The pin cap is enforced HERE, not only in the browser: two tabs defeat a
  -- client-side guard and the sixth card is then a permanent render bug. The
  -- row being updated is excluded from its own count, so renaming or
  -- re-saving an already-pinned card cannot refuse itself.
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
    SELECT user_id INTO v_owner_id FROM report_saved_views WHERE id = p_id;

    -- A p_id that matches no row RAISES. It must never insert under an id the
    -- caller chose.
    IF v_owner_id IS NULL THEN
      RAISE EXCEPTION 'Saved view not found: %', p_id;
    END IF;

    IF v_owner_id != v_caller_id THEN
      RAISE EXCEPTION 'Only the view owner can update it';
    END IF;

    UPDATE report_saved_views
    SET name = btrim(p_name),
        filters = coalesce(p_filters, '{}'::jsonb),
        metric = p_metric,
        pinned = p_pinned,
        updated_at = now()
    WHERE id = p_id
    RETURNING id INTO v_view_id;
  END IF;

  RETURN jsonb_build_object('id', v_view_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.report_save_view(TEXT, TEXT, JSONB, JSONB, BOOLEAN, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_save_view(TEXT, TEXT, JSONB, JSONB, BOOLEAN, UUID) TO authenticated;

-- ============================================================
-- report_delete_saved_view — owner only
-- ============================================================
CREATE OR REPLACE FUNCTION public.report_delete_saved_view(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_owner_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles WHERE user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Access denied: internal role required';
  END IF;

  SELECT user_id INTO v_owner_id FROM report_saved_views WHERE id = p_id;

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Saved view not found: %', p_id;
  END IF;

  -- THE ISOLATION, again. SECURITY DEFINER bypasses RLS, so without this check
  -- any internal user could delete any other internal user's saved view.
  IF v_owner_id != v_caller_id THEN
    RAISE EXCEPTION 'Only the view owner can delete it';
  END IF;

  DELETE FROM report_saved_views WHERE id = p_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.report_delete_saved_view(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_delete_saved_view(UUID) TO authenticated;

COMMENT ON TABLE public.report_saved_views IS
  'BACKLOG-3450: per-user saved filter sets for the analytics reports. Owner-only; all writes go through report_save_view / report_delete_saved_view.';
