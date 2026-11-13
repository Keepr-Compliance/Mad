-- ============================================================================
-- Migration: broker shared reports — Reassign replaces Take over
-- Backlog: BACKLOG-3513 (broker side, PR-3f). Version granted by the coordinator.
--
-- Founder ruling (2026-11-13, "Reassign ... A"): when a report's owner is gone (owner_user_id NULL)
-- or no longer an active member of the brokerage, an active IT admin of that brokerage — or an
-- active admin when the brokerage has NO active IT admin — picks the new owner: any active member
-- of the brokerage, agents included. Nobody else may. Self-take-over is gone.
--
--   _broker_report_reassign_eligible(p_def)   NEW, private. The caller may reassign this report now:
--     broker_reports on in the report's organization; owner NULL or not an active member; caller an
--     active it_admin there, or an active admin there when no active it_admin exists.
--   broker_report_reassign(p_def, p_new_owner)  NEW. Locks the definition row FOR UPDATE first, then
--     re-checks eligibility. Refused ('Report not found') unless eligible, and unless the new owner
--     is an active member of the report's organization and is not the current owner. Sets the owner,
--     removes any person grant the new owner held (as broker_report_transfer does) and writes one
--     report_owner_changed row to billing_change_log: {member_id (new owner), via 'reassign',
--     from (previous owner's name, or null), to (new owner's name), report_name}.
--   broker_report_reassign_candidates(p_def)  NEW. Active members of the report's organization as
--     {kind 'person', id, name, detail = role label}, for an eligible caller only. No email.
--     (broker_report_share_candidates does not fit: it requires owner or editor of the report, and
--     an eligible IT admin or admin may hold only Can view.)
--   broker_report_def_get(p_def)  REPLACED (from the 20261112210000 body): take_over_available is
--     removed; reassign_available = _broker_report_reassign_eligible(p_def). Refusals unchanged.
--   broker_report_take_over(uuid)  DROPPED.
--   broker_report_orphans(uuid)    untouched (no caller; removal filed separately).
--
-- Rules: SECURITY DEFINER, search_path pinned, auth.uid() first (42501 when NULL), every refusal
-- 'Report not found'. REVOKE FROM PUBLIC, anon (private helper: also authenticated); GRANT EXECUTE
-- TO authenticated with full signatures.
--
-- Pre-pin: stops unless 20261112200000 and 20261112210000 are recorded and every function this file
-- replaces or depends on is at its current body (def_get may also be at this file's body, and
-- take_over may already be gone, for a second run).
-- Idempotent: CREATE OR REPLACE / DROP IF EXISTS, then REVOKE / GRANT.
-- Rollback: supabase/tests/backlog-3513-broker-reassign/rollback.sql (restores the 20261112210000
-- def_get body and the 20261112200000 take_over body with its grants; drops the three new
-- functions). Audit rows written by broker_report_reassign stay.
-- ============================================================================

DO $pin$
DECLARE r record;
BEGIN
  IF (SELECT count(*) FROM supabase_migrations.schema_migrations
       WHERE version IN ('20261112200000', '20261112210000')) <> 2 THEN
    RAISE EXCEPTION 'BACKLOG-3513 reassign: 20261112200000 and 20261112210000 must be applied first';
  END IF;
  FOR r IN
    SELECT v.sig, v.ok, v.may_be_gone, md5(p.prosrc) AS cur
      FROM (VALUES
        ('public.broker_report_def_get(uuid)', ARRAY['cb8bc16c908873fb53cf0ff34b146b7b', '8474cc5ea231cc26433f54c48eb6718b'], false),
        ('public.broker_report_take_over(uuid)', ARRAY['b6b0d7843e1f1308f24c5cdd1af19406'], true),
        ('public._broker_report_member_role(uuid,uuid)', ARRAY['efe997c5ed850264d7080c9292fe6f55'], false),
        ('public._broker_report_level(uuid)', ARRAY['c1d596814954e58c1b4fe6ae10b03823'], false),
        ('public._broker_report_person_name(uuid)', ARRAY['7b82b4b6c1d64915e2e6e87685352401'], false),
        ('public._broker_report_audit(uuid,uuid,text,text,jsonb)', ARRAY['57a6d5d44cacc05dfe68a4b3a88ecf86'], false),
        ('public._org_feature_allowed(uuid,text)', ARRAY['fc1007396cdff5e197012dd542888a6a'], false)
      ) AS v(sig, ok, may_be_gone)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(v.sig)
  LOOP
    IF r.cur IS NULL AND r.may_be_gone THEN
      CONTINUE;
    END IF;
    IF r.cur IS NULL OR NOT (r.cur = ANY (r.ok)) THEN
      RAISE EXCEPTION 'BACKLOG-3513 reassign: % body changed (md5 %); re-review before applying', r.sig, r.cur;
    END IF;
  END LOOP;
