-- Rollback for BACKLOG-4200 (20261108170000). Restores _billing_set_auto_renew to the
-- 20261107160000 body (md5 dbc2dffd26f24da2e773ff88ec96fa33) with its grants, removes the ledger
-- row, then re-reads md5 AND proacl and raises on any mismatch. Run on its own; no transaction
-- control statements in this file. Rows already queued as notify_auto_renew_off stay in
-- billing_outbox (the handler sends nothing once the deal is no longer canceling).

DO $guard$
DECLARE v text;
BEGIN
  SELECT md5(prosrc) INTO v FROM pg_proc WHERE oid = to_regprocedure('public._billing_set_auto_renew(uuid,boolean,text,uuid,text,integer,boolean)');
  IF v IS NULL OR v NOT IN ('7cfb206c94f5edcb2314ee82fe58f556', 'dbc2dffd26f24da2e773ff88ec96fa33') THEN
    RAISE EXCEPTION 'rollback-4200: _billing_set_auto_renew is at an unknown body (md5 %)', v;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public._billing_set_auto_renew(
  p_org uuid, p_on boolean, p_note text, p_actor uuid, p_caller text, p_expected_version integer, p_notify boolean)
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
  v_notify boolean;
  v_who text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF p_notify IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_request');
  END IF;
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

  -- BACKLOG-4045: staff turned it back on, the deal is active again (not suspended), staff left
  -- "Email the billing contact" ticked, and there is a billing contact email -> the contact is told.
  -- A no-op (changed=false) returned earlier and never reaches this.
  v_notify := p_on AND p_caller = 'staff' AND v_new_status = 'active' AND p_notify AND nullif(btrim(coalesce(v_deal.billing_contact_email, '')), '') IS NOT NULL;

  INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail)
  VALUES (p_org, p_actor, CASE WHEN p_on THEN 'auto_renew_on' ELSE 'auto_renew_off' END,
          jsonb_build_object('note', v_note, 'ends_on', CASE WHEN p_on THEN NULL ELSE v_ends END,
                             'version', v_version, 'by', p_caller)
          || CASE WHEN p_on AND p_caller = 'staff' THEN jsonb_build_object('notified', v_notify) ELSE '{}'::jsonb END);

  IF v_notify THEN
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
                            'ends_on', CASE WHEN p_on THEN NULL ELSE v_ends END)
         || CASE WHEN p_on AND p_caller = 'staff' THEN jsonb_build_object('notified', v_notify) ELSE '{}'::jsonb END;
END
$function$;

REVOKE ALL ON FUNCTION public._billing_set_auto_renew(uuid, boolean, text, uuid, text, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._billing_set_auto_renew(uuid, boolean, text, uuid, text, integer, boolean) TO service_role;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261108170000';

DO $check$
DECLARE v text; a text;
BEGIN
  SELECT md5(prosrc), proacl::text INTO v, a FROM pg_proc WHERE oid = to_regprocedure('public._billing_set_auto_renew(uuid,boolean,text,uuid,text,integer,boolean)');
  IF v IS DISTINCT FROM 'dbc2dffd26f24da2e773ff88ec96fa33' OR a IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'rollback-4200: after restore md5 % acl %', v, a;
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261108170000') THEN
    RAISE EXCEPTION 'rollback-4200: ledger row still present';
  END IF;
END
$check$;
