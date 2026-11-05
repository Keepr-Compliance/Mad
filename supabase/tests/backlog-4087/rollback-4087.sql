-- BACKLOG-4087 rollback (keepr-test, or production with a go). Restores report_list_saved_views (4084
-- body), report_save_view and report_delete_saved_view (3450 bodies) exactly as pg_get_functiondef
-- printed them on keepr-test before the apply (md5 of each definition: list 08fc7184, save 8be16a22,
-- remove 764b06c5), removes the five BACKLOG-4087 functions, the shares table and the version row.
-- CREATE OR REPLACE keeps the three restored functions' grants as they are.
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
$function$;

CREATE OR REPLACE FUNCTION public.report_save_view(p_report_key text, p_name text, p_filters jsonb, p_metric jsonb, p_pinned boolean DEFAULT false, p_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.report_delete_saved_view(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

DROP FUNCTION IF EXISTS public.report_share_remove(uuid, uuid);
DROP FUNCTION IF EXISTS public.report_share_set(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.report_share_list(uuid);
DROP FUNCTION IF EXISTS public.report_share_candidates(uuid);
DROP FUNCTION IF EXISTS public._report_share_eligible(uuid);
DROP TABLE IF EXISTS public.report_saved_view_shares;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261104200000';
