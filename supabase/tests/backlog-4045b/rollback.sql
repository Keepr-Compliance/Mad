-- BACKLOG-4045b rollback (keepr-test). Restores the 20261107140000 state:
-- _billing_set_auto_renew 6-arg (md5 698cec91f74a59f49101fac6afe197dc), set_org_auto_renew 4-arg
-- (fc2ce2ede40ab941a318cce4dd6b1e7d), admin_get_org_activity (42ffad03969ab407d626948b9fcee650),
-- removes the 20261107160000 ledger row, then re-checks every md5 and ACL. Run this BEFORE
-- supabase/tests/backlog-4045/rollback.sql. detail.notified keys already written stay (harmless).
BEGIN;
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public._billing_set_auto_renew(uuid,boolean,text,uuid,text,integer,boolean)')) IS DISTINCT FROM 'dbc2dffd26f24da2e773ff88ec96fa33'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.set_org_auto_renew(uuid,boolean,text,integer,boolean)')) IS DISTINCT FROM '0635beb03ede25d58f83acf5be174214'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.admin_get_org_activity(uuid,integer)')) IS DISTINCT FROM '93ee729f73f23ecd90ffe49ca6d60704' THEN
    RAISE EXCEPTION 'BACKLOG-4045b rollback: live functions are not the 4045b bodies';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public._billing_set_auto_renew(
  p_org uuid, p_on boolean, p_note text, p_actor uuid, p_caller text, p_expected_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_deal public.org_deals%ROWTYPE;
  v_eff text;
  v_sub_id text;
  v_sub_status text;
  v_ends timestamptz;
  v_version integer;
  v_new_status text;
  v_who text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF p_on IS NULL OR p_caller IS NULL OR p_caller NOT IN ('staff', 'admin', 'billing_contact') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_request');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('billing_org:' || p_org::text, 0));
  SELECT * INTO v_deal FROM public.org_deals WHERE organization_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_deal');
  END IF;
  IF p_expected_version IS DISTINCT FROM v_deal.version THEN
    RETURN jsonb_build_object('success', false, 'error', 'version_conflict', 'version', v_deal.version);
  END IF;
  IF v_deal.stripe_mode = 'live' AND NOT public._billing_brokerage_live() THEN
    RETURN jsonb_build_object('success', false, 'error', 'billing_not_live');
  END IF;
  -- SR change 3: a suspended brokerage changes nothing itself; staff may.
  IF v_deal.status = 'suspended' AND p_caller <> 'staff' THEN
    RETURN jsonb_build_object('success', false, 'error', 'deal_suspended');
  END IF;
  IF v_deal.status = 'draft' THEN
    RETURN jsonb_build_object('success', false, 'error', 'deal_not_started');
  END IF;
  IF v_deal.status = 'canceled' THEN
    RETURN jsonb_build_object('success', false, 'error', 'deal_canceled');
  END IF;

  v_eff := CASE WHEN v_deal.status = 'suspended' THEN v_deal.status_before_suspension ELSE v_deal.status END;
  SELECT s.stripe_subscription_id, s.status, s.current_period_end INTO v_sub_id, v_sub_status, v_ends
    FROM public.org_billing_stripe s
   WHERE s.organization_id = p_org AND s.stripe_mode = v_deal.stripe_mode;

  IF NOT p_on THEN
    IF v_eff = 'canceling' THEN
      RETURN jsonb_build_object('success', true, 'changed', false, 'version', v_deal.version, 'ends_on', v_ends);
    END IF;
    IF v_sub_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'no_subscription');
    END IF;
    IF v_sub_status = 'canceled' THEN
      RETURN jsonb_build_object('success', false, 'error', 'already_ended');
    END IF;
  ELSE
    IF v_eff = 'active' THEN
      RETURN jsonb_build_object('success', true, 'changed', false, 'version', v_deal.version, 'ends_on', NULL);
    END IF;
    -- Stripe cannot resume a canceled subscription (S5): restart is Edit deal.
    IF v_sub_status = 'canceled' THEN
      RETURN jsonb_build_object('success', false, 'error', 'already_ended');
    END IF;
  END IF;

  -- One UPDATE: the state and the version, so the trigger queues exactly one sync row.
  UPDATE public.org_deals SET
    status = CASE WHEN status = 'suspended' THEN status
                  WHEN p_on THEN 'active' ELSE 'canceling' END,
    status_before_suspension = CASE WHEN status = 'suspended'
                                    THEN CASE WHEN p_on THEN 'active' ELSE 'canceling' END
                                    ELSE status_before_suspension END,
    version = version + 1,
    updated_at = now(),
    updated_by = p_actor
  WHERE organization_id = p_org
  RETURNING version, status INTO v_version, v_new_status;

  INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
  VALUES (p_org, p_actor, CASE WHEN p_on THEN 'auto_renew_on' ELSE 'auto_renew_off' END,
          jsonb_build_object('note', v_note, 'ends_on', CASE WHEN p_on THEN NULL ELSE v_ends END,
                             'version', v_version, 'by', p_caller));

  -- BACKLOG-4045: staff turned it back on and the deal is active again (not suspended) -> the
  -- billing contact is told. A no-op (changed=false) returned earlier and never reaches this.
  IF p_on AND p_caller = 'staff' AND v_new_status = 'active' THEN
    INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
    VALUES (v_deal.stripe_mode, 'notify_auto_renew_on', p_org,
            'notify_auto_renew_on:' || v_deal.stripe_mode || ':' || p_org::text || ':v' || v_version::text,
            jsonb_build_object('organization_id', p_org, 'version', v_version))
    ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;

  -- SR change 4: a brokerage turning it off itself alerts its Keepr account manager.
  IF NOT p_on AND p_caller <> 'staff' THEN
    SELECT coalesce(nullif(btrim(u.display_name), ''),
                    nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email, 'A brokerage user')
      INTO v_who FROM public.users u WHERE u.id = p_actor;
    INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
    VALUES (v_deal.stripe_mode, 'notify_account_manager', p_org,
            'notify_account_manager:' || v_deal.stripe_mode || ':' || p_org::text || ':auto_renew_off:v' || v_version::text,
            jsonb_build_object('reason', 'auto_renew_off', 'organization_id', p_org,
              'detail', 'Turned off by ' || coalesce(v_who, 'a brokerage user')
                        || CASE WHEN p_caller = 'admin' THEN ' (Admin)' ELSE ' (billing contact)' END
                        || '. The plan ends on '
                        || coalesce(to_char(v_ends AT TIME ZONE 'America/Los_Angeles', 'FMMon FMDD, YYYY'), 'the end of the billing period')
                        || '.'))
    ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('success', true, 'changed', true, 'version', v_version,
                            'ends_on', CASE WHEN p_on THEN NULL ELSE v_ends END);
