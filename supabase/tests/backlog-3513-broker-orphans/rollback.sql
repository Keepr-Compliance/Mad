-- BACKLOG-3513 orphans: rollback of migration 20261112210000.
-- Drops broker_report_orphans and restores broker_report_def_get to its 20261112200000 body
-- (verbatim below), with the same grants. 20261112210000 writes no data, so nothing else to undo.
DROP FUNCTION IF EXISTS public.broker_report_orphans(uuid);
CREATE OR REPLACE FUNCTION public.broker_report_def_get(p_def uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_level text;
  d public.broker_report_definitions%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  v_level := public._broker_report_level(p_def);
  IF v_level IS NULL THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  SELECT * INTO d FROM public.broker_report_definitions WHERE id = p_def;
  RETURN jsonb_build_object(
    'id', d.id, 'organization_id', d.organization_id, 'dataset_key', d.dataset_key,
    'name', d.name, 'description', d.description, 'definition', d.definition,
    'row_scope', d.row_scope, 'general_access', d.general_access, 'level', v_level,
    'owner', jsonb_build_object('name', public._broker_report_person_name(d.owner_user_id),
                                'is_you', d.owner_user_id IS NOT DISTINCT FROM v_uid),
    'updated_at', d.updated_at);
END
$function$;
REVOKE ALL ON FUNCTION public.broker_report_def_get(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_report_def_get(uuid) TO authenticated;
