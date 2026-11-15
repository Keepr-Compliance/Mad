-- BACKLOG-3513 PR-2 rollback (20261112200000_backlog_3513_broker_report_definitions.sql).
-- Drops every function and both tables the migration created, and restores
-- public.admin_get_org_activity to its 20261107160000 body (md5 93ee729f73f23ecd90ffe49ca6d60704).
-- Rows the migration's functions wrote to public.billing_change_log (action report_*) STAY: the
-- table is the organization activity log and this file does not delete from it. The reader shows
-- them again without report_name once its body is restored.
-- broker_report_saved_views rows on 'd-<id>' keys stay too (the 3514 table is not this file's).
-- Run as a migration-capable role, in one transaction.

DROP FUNCTION IF EXISTS public.broker_report_take_over(uuid);
DROP FUNCTION IF EXISTS public.broker_report_transfer(uuid, uuid);
DROP FUNCTION IF EXISTS public.broker_report_set_general_access(uuid, text);
DROP FUNCTION IF EXISTS public.broker_report_share_remove(uuid, text, text);
DROP FUNCTION IF EXISTS public.broker_report_share_set(uuid, jsonb, text);
DROP FUNCTION IF EXISTS public.broker_report_share_candidates(uuid);
DROP FUNCTION IF EXISTS public.broker_report_share_list(uuid);
DROP FUNCTION IF EXISTS public.broker_report_def_delete(uuid);
DROP FUNCTION IF EXISTS public.broker_report_def_update(uuid, text, text, jsonb, text, timestamptz);
DROP FUNCTION IF EXISTS public.broker_report_def_create(uuid, text, text, text, jsonb, text);
DROP FUNCTION IF EXISTS public.broker_report_def_get(uuid);
DROP FUNCTION IF EXISTS public.broker_report_def_list(uuid);
DROP FUNCTION IF EXISTS public.broker_report_submissions_rows(uuid, uuid, text, uuid, timestamptz, timestamptz, text, integer, integer);
DROP FUNCTION IF EXISTS public.broker_report_scope(uuid, uuid);
DROP FUNCTION IF EXISTS public._broker_report_person_name(uuid);
DROP FUNCTION IF EXISTS public._broker_report_audit(uuid, uuid, text, text, jsonb);
DROP FUNCTION IF EXISTS public._broker_report_level(uuid);
DROP FUNCTION IF EXISTS public._broker_report_member_role(uuid, uuid);
DROP TABLE IF EXISTS public.broker_report_definition_grants;
DROP TABLE IF EXISTS public.broker_report_definitions;
DROP FUNCTION IF EXISTS public._broker_report_definitions_immutable();

CREATE OR REPLACE FUNCTION public.admin_get_org_activity(p_org uuid, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_billing boolean;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_out jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_permission(v_uid, 'organizations.view') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  v_billing := public.has_permission(v_uid, 'billing.view');

  WITH org_rows AS (
    SELECT c.created_at, c.action, c.actor_id, c.detail
      FROM public.billing_change_log c
     WHERE c.organization_id = p_org
       AND (v_billing OR c.action NOT IN ('deal_saved', 'seats_changed', 'suspended', 'reinstated',
                                          'auto_renew_on', 'auto_renew_off', 'deal_ended', 'setup_completed'))
       -- a trigger row is hidden when an explicit row of the same transaction names the member
       AND NOT (c.source IS NOT DISTINCT FROM 'trigger' AND EXISTS (
             SELECT 1 FROM public.billing_change_log e
              WHERE e.organization_id = c.organization_id
                AND e.txid = c.txid
                AND e.source IS DISTINCT FROM 'trigger'
                AND c.detail ->> 'member_id' IN (e.detail ->> 'member_id', e.detail ->> 'old_member_id')))
  ),
  staff_rows AS (
    SELECT a.created_at, a.action, a.actor_id,
           jsonb_strip_nulls(jsonb_build_object('plan', pl.name)) AS detail
      FROM public.admin_audit_logs a
      LEFT JOIN public.plans pl ON a.action = 'org_plan.assigned' AND pl.id::text = a.metadata ->> 'plan_id'
     WHERE a.target_type = 'organization'
       AND coalesce(a.metadata ->> 'organization_id', a.target_id) = p_org::text
       AND a.action IN ('organization.created', 'org_plan.assigned')
  ),
  merged AS (
    SELECT * FROM org_rows
    UNION ALL
    SELECT * FROM staff_rows
    ORDER BY 1 DESC
    LIMIT v_limit
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'created_at', x.created_at,
           'action', x.action,
           'actor_name', coalesce(nullif(btrim(au.display_name), ''), au.email,
                                  CASE WHEN x.actor_id IS NOT NULL THEN NULL
                                       WHEN x.detail ->> 'via' = 'directory' THEN 'Directory sync'
                                       ELSE 'Keepr' END),
           'actor_is_staff', x.actor_id IS NOT NULL
                             AND EXISTS (SELECT 1 FROM public.internal_roles ir WHERE ir.user_id = x.actor_id),
           'actor_is_subject', coalesce(x.actor_id = sm.user_id, false),
           'subject_name', coalesce(public._member_person(sm.id) ->> 'name', x.detail ->> 'name', x.detail ->> 'email'),
           'detail', (SELECT coalesce(jsonb_object_agg(k.key, k.value), '{}'::jsonb)
                        FROM jsonb_each(x.detail) k
                       WHERE k.key IN ('from', 'to', 'role', 'via', 'cleared', 'seats', 'reason', 'note', 'ends_on', 'plan', 'notified')))
           ORDER BY x.created_at DESC), '[]'::jsonb)
    INTO v_out
    FROM merged x
    LEFT JOIN public.users au ON au.id = x.actor_id
    LEFT JOIN public.organization_members sm
      ON sm.organization_id = p_org
     AND sm.id::text = x.detail ->> 'member_id';
  RETURN v_out;
END
$function$;

REVOKE ALL ON FUNCTION public.admin_get_org_activity(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_org_activity(uuid, integer) TO authenticated, service_role;
