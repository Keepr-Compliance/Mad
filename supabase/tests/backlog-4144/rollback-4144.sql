-- Run rollback-4144 before rollback-4087.
-- BACKLOG-4144 M1 rollback (keepr-test, or production with a go). Restores report_list_saved_views,
-- report_save_view, report_share_candidates and report_share_set to the BACKLOG-4087 bodies exactly as
-- pg_get_functiondef printed them on keepr-test before the M1 apply (md5 of each definition: list
-- a31218b2, save 5a109e6a, candidates 50c4e961, share_set bfe2f5e7), then removes the seven
-- BACKLOG-4144 functions, the report_access and reports tables and the version row.
-- CREATE OR REPLACE keeps the four restored functions' grants as they are.
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
$function$
;

CREATE OR REPLACE FUNCTION public.report_save_view(p_report_key text, p_name text, p_filters jsonb, p_metric jsonb, p_pinned boolean DEFAULT false, p_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.report_share_candidates(p_view_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

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
$function$
;

DROP FUNCTION IF EXISTS public.report_access_candidates(text);
DROP FUNCTION IF EXISTS public.report_access_remove(text, uuid);
DROP FUNCTION IF EXISTS public.report_access_set(text, uuid, text);
DROP FUNCTION IF EXISTS public.report_access_list(text);
DROP FUNCTION IF EXISTS public.report_list_my_reports();
DROP FUNCTION IF EXISTS public.report_my_access(text);
DROP FUNCTION IF EXISTS public._report_access_role(uuid, text);
DROP TABLE IF EXISTS public.report_access;
DROP TABLE IF EXISTS public.reports;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261105100000';