END
$pin$;

-- ---------------------------------------------------------------------------
-- Private: may the caller reassign this report now?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._broker_report_reassign_eligible(p_def uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  d public.broker_report_definitions%ROWTYPE;
  v_role text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO d FROM public.broker_report_definitions WHERE id = p_def;
  IF d.id IS NULL
     OR NOT coalesce(public._org_feature_allowed(d.organization_id, 'broker_reports'), false)
     OR (d.owner_user_id IS NOT NULL
         AND public._broker_report_member_role(d.organization_id, d.owner_user_id) IS NOT NULL) THEN
    RETURN false;
  END IF;
  v_role := coalesce(public._broker_report_member_role(d.organization_id, v_uid), '');
  RETURN v_role = 'it_admin'
      OR (v_role = 'admin' AND NOT EXISTS (
            SELECT 1 FROM public.organization_members m
             WHERE m.organization_id = d.organization_id
               AND m.role = 'it_admin'
               AND m.license_status = 'active'
               AND m.user_id IS NOT NULL));
END
$function$;

-- ---------------------------------------------------------------------------
-- Reassign: an eligible caller picks the new owner.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_reassign(p_def uuid, p_new_owner uuid)
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
  IF d.id IS NULL
     OR NOT coalesce(public._broker_report_reassign_eligible(p_def), false)
     OR p_new_owner IS NULL
     OR p_new_owner IS NOT DISTINCT FROM d.owner_user_id
     OR public._broker_report_member_role(d.organization_id, p_new_owner) IS NULL THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  UPDATE public.broker_report_definitions SET owner_user_id = p_new_owner WHERE id = p_def;
  DELETE FROM public.broker_report_definition_grants
   WHERE definition_id = p_def AND principal_type = 'user' AND principal_user_id = p_new_owner;
  SELECT m.id INTO v_member FROM public.organization_members m
   WHERE m.organization_id = d.organization_id AND m.user_id = p_new_owner LIMIT 1;
  PERFORM public._broker_report_audit(d.organization_id, p_def, d.name, 'report_owner_changed',
    jsonb_build_object('member_id', v_member, 'via', 'reassign',
                       'from', public._broker_report_person_name(d.owner_user_id),
                       'to', public._broker_report_person_name(p_new_owner)));
  RETURN jsonb_build_object('success', true);
END
$function$;

-- ---------------------------------------------------------------------------
-- Who the new owner can be: active members of the report's organization (eligible caller only).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broker_report_reassign_candidates(p_def uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_org uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT coalesce(public._broker_report_reassign_eligible(p_def), false) THEN
    RAISE EXCEPTION 'Report not found';
  END IF;
  SELECT organization_id INTO v_org FROM public.broker_report_definitions WHERE id = p_def;
  RETURN (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'kind', 'person', 'id', m.user_id,
             'name', coalesce(public._broker_report_person_name(m.user_id), 'Member'),
             'detail', CASE m.role WHEN 'agent' THEN 'Agent' WHEN 'broker' THEN 'Broker'
                                   WHEN 'admin' THEN 'Admin' WHEN 'it_admin' THEN 'IT Admin' END)
             ORDER BY public._broker_report_person_name(m.user_id), m.user_id), '[]'::jsonb)
      FROM public.organization_members m
      JOIN public.organizations o ON o.id = m.organization_id
     WHERE m.organization_id = v_org
       AND m.license_status = 'active'
       AND m.user_id IS NOT NULL
       AND o.personal_owner_user_id IS NULL);
END
$function$;

-- ---------------------------------------------------------------------------
-- F8 (replaced): one definition, for anyone with a level on it, plus reassign_available.
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
    -- the test broker_report_reassign applies, for this caller
    'reassign_available', coalesce(public._broker_report_reassign_eligible(p_def), false));
END
$function$;

DROP FUNCTION IF EXISTS public.broker_report_take_over(uuid);

REVOKE ALL ON FUNCTION public._broker_report_reassign_eligible(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.broker_report_reassign(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.broker_report_reassign_candidates(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.broker_report_def_get(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broker_report_reassign(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broker_report_reassign_candidates(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.broker_report_def_get(uuid) TO authenticated;

COMMENT ON FUNCTION public.broker_report_reassign(uuid, uuid) IS
  'BACKLOG-3513: an active IT admin (or an active admin when the brokerage has no active IT admin) gives a report whose owner is gone or deactivated to an active member.';
