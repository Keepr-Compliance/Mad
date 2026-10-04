-- BACKLOG-3654 (BACKLOG-3611 batch G): support staff check inside three
-- support functions, and EXECUTE removed from PUBLIC and anon.
--
-- Each body is the current definition with one inserted check, the same
-- check support_update_template uses: the caller must hold an internal role.
-- authenticated and service_role keep EXECUTE.

-- support_get_ticket_stats: require an internal_roles caller.
CREATE OR REPLACE FUNCTION public.support_get_ticket_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_by_status JSONB;
  v_by_priority JSONB;
  v_total INT;
  v_unassigned INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Support agent access required' USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(*) INTO v_total FROM support_tickets WHERE status NOT IN ('closed');
  SELECT COUNT(*) INTO v_unassigned FROM support_tickets WHERE assignee_id IS NULL AND status NOT IN ('resolved', 'closed');

  SELECT COALESCE(jsonb_object_agg(status, cnt), '{}'::jsonb) INTO v_by_status
  FROM (SELECT status, COUNT(*) as cnt FROM support_tickets GROUP BY status) s;

  SELECT COALESCE(jsonb_object_agg(priority, cnt), '{}'::jsonb) INTO v_by_priority
  FROM (SELECT priority, COUNT(*) as cnt FROM support_tickets WHERE status NOT IN ('closed') GROUP BY priority) p;

  RETURN jsonb_build_object(
    'total_open', v_total,
    'unassigned', v_unassigned,
    'by_status', v_by_status,
    'by_priority', v_by_priority
  );
END;
$function$
;

REVOKE EXECUTE ON FUNCTION public.support_get_ticket_stats() FROM PUBLIC, anon;

-- support_list_templates: require an internal_roles caller.
CREATE OR REPLACE FUNCTION public.support_list_templates()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Support agent access required' USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', t.id,
        'name', t.name,
        'body', t.body,
        'category', t.category,
        'is_active', t.is_active,
        'created_by', t.created_by,
        'created_at', t.created_at,
        'updated_at', t.updated_at
      ) ORDER BY t.name
    )
    FROM support_response_templates t
    WHERE t.is_active = true
  ), '[]'::jsonb);
END;
$function$
;

REVOKE EXECUTE ON FUNCTION public.support_list_templates() FROM PUBLIC, anon;

-- support_list_all_templates: require an internal_roles caller.
CREATE OR REPLACE FUNCTION public.support_list_all_templates()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Support agent access required' USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', t.id,
        'name', t.name,
        'body', t.body,
        'category', t.category,
        'is_active', t.is_active,
        'created_by', t.created_by,
        'created_at', t.created_at,
        'updated_at', t.updated_at
      ) ORDER BY t.name
    )
    FROM support_response_templates t
  ), '[]'::jsonb);
END;
$function$
;

REVOKE EXECUTE ON FUNCTION public.support_list_all_templates() FROM PUBLIC, anon;
