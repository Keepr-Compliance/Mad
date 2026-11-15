-- BACKLOG-3513 PR-3f rollback (20261112220000_backlog_3513_broker_report_reassign.sql).
-- Drops the three functions the migration created, restores broker_report_def_get to its
-- 20261112210000 body (md5 cb8bc16c908873fb53cf0ff34b146b7b) and re-creates broker_report_take_over
-- at its 20261112200000 body (md5 b6b0d7843e1f1308f24c5cdd1af19406) with its grants.
-- Rows broker_report_reassign wrote to public.billing_change_log (report_owner_changed, via
-- 'reassign') STAY, and owners it set stay set.
-- Run as a migration-capable role, in one transaction.

DROP FUNCTION IF EXISTS public.broker_report_reassign_candidates(uuid);
DROP FUNCTION IF EXISTS public.broker_report_reassign(uuid, uuid);

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
    'updated_at', d.updated_at,
    -- the test broker_report_take_over applies (20261112200000 F18), for this caller
    'take_over_available', (
      coalesce(public._broker_report_member_role(d.organization_id, v_uid), '') IN ('broker', 'admin', 'it_admin')
      AND coalesce(public._org_feature_allowed(d.organization_id, 'broker_reports'), false)
      AND d.owner_user_id IS DISTINCT FROM v_uid
      AND (d.owner_user_id IS NULL
           OR public._broker_report_member_role(d.organization_id, d.owner_user_id) IS NULL)));
END
$function$;

CREATE OR REPLACE FUNCTION public.broker_report_take_over(p_def uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  d public.broker_report_definitions%ROWTYPE;
  v_member uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO d FROM public.broker_report_definitions WHERE id = p_def FOR UPDATE;
  IF NOT FOUND
     OR coalesce(public._broker_report_member_role(d.organization_id, v_uid), '') NOT IN ('broker', 'admin', 'it_admin')
     OR NOT coalesce(public._org_feature_allowed(d.organization_id, 'broker_reports'), false)
     OR (d.owner_user_id IS NOT NULL
         AND public._broker_report_member_role(d.organization_id, d.owner_user_id) IS NOT NULL) THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  UPDATE public.broker_report_definitions SET owner_user_id = v_uid WHERE id = p_def;
  DELETE FROM public.broker_report_definition_grants
   WHERE definition_id = p_def AND principal_type = 'user' AND principal_user_id = v_uid;
  SELECT m.id INTO v_member FROM public.organization_members m
   WHERE m.organization_id = d.organization_id AND m.user_id = v_uid LIMIT 1;
  PERFORM public._broker_report_audit(d.organization_id, p_def, d.name, 'report_owner_changed',
    jsonb_build_object('member_id', v_member, 'via', 'take_over'));
  RETURN jsonb_build_object('success', true);
END
$function$;

DROP FUNCTION IF EXISTS public._broker_report_reassign_eligible(uuid);

REVOKE ALL ON FUNCTION public.broker_report_def_get(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_report_def_get(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.broker_report_take_over(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_report_take_over(uuid) TO authenticated;