END
$function$;

REVOKE ALL ON FUNCTION public._billing_set_auto_renew(uuid, boolean, text, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_set_auto_renew(uuid, boolean, text, uuid, text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.set_org_auto_renew(p_org uuid, p_on boolean, p_note text, p_expected_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_caller text;
  v_res jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  v_caller := public._org_auto_renew_caller(p_org);
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_caller = 'staff' AND nullif(btrim(coalesce(p_note, '')), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'note_required');
  END IF;
  v_res := public._billing_set_auto_renew(p_org, p_on, p_note, v_uid, v_caller, p_expected_version);
  IF v_caller = 'staff' AND coalesce((v_res ->> 'changed')::boolean, false) THEN
    INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, metadata)
    VALUES (v_uid, CASE WHEN p_on THEN 'billing.auto_renew_on' ELSE 'billing.auto_renew_off' END,
            'organization', p_org::text,
            jsonb_build_object('version', v_res -> 'version', 'note', btrim(p_note), 'ends_on', v_res -> 'ends_on'));
  END IF;
  RETURN v_res;
END
$function$;

REVOKE ALL ON FUNCTION public.set_org_auto_renew(uuid, boolean, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_org_auto_renew(uuid, boolean, text, integer) TO authenticated, service_role;

DROP FUNCTION public.set_org_auto_renew(uuid, boolean, text, integer, boolean);
DROP FUNCTION public._billing_set_auto_renew(uuid, boolean, text, uuid, text, integer, boolean);

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
                       WHERE k.key IN ('from', 'to', 'role', 'via', 'cleared', 'seats', 'reason', 'note', 'ends_on', 'plan')))
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

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261107160000';

DO $check$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public._billing_set_auto_renew(uuid,boolean,text,uuid,text,integer)', '698cec91f74a59f49101fac6afe197dc', '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.set_org_auto_renew(uuid,boolean,text,integer)', 'fc2ce2ede40ab941a318cce4dd6b1e7d', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
      ('public.admin_get_org_activity(uuid,integer)', '42ffad03969ab407d626948b9fcee650', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}')) v(sig, md5, acl)
  LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(r.sig)) IS DISTINCT FROM r.md5
       OR (SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure(r.sig)) IS DISTINCT FROM r.acl THEN
      RAISE EXCEPTION 'BACKLOG-4045b rollback: % not restored', r.sig;
    END IF;
  END LOOP;
  IF to_regprocedure('public.set_org_auto_renew(uuid,boolean,text,integer,boolean)') IS NOT NULL
     OR to_regprocedure('public._billing_set_auto_renew(uuid,boolean,text,uuid,text,integer,boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'BACKLOG-4045b rollback: new signatures still present';
  END IF;
END
$check$;
COMMIT;
