-- ============================================================================
-- Migration: broker shared reports whose owner is gone — the take-over list and flag
-- Backlog: BACKLOG-3513 (broker side, PR-3b fix-up). Version granted by the coordinator.
--
-- Founder ruling: any active broker, admin or IT admin of the brokerage may take over a report
-- whose owner is gone or deactivated, whether or not the report is shared with them.
-- broker_report_take_over (20261112200000) already allows exactly that and is NOT changed here.
-- This file only lets those people FIND such a report and know the button applies:
--
--   broker_report_orphans(p_org)  NEW. For an active broker / admin / IT admin of p_org with
--     broker_reports on: the reports in p_org whose owner is NULL or no longer an active member,
--     as {id, name, dataset_key, owner_name, owner_state 'gone' | 'deactivated', level}.
--     `level` is the caller's own level (NULL when the report is not shared with them).
--     No definition, no filters, no rows: opening the report still needs a level.
--   broker_report_def_get(p_def)  REPLACED with one extra key, take_over_available: the same
--     test broker_report_take_over applies (active broker / admin / IT admin caller, broker_reports
--     on, owner NULL or not an active member, caller not the owner). Refusals are unchanged: a
--     caller without a level still gets 'Report not found'. No raw owner-active field.
--
-- Rules: SECURITY DEFINER, search_path pinned, auth.uid() first (42501 when NULL), every refusal
-- 'Report not found'. REVOKE FROM PUBLIC, anon; GRANT EXECUTE TO authenticated, full signatures.
--
-- Pre-pin: stops unless 20261112200000 is recorded and the functions this file relies on are at
-- that file's bodies (def_get may also be at this file's body, for a second run).
-- Idempotent: CREATE OR REPLACE, then REVOKE / GRANT.
-- Rollback: supabase/tests/backlog-3513-broker-orphans/rollback.sql (restores the
-- 20261112200000 def_get body, drops broker_report_orphans). No data is written by this file.
-- ============================================================================

DO $pin$
DECLARE r record;
BEGIN
  IF (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261112200000') <> 1 THEN
    RAISE EXCEPTION 'BACKLOG-3513 orphans: 20261112200000 must be applied first';
  END IF;
  FOR r IN
    SELECT v.sig, v.ok, md5(p.prosrc) AS cur
      FROM (VALUES
        ('public.broker_report_def_get(uuid)', ARRAY['28ce388e045b149e474fa2d8540e1586', 'cb8bc16c908873fb53cf0ff34b146b7b']),
        ('public._broker_report_member_role(uuid,uuid)', ARRAY['efe997c5ed850264d7080c9292fe6f55']),
        ('public._broker_report_level(uuid)', ARRAY['c1d596814954e58c1b4fe6ae10b03823']),
        ('public._broker_report_person_name(uuid)', ARRAY['7b82b4b6c1d64915e2e6e87685352401']),
        ('public.broker_report_take_over(uuid)', ARRAY['b6b0d7843e1f1308f24c5cdd1af19406'])
      ) AS v(sig, ok)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(v.sig)
  LOOP
    IF r.cur IS NULL OR NOT (r.cur = ANY (r.ok)) THEN
      RAISE EXCEPTION 'BACKLOG-3513 orphans: % body changed (md5 %); re-review before applying', r.sig, r.cur;
    END IF;
  END LOOP;
END
$pin$;

-- ---------------------------------------------------------------------------
-- F8 (replaced): one definition, for anyone with a level on it, plus take_over_available.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- NEW: reports in p_org whose owner is gone or deactivated, for the people who may take them over.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_orphans(p_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_org IS NULL
     OR coalesce(public._broker_report_member_role(p_org, v_uid), '') NOT IN ('broker', 'admin', 'it_admin')
     OR NOT coalesce(public._org_feature_allowed(p_org, 'broker_reports'), false) THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  RETURN (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', d.id, 'name', d.name, 'dataset_key', d.dataset_key,
             'owner_name', public._broker_report_person_name(d.owner_user_id),
             'owner_state', CASE WHEN d.owner_user_id IS NULL THEN 'gone' ELSE 'deactivated' END,
             'level', public._broker_report_level(d.id))
             ORDER BY d.name, d.id), '[]'::jsonb)
      FROM public.broker_report_definitions d
     WHERE d.organization_id = p_org
       AND (d.owner_user_id IS NULL
            OR public._broker_report_member_role(d.organization_id, d.owner_user_id) IS NULL));
END
$function$;

REVOKE ALL ON FUNCTION public.broker_report_def_get(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.broker_report_orphans(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_report_def_get(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broker_report_orphans(uuid) TO authenticated;

COMMENT ON FUNCTION public.broker_report_orphans(uuid) IS
  'BACKLOG-3513: reports whose owner is gone or deactivated, for an active broker / admin / IT admin of the organization. No definition or rows.';
