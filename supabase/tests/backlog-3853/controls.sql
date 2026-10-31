-- BACKLOG-3853 PR-1 DB controls. Venue: keepr-test, ONE call,
-- ONE transaction that ends in RAISE, so nothing persists.
-- Run after M1 (20261018230000) is applied, or compose M1 + this file into one call.
-- __MODES__ is replaced by the runner with a comma list of quoted mode names, e.g. 'base','no_unlock_gate'.
-- Each mode runs in its own subtransaction: apply the mutation (exact-once replace, raises on 0
-- or 2+ matches, md5 must change), build the fixtures, run every check, then roll back.
-- Output: RAISE 'P3853_RESULT {mode: {mutation, pass, fail, reds}}'. base also lists every check.
-- Fixtures: new auth users p3853-*@example.test, new organizations P3853 *; nothing existing is read or written.

DO $drv$
DECLARE
  v_modes text[] := ARRAY[__MODES__]::text[];
  v_m text;
  v_mut text;
  v_res jsonb := '{}'::jsonb;
  v_r jsonb;
  v_detail text;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.as_user(u uuid, e text) RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated', 'email', e)::text, true);
    PERFORM set_config('request.jwt.claim.sub', u::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  END $b$$f$;

  -- exact-once replace inside a function definition, then re-create it
  EXECUTE $f$CREATE FUNCTION pg_temp.mut_fn(p_sig text, p_from text, p_to text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE d text; n int; d2 text; m1 text; m2 text;
  BEGIN
    d := pg_get_functiondef(to_regprocedure(p_sig));
    n := (length(d) - length(replace(d, p_from, ''))) / length(p_from);
    IF n <> 1 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: % matches in %', n, p_sig; END IF;
    m1 := md5(d);
    EXECUTE replace(d, p_from, p_to);
    d2 := pg_get_functiondef(to_regprocedure(p_sig)); m2 := md5(d2);
    IF m1 = m2 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: md5 unchanged for %', p_sig; END IF;
    RETURN 'MUTATION APPLIED ' || p_sig || ' ' || left(m1, 8) || '->' || left(m2, 8);
  END $b$$f$;

  -- exact-once replace inside a policy expression (pg_policies text), then ALTER POLICY
  EXECUTE $f$CREATE FUNCTION pg_temp.mut_pol(p_sch text, p_tbl text, p_pol text, p_part text, p_from text, p_to text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE q text; c text; t text; n int; m1 text; m2 text;
  BEGIN
    SELECT qual, with_check INTO q, c FROM pg_policies WHERE schemaname = p_sch AND tablename = p_tbl AND policyname = p_pol;
    t := CASE p_part WHEN 'qual' THEN q ELSE c END;
    n := (length(t) - length(replace(t, p_from, ''))) / length(p_from);
    IF n <> 1 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: % matches in % %', n, p_pol, p_part; END IF;
    m1 := md5(coalesce(q, '')) || '/' || md5(coalesce(c, ''));
    IF p_part = 'qual' THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)', p_pol, p_sch, p_tbl, replace(t, p_from, p_to));
    ELSE
      EXECUTE format('ALTER POLICY %I ON %I.%I WITH CHECK (%s)', p_pol, p_sch, p_tbl, replace(t, p_from, p_to));
    END IF;
    SELECT md5(coalesce(qual, '')) || '/' || md5(coalesce(with_check, '')) INTO m2
      FROM pg_policies WHERE schemaname = p_sch AND tablename = p_tbl AND policyname = p_pol;
    IF m1 = m2 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: md5 unchanged for %', p_pol; END IF;
    RETURN 'MUTATION APPLIED ' || p_pol || '.' || p_part || ' ' || left(split_part(m1, '/', CASE p_part WHEN 'qual' THEN 1 ELSE 2 END), 8)
           || '->' || left(split_part(m2, '/', CASE p_part WHEN 'qual' THEN 1 ELSE 2 END), 8);
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  BEGIN
    CASE m
    WHEN 'base' THEN RETURN 'none';
    -- G1
    WHEN 'no_unlock_gate' THEN RETURN pg_temp.mut_fn('public.unlock_transaction(text)',
      'IF public.org_billing_suspended(public.billing_deciding_org(v_uid)) THEN', 'IF false THEN');
    WHEN 'writer_split' THEN RETURN pg_temp.mut_fn('public._billing_save_deal(uuid,jsonb,uuid,text,integer)',
      'PERFORM public._billing_apply_org_entitlement(p_org);',
      $q$UPDATE public.organization_plans SET feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{"unlimited_transactions":{"enabled":true,"source":"brokerage_billing"}}'::jsonb WHERE organization_id = p_org;$q$);
    WHEN 'writer_skips_signal' THEN RETURN pg_temp.mut_fn('public._billing_apply_org_entitlement(uuid)',
      $q$'broker_portal_access', 'account_suspended']$q$, $q$'broker_portal_access']$q$);
    WHEN 'purchase_any_org' THEN RETURN pg_temp.mut_fn('public.billing_purchase_blocked(uuid)',
      'SELECT coalesce(public.org_billing_suspended(public.billing_deciding_org(p_user)), false);',
      'SELECT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = p_user AND public.org_billing_suspended(m.organization_id));');
    -- G2
    WHEN 'no_finalize_gate' THEN RETURN pg_temp.mut_fn('public.finalize_submission(uuid,jsonb)',
      'IF public.org_billing_suspended(v_sub.organization_id) THEN', 'IF false THEN');
    WHEN 'no_insert_clause' THEN RETURN pg_temp.mut_pol('public', 'transaction_submissions', 'agents_can_create_submissions', 'check',
      __INSERT_FROM__, '');
    WHEN 'sr_mutant_b_submitter_check' THEN RETURN pg_temp.mut_pol('public', 'transaction_submissions', 'transaction_submissions_update_public', 'check',
      __SUBMITTER_FROM__, '');
    WHEN 'no_storage_clause' THEN RETURN pg_temp.mut_pol('storage', 'objects', 'Members can upload submission attachments', 'check',
      __STORAGE_FROM__, '');
    -- G3 / G4
    WHEN 'no_crs_gate' THEN RETURN pg_temp.mut_fn('public.can_review_submission(uuid)',
      'AND NOT public.org_billing_suspended(p_org_id)', '');
    WHEN 'sr_crs_caller_org' THEN RETURN pg_temp.mut_fn('public.can_review_submission(uuid)',
      'AND NOT public.org_billing_suspended(p_org_id)',
      'AND NOT public.org_billing_suspended(public.billing_deciding_org((SELECT auth.uid())))');
    WHEN 'sr_reviewer_check_only' THEN RETURN pg_temp.mut_pol('public', 'transaction_submissions', 'transaction_submissions_update_public', 'check',
      __REVIEWER_CHECK_FROM__, '');
    WHEN 'no_reviewer_clause' THEN RETURN pg_temp.mut_pol('public', 'transaction_submissions', 'transaction_submissions_update_public', 'qual',
      __REVIEWER_USING_FROM__, '') || ' + ' || pg_temp.mut_pol('public', 'transaction_submissions', 'transaction_submissions_update_public', 'check',
      __REVIEWER_CHECK_FROM__, '');
    WHEN 'v2_self_carveout' THEN RETURN pg_temp.mut_pol('public', 'transaction_submissions', 'transaction_submissions_update_public', 'qual',
      __REVIEWER_USING_FROM__, __REVIEWER_CARVEOUT__) || ' + ' || pg_temp.mut_pol('public', 'transaction_submissions', 'transaction_submissions_update_public', 'check',
      __REVIEWER_CHECK_FROM__, __REVIEWER_CARVEOUT__);
    WHEN 'no_comment_clause' THEN RETURN pg_temp.mut_pol('public', 'submission_comments', 'users_can_create_comments', 'check',
      __COMMENT_FROM__, '');
    -- G5
    WHEN 'sr_mutant_a_no_insert_branch' THEN RETURN pg_temp.mut_fn('public._billing_guard_member_while_suspended()',
      $q$IF TG_OP = 'INSERT'
     OR (TG_OP = 'UPDATE' AND NEW.organization_id$q$, $q$IF (TG_OP = 'UPDATE' AND NEW.organization_id$q$);
    WHEN 'trigger_no_claim_branch' THEN RETURN pg_temp.mut_fn('public._billing_guard_member_while_suspended()',
      '     OR (OLD.user_id IS NULL AND NEW.user_id IS NOT NULL)
', '');
    WHEN 'trigger_no_resend_branch' THEN RETURN pg_temp.mut_fn('public._billing_guard_member_while_suspended()',
      $q$     OR (OLD.user_id IS NULL AND NEW.license_status IN ('pending', 'unassigned')
         AND (NEW.invitation_token IS DISTINCT FROM OLD.invitation_token
              OR NEW.invitation_expires_at IS DISTINCT FROM OLD.invitation_expires_at))$q$, '');
    WHEN 'trigger_no_claim_and_resend' THEN RETURN pg_temp.mut_fn('public._billing_guard_member_while_suspended()',
      $q$     OR (OLD.user_id IS NULL AND NEW.user_id IS NOT NULL)
     OR (OLD.user_id IS NULL AND NEW.license_status IN ('pending', 'unassigned')
         AND (NEW.invitation_token IS DISTINCT FROM OLD.invitation_token
              OR NEW.invitation_expires_at IS DISTINCT FROM OLD.invitation_expires_at))$q$, '');
    WHEN 'trigger_inert' THEN RETURN pg_temp.mut_fn('public._billing_guard_member_while_suspended()',
      $q$IF NOT EXISTS (SELECT 1 FROM public.org_deals d$q$, $q$IF true OR NOT EXISTS (SELECT 1 FROM public.org_deals d$q$);
    WHEN 'seats_no_gate' THEN RETURN pg_temp.mut_fn('public._billing_change_seats(uuid,integer,uuid)',
      $q$IF v_deal.status = 'suspended' THEN$q$, 'IF false THEN');
    -- engine rules
    WHEN 'paid_lifts_any' THEN RETURN pg_temp.mut_fn('public._billing_auto_reinstate(uuid,text)',
      $q$IF v_reason IS DISTINCT FROM 'non_payment' THEN$q$, 'IF false THEN');
    WHEN 'paid_ignores_stripe' THEN RETURN pg_temp.mut_fn('public._billing_auto_reinstate(uuid,text)',
      $q$IF v_status IS DISTINCT FROM 'active' THEN$q$, 'IF false THEN');
    WHEN 'reinstate_drops_prior' THEN RETURN pg_temp.mut_fn('public._billing_apply_org_entitlement(uuid)',
      'ELSIF v_prior ? v_key THEN', 'ELSIF false THEN');
    WHEN 'r4_no_status_check' THEN RETURN pg_temp.mut_fn('public._billing_suspend_org(uuid,text,text,uuid)',
      $q$IF v_deal.status NOT IN ('active', 'canceling') THEN$q$, 'IF false THEN');
    WHEN 'r14_guard_on_suspend_only' THEN RETURN pg_temp.mut_fn('public._billing_save_deal(uuid,jsonb,uuid,text,integer)',
      $q$IF v_mode = 'live' AND NOT public._billing_brokerage_live() THEN$q$, 'IF false THEN');
    WHEN 'r14_suspend_unguarded' THEN RETURN pg_temp.mut_fn('public._billing_suspend_org(uuid,text,text,uuid)',
      $q$IF v_deal.stripe_mode = 'live' AND NOT public._billing_brokerage_live() THEN$q$, 'IF false THEN');
    WHEN 'sr_reinstate_no_perm' THEN RETURN pg_temp.mut_fn('public.admin_reinstate_org(uuid,text)',
      $q$IF NOT public.has_permission(v_uid, 'billing.suspend') THEN$q$, 'IF false THEN');
    WHEN 'sr_no_move_branch' THEN RETURN pg_temp.mut_fn('public._billing_guard_member_while_suspended()',
      $q$
     OR (TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id)$q$, '');
    WHEN 'admin_rpc_no_permission' THEN RETURN pg_temp.mut_fn('public.admin_suspend_org(uuid,text,text)',
      $q$IF NOT public.has_permission(v_uid, 'billing.suspend') THEN$q$, 'IF false THEN');
    ELSE RAISE EXCEPTION 'unknown mode %', m;
    END CASE;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    o_b uuid := gen_random_uuid();   -- is_test brokerage, Team plan, the suspended one
    o_l uuid := gen_random_uuid();   -- NOT is_test brokerage (live deal refusals)
    o_l2 uuid := gen_random_uuid();  -- NOT is_test, live deal inserted directly
    o_c uuid := gen_random_uuid();   -- is_test, canceled deal
    o_n uuid := gen_random_uuid();   -- is_test, no deal
    u_staff uuid := gen_random_uuid(); u_adm uuid := gen_random_uuid(); u_brk uuid := gen_random_uuid();
    u_agt uuid := gen_random_uuid(); u_ag3 uuid := gen_random_uuid();
    u_inp uuid := gen_random_uuid(); u_inu uuid := gen_random_uuid();
    v_team uuid; v_ind uuid; m_agt uuid; m_ag3 uuid; m_inp uuid;
    s_sub uuid; s_up uuid; s_adm uuid; v_item uuid; v_cl uuid;
    o_2 uuid := gen_random_uuid();   -- is_test, NOT suspended, no deal: the reviewer's earlier second org (R-1)
    s_adm_up uuid; s_adm_up0 uuid; m_mv uuid; m_mv0 uuid;
    v jsonb; s text; n int; n2 int; f jsonb; v_before text; v_after text;
  BEGIN
    SELECT id INTO v_team FROM public.plans WHERE name = 'Team';
    SELECT id INTO v_ind FROM public.plans WHERE name = 'Individual';

    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT x.id, x.e, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
    FROM (VALUES (u_staff, 'p3853-staff@example.test'), (u_adm, 'p3853-adm@example.test'), (u_brk, 'p3853-brk@example.test'),
                 (u_agt, 'p3853-agt@example.test'), (u_ag3, 'p3853-ag3@example.test'),
                 (u_inp, 'p3853-inp@example.test'), (u_inu, 'p3853-inu@example.test')) x(id, e);
    INSERT INTO public.users (id, email, oauth_provider, oauth_id)
    SELECT x.id, x.e, 'email', x.id::text
    FROM (VALUES (u_staff, 'p3853-staff@example.test'), (u_adm, 'p3853-adm@example.test'), (u_brk, 'p3853-brk@example.test'),
                 (u_agt, 'p3853-agt@example.test'), (u_ag3, 'p3853-ag3@example.test')) x(id, e)
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.internal_roles (user_id, role_id) SELECT u_staff, id FROM public.admin_roles WHERE slug = 'sales';

    INSERT INTO public.organizations (id, name, slug, max_seats, is_test) VALUES
      (o_b, 'P3853 B', 'p3853-b-' || left(o_b::text, 8), 10, true),
      (o_l, 'P3853 L', 'p3853-l-' || left(o_l::text, 8), 10, false),
      (o_l2, 'P3853 L2', 'p3853-l2-' || left(o_l2::text, 8), 10, false),
      (o_c, 'P3853 C', 'p3853-c-' || left(o_c::text, 8), 10, true),
      (o_n, 'P3853 N', 'p3853-n-' || left(o_n::text, 8), 10, true),
      (o_2, 'P3853 SECOND', 'p3853-2-' || left(o_2::text, 8), 10, true);
    INSERT INTO public.organization_plans (organization_id, plan_id)
    SELECT x, v_team FROM unnest(ARRAY[o_b, o_l, o_l2, o_c, o_n, o_2]) x;
    -- a support grant present before billing takes the key (C-7 prior restore)
    UPDATE public.organization_plans SET feature_overrides = '{"broker_submission":{"enabled":true,"source":"support"},"transaction_checklists":{"enabled":true,"source":"support"}}'::jsonb
     WHERE organization_id = o_b;

    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by) VALUES
      (o_b, u_adm, 'admin', 'active', now(), 'manual'),
      (o_b, u_brk, 'broker', 'active', now(), 'manual');
    -- Reviewer fixture (SR required change 1): the broker also holds an ACTIVE membership in a second,
    -- NOT suspended org whose membership row is older, so billing_deciding_org(broker) = o_2, not o_b.
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by, created_at)
      VALUES (o_2, u_brk, 'broker', 'active', now(), 'manual', now() - interval '2 days');
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by)
      VALUES (o_b, u_agt, 'agent', 'active', now(), 'manual') RETURNING id INTO m_agt;
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by)
      VALUES (o_b, u_ag3, 'agent', 'active', now(), 'manual') RETURNING id INTO m_ag3;
    INSERT INTO public.organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by)
      VALUES (o_b, 'p3853-inp@example.test', 'agent', 'pending', 'p3853-tok-p', now() + interval '7 days', u_adm, now(), 'invite') RETURNING id INTO m_inp;
    INSERT INTO public.organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by)
      VALUES (o_b, 'p3853-inu@example.test', 'agent', 'unassigned', 'p3853-tok-u', now() + interval '7 days', u_adm, now(), 'invite');

    -- C-11 fixture from the real producer: deactivating ag3 moves them to a personal org (3851 M2 trigger,
    -- _ensure_personal_organization_for, which needs a desktop licence row first).
    INSERT INTO public.licenses (user_id, license_key) VALUES (u_ag3, 'p3853-lic-' || u_ag3::text);
    UPDATE public.organization_members SET license_status = 'suspended' WHERE id = m_ag3;

    INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, status)
      VALUES (o_b, u_agt, 'p3853-sub', 'p3853 address 1', 'submitted') RETURNING id INTO s_sub;
    INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, status)
      VALUES (o_b, u_agt, 'p3853-up', 'p3853 address 2', 'uploading') RETURNING id INTO s_up;
    INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, status)
      VALUES (o_b, u_adm, 'p3853-adm', 'p3853 address 3', 'submitted') RETURNING id INTO s_adm;
    INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, status)
      VALUES (o_b, u_adm, 'p3853-admup', 'p3853 address 6', 'uploading') RETURNING id INTO s_adm_up;
    INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, status)
      VALUES (o_b, u_adm, 'p3853-admup0', 'p3853 address 7', 'uploading') RETURNING id INTO s_adm_up0;
    -- member rows with no user, in a non-suspended org, to be moved (SR required change 4)
    INSERT INTO public.organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by)
      VALUES (o_n, 'p3853-mv@example.test', 'agent', 'pending', 'p3853-tok-mv', now() + interval '7 days', u_adm, now(), 'invite') RETURNING id INTO m_mv;
    INSERT INTO public.organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, invited_by, invited_at, provisioned_by)
      VALUES (o_n, 'p3853-mv0@example.test', 'agent', 'pending', 'p3853-tok-mv0', now() + interval '7 days', u_adm, now(), 'invite') RETURNING id INTO m_mv0;
    INSERT INTO public.submission_checklists (submission_id, template_name) VALUES (s_sub, 'p3853 list') RETURNING id INTO v_cl;
    INSERT INTO public.submission_checklist_items (submission_id, submission_checklist_id, title, is_required)
      VALUES (s_sub, v_cl, 'p3853 item', false) RETURNING id INTO v_item;
    INSERT INTO public.credit_ledger (user_id, entry_type, amount) VALUES (u_agt, 'adjustment', 1);

    -- ===== deal saved (producer, not hand-written) =====
    v := public._billing_save_deal(o_b, '{"stripe_mode":"test","seats":10}'::jsonb, u_staff, 'p3853', NULL);
    r := r || jsonb_build_object('P0_save', CASE WHEN v->>'success' = 'true' THEN 'PASS' ELSE 'FAIL ' || v::text END);

    -- ===== pre-suspension probes (prove each later refusal is not vacuous) =====
    PERFORM pg_temp.as_user(u_adm, 'p3853-adm@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    f := public.get_org_features(o_b) -> 'features';
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('P0_unlimited_on', CASE WHEN f->'unlimited_transactions'->>'enabled' = 'true' THEN 'PASS' ELSE 'FAIL ' || coalesce(f->>'unlimited_transactions', 'null') END);

    BEGIN
      PERFORM pg_temp.as_user(u_brk, 'p3853-brk@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT count(*) INTO n FROM public.transaction_submissions WHERE organization_id = o_b AND submitted_by = u_agt;
      WITH u AS (UPDATE public.transaction_submissions SET status = 'under_review' WHERE id = s_sub RETURNING 1) SELECT count(*) INTO n2 FROM u;
      EXECUTE 'RESET ROLE';
      r := r || jsonb_build_object('P0_reviewer_sees_and_acts', CASE WHEN n = 2 AND n2 = 1 THEN 'PASS' ELSE 'FAIL sees=' || n || ' acts=' || n2 END);
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; r := r || jsonb_build_object('P0_reviewer_sees_and_acts', 'FAIL ' || SQLSTATE || ' ' || left(SQLERRM, 80)); END;

    BEGIN
      PERFORM pg_temp.as_user(u_brk, 'p3853-brk@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM public.set_submission_checklist_reviewer_check(v_item, true);
      EXECUTE 'RESET ROLE';
      r := r || jsonb_build_object('P0_checklist_review_rpc', 'PASS');
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; r := r || jsonb_build_object('P0_checklist_review_rpc', 'FAIL ' || SQLSTATE || ' ' || left(SQLERRM, 60)); END;

    BEGIN
      PERFORM pg_temp.as_user(u_agt, 'p3853-agt@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      INSERT INTO public.submission_comments (submission_id, user_id, content) VALUES (s_sub, u_agt, 'p3853 pre');
      INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('submission-attachments', o_b::text || '/' || s_up::text || '/pre.txt', u_agt);
      INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, status)
        VALUES (o_b, u_agt, 'p3853-pre', 'p3853 address 4', 'uploading');
      EXECUTE 'RESET ROLE';
      r := r || jsonb_build_object('P0_agent_comment_upload_insert', 'PASS');
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; r := r || jsonb_build_object('P0_agent_comment_upload_insert', 'FAIL ' || SQLSTATE || ' ' || left(SQLERRM, 80)); END;

    -- non-vacuity for the two new refusals below: before suspension both actions succeed
    BEGIN
      PERFORM pg_temp.as_user(u_adm, 'p3853-adm@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      WITH u AS (UPDATE public.transaction_submissions SET status = 'approved' WHERE id = s_adm_up0 RETURNING 1) SELECT count(*) INTO n FROM u;
      EXECUTE 'RESET ROLE'; s := n::text;
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; s := SQLSTATE; END;
    r := r || jsonb_build_object('P0_admin_approves_own_uploading_row', CASE WHEN s = '1' THEN 'PASS' ELSE 'FAIL ' || s END);
    BEGIN
      UPDATE public.organization_members SET organization_id = o_c WHERE id = m_mv0; s := 'moved';
    EXCEPTION WHEN OTHERS THEN s := SQLERRM; END;
    r := r || jsonb_build_object('P0_member_row_move_possible', CASE WHEN s = 'moved' THEN 'PASS' ELSE 'FAIL ' || s END);

    SELECT string_agg(license_status || '/' || (user_id IS NULL)::text, ',' ORDER BY id) INTO v_before
      FROM public.organization_members WHERE organization_id = o_b;

    -- ===== suspend through the admin RPC as a Sales user =====
    PERFORM pg_temp.as_user(u_staff, 'p3853-staff@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    v := public.admin_suspend_org(o_b, 'non_payment', 'p3853');
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('P1_suspend', CASE WHEN v->>'success' = 'true' THEN 'PASS' ELSE 'FAIL ' || v::text END);

    SELECT string_agg(license_status || '/' || (user_id IS NULL)::text, ',' ORDER BY id) INTO v_after
      FROM public.organization_members WHERE organization_id = o_b;
    r := r || jsonb_build_object('Xs_suspension_writes_no_member_row', CASE WHEN v_before = v_after THEN 'PASS' ELSE 'FAIL ' || v_before || ' -> ' || v_after END);

    -- a deal re-save during the suspension must not turn exports back on (writer_split)
    SELECT version INTO n FROM public.org_deals WHERE organization_id = o_b;
    v := public._billing_save_deal(o_b, '{"stripe_mode":"test","seats":10}'::jsonb, u_staff, 'p3853 resave', n);

    -- ===== G1 =====
    PERFORM pg_temp.as_user(u_adm, 'p3853-adm@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    f := public.get_org_features(o_b) -> 'features';
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('A1_unlimited_off_after_resave', CASE WHEN v->>'success' = 'true' AND f->'unlimited_transactions'->>'enabled' = 'false' THEN 'PASS' ELSE 'FAIL save=' || v::text || ' u=' || coalesce(f->'unlimited_transactions'->>'enabled', 'null') END);
    r := r || jsonb_build_object('A2_submit_and_portal_flags_off', CASE WHEN f->'broker_submission'->>'enabled' = 'false' AND f->'broker_portal_access'->>'enabled' = 'false' THEN 'PASS' ELSE 'FAIL ' || coalesce(f->'broker_submission'->>'enabled', 'null') || '/' || coalesce(f->'broker_portal_access'->>'enabled', 'null') END);
    r := r || jsonb_build_object('CS2_account_suspended_signal_on', CASE WHEN f->'account_suspended'->>'enabled' = 'true' THEN 'PASS' ELSE 'FAIL ' || coalesce(f->>'account_suspended', 'null') END);

    SELECT count(*) INTO n FROM public.credit_ledger WHERE user_id = u_agt AND entry_type = 'debit';
    BEGIN
      PERFORM pg_temp.as_user(u_agt, 'p3853-agt@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      v := public.unlock_transaction('p3853-unlock');
      EXECUTE 'RESET ROLE';
      s := 'unlocked=' || coalesce(v->>'unlocked', 'null');
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; s := SQLERRM; END;
    SELECT count(*) INTO n2 FROM public.credit_ledger WHERE user_id = u_agt AND entry_type = 'debit';
    r := r || jsonb_build_object('A3_credit_unlock_refused', CASE WHEN s = 'account_suspended' AND n = n2 THEN 'PASS' ELSE 'FAIL ' || s || ' debits ' || n || '->' || n2 END);

    r := r || jsonb_build_object('C3db_purchase_blocked_member', CASE WHEN public.billing_purchase_blocked(u_agt) THEN 'PASS' ELSE 'FAIL false' END);
    r := r || jsonb_build_object('C11_deactivated_member_personal_rules', CASE
      WHEN NOT public.billing_purchase_blocked(u_ag3)
       AND (SELECT o.personal_owner_user_id FROM public.organizations o WHERE o.id = public.billing_deciding_org(u_ag3)) = u_ag3 THEN 'PASS'
      ELSE 'FAIL blocked=' || public.billing_purchase_blocked(u_ag3)::text || ' deciding=' || coalesce(public.billing_deciding_org(u_ag3)::text, 'null') END);

    -- ===== G2 =====
    BEGIN
      PERFORM pg_temp.as_user(u_agt, 'p3853-agt@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, status)
        VALUES (o_b, u_agt, 'p3853-new', 'p3853 address 5', 'uploading');
      EXECUTE 'RESET ROLE'; s := 'inserted';
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; s := SQLSTATE; END;
    r := r || jsonb_build_object('A4a_new_submission_refused', CASE WHEN s = '42501' THEN 'PASS' ELSE 'FAIL ' || s END);

    BEGIN
      PERFORM pg_temp.as_user(u_agt, 'p3853-agt@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      WITH u AS (UPDATE public.transaction_submissions SET status = 'submitted' WHERE id = s_up RETURNING 1) SELECT count(*) INTO n FROM u;
      EXECUTE 'RESET ROLE'; s := n::text;
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; s := SQLSTATE; END;
    r := r || jsonb_build_object('A4b_plain_update_to_submitted_refused', CASE WHEN s IN ('0', '42501') THEN 'PASS' ELSE 'FAIL rows=' || s END);

    PERFORM pg_temp.as_user(u_agt, 'p3853-agt@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    v := public.finalize_submission(s_up, '{}'::jsonb);
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('A5_finalize_refused', CASE WHEN v->>'code' = 'account_suspended' THEN 'PASS' ELSE 'FAIL ' || v::text END);

    BEGIN
      PERFORM pg_temp.as_user(u_agt, 'p3853-agt@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('submission-attachments', o_b::text || '/' || s_up::text || '/during.txt', u_agt);
      EXECUTE 'RESET ROLE'; s := 'inserted';
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; s := SQLSTATE; END;
    r := r || jsonb_build_object('CG2s_storage_upload_refused', CASE WHEN s = '42501' THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== G3 / G4 =====
    PERFORM pg_temp.as_user(u_brk, 'p3853-brk@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) INTO n FROM public.transaction_submissions WHERE organization_id = o_b AND submitted_by = u_agt;
    SELECT count(*) INTO n2 FROM public.submission_comments WHERE submission_id = s_sub;
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('A6_reviewer_sees_nothing', CASE WHEN n = 0 AND n2 = 0 THEN 'PASS' ELSE 'FAIL subs=' || n || ' comments=' || n2 END);

    PERFORM pg_temp.as_user(u_agt, 'p3853-agt@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) INTO n FROM public.transaction_submissions WHERE submitted_by = u_agt AND organization_id = o_b;
    SELECT count(*) INTO n2 FROM public.submission_comments WHERE submission_id = s_sub;
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('Q7_member_keeps_own_read_only', CASE WHEN n = 3 AND n2 = 1 THEN 'PASS' ELSE 'FAIL subs=' || n || ' comments=' || n2 END);

    BEGIN
      PERFORM pg_temp.as_user(u_brk, 'p3853-brk@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      WITH u AS (UPDATE public.transaction_submissions SET status = 'approved' WHERE id = s_sub RETURNING 1) SELECT count(*) INTO n FROM u;
      EXECUTE 'RESET ROLE'; s := n::text;
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; s := SQLSTATE; END;
    r := r || jsonb_build_object('A7_reviewer_approve_refused', CASE WHEN s IN ('0', '42501') THEN 'PASS' ELSE 'FAIL rows=' || s END);

    BEGIN
      PERFORM pg_temp.as_user(u_brk, 'p3853-brk@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      UPDATE public.transaction_submissions SET status = 'approved';
      GET DIAGNOSTICS n = ROW_COUNT;
      EXECUTE 'RESET ROLE'; s := n::text;
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; s := SQLSTATE; END;
    r := r || jsonb_build_object('A7b_filterless_patch_refused', CASE WHEN s IN ('0', '42501') THEN 'PASS' ELSE 'FAIL rows=' || s END);

    BEGIN
      PERFORM pg_temp.as_user(u_adm, 'p3853-adm@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      WITH u AS (UPDATE public.transaction_submissions SET status = 'approved' WHERE id = s_adm RETURNING 1) SELECT count(*) INTO n FROM u;
      EXECUTE 'RESET ROLE'; s := n::text;
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; s := SQLSTATE; END;
    r := r || jsonb_build_object('A7self_admin_approves_own_refused', CASE WHEN s IN ('0', '42501') THEN 'PASS' ELSE 'FAIL rows=' || s END);

    -- SR required change 2: the 'uploading' row is admitted by the submitter USING branch, so the
    -- reviewer WITH CHECK clause is the only gate on a reviewer-status write.
    BEGIN
      PERFORM pg_temp.as_user(u_adm, 'p3853-adm@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      WITH u AS (UPDATE public.transaction_submissions SET status = 'approved' WHERE id = s_adm_up RETURNING 1) SELECT count(*) INTO n FROM u;
      EXECUTE 'RESET ROLE'; s := n::text;
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; s := SQLSTATE; END;
    r := r || jsonb_build_object('A7up_admin_approves_own_uploading_refused', CASE WHEN s IN ('0', '42501') THEN 'PASS' ELSE 'FAIL rows=' || s END);

    BEGIN
      PERFORM pg_temp.as_user(u_brk, 'p3853-brk@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM public.set_submission_checklist_reviewer_check(v_item, false);
      EXECUTE 'RESET ROLE'; s := 'ok';
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; s := SQLERRM; END;
    r := r || jsonb_build_object('CG3r_checklist_review_rpc_refused', CASE WHEN s = 'not_authorized' THEN 'PASS' ELSE 'FAIL ' || s END);

    BEGIN
      PERFORM pg_temp.as_user(u_agt, 'p3853-agt@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      INSERT INTO public.submission_comments (submission_id, user_id, content) VALUES (s_sub, u_agt, 'p3853 during');
      EXECUTE 'RESET ROLE'; s := 'inserted';
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; s := SQLSTATE; END;
    r := r || jsonb_build_object('Q7_member_comment_refused', CASE WHEN s = '42501' THEN 'PASS' ELSE 'FAIL ' || s END);

    -- ===== G5 =====
    BEGIN
      PERFORM pg_temp.as_user(u_adm, 'p3853-adm@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      v := public.set_member_license(m_agt, 'unassign');
      EXECUTE 'RESET ROLE'; s := coalesce(v->>'error', v::text);
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; s := SQLERRM; END;
    r := r || jsonb_build_object('A8_unassign_refused', CASE WHEN s = 'account_suspended' THEN 'PASS' ELSE 'FAIL ' || s END);

    BEGIN
      INSERT INTO public.organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, provisioned_by)
        VALUES (o_b, 'p3853-new@example.test', 'agent', 'pending', 'p3853-tok-n', now() + interval '7 days', 'invite');
      s := 'inserted';
    EXCEPTION WHEN OTHERS THEN s := SQLERRM; END;
    r := r || jsonb_build_object('A9_new_invite_refused', CASE WHEN s = 'account_suspended' THEN 'PASS' ELSE 'FAIL ' || s END);

    BEGIN
      INSERT INTO public.organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, provisioned_by)
        VALUES (o_b, 'p3853-new2@example.test', 'agent', 'suspended', 'p3853-tok-n2', now() + interval '7 days', 'invite');
      s := 'inserted';
    EXCEPTION WHEN OTHERS THEN s := SQLERRM; END;
    r := r || jsonb_build_object('A9s_insert_suspended_row_refused', CASE WHEN s = 'account_suspended' THEN 'PASS' ELSE 'FAIL ' || s END);

    BEGIN
      PERFORM pg_temp.as_user(u_inu, 'p3853-inu@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      v := public.accept_invitation('p3853-tok-u');
      EXECUTE 'RESET ROLE'; s := v::text;
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; s := SQLERRM; END;
    r := r || jsonb_build_object('Xu_unassigned_invite_claim_refused', CASE WHEN s = 'account_suspended' THEN 'PASS' ELSE 'FAIL ' || left(s, 120) END);

    BEGIN
      PERFORM pg_temp.as_user(u_inp, 'p3853-inp@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      v := public.accept_invitation('p3853-tok-p');
      EXECUTE 'RESET ROLE'; s := v::text;
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; s := SQLERRM; END;
    r := r || jsonb_build_object('Xp_pending_invite_accept_refused_Q8', CASE WHEN s = 'account_suspended' THEN 'PASS' ELSE 'FAIL ' || left(s, 120) END);

    -- claim with no token or expiry change (isolates the claim branch from the Resend branch)
    BEGIN
      UPDATE public.organization_members SET user_id = u_inu WHERE organization_id = o_b AND invited_email = 'p3853-inu@example.test';
      s := 'claimed';
    EXCEPTION WHEN OTHERS THEN s := SQLERRM; END;
    r := r || jsonb_build_object('Xu2_unassigned_claim_without_token_change_refused', CASE WHEN s = 'account_suspended' THEN 'PASS' ELSE 'FAIL ' || s END);

    BEGIN
      PERFORM pg_temp.as_user(u_adm, 'p3853-adm@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      UPDATE public.organization_members SET invitation_token = 'p3853-tok-p2', invitation_expires_at = now() + interval '7 days' WHERE id = m_inp;
      GET DIAGNOSTICS n = ROW_COUNT;
      EXECUTE 'RESET ROLE'; s := 'rows=' || n;
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; s := SQLERRM; END;
    r := r || jsonb_build_object('CG5r_resend_refused', CASE WHEN s = 'account_suspended' THEN 'PASS' ELSE 'FAIL ' || s END);

    -- SR required change 4: a direct write of organization_id pointing a member row at the suspended org
    BEGIN
      UPDATE public.organization_members SET organization_id = o_b WHERE id = m_mv; s := 'moved';
    EXCEPTION WHEN OTHERS THEN s := SQLERRM; END;
    r := r || jsonb_build_object('Xm_member_row_move_into_suspended_refused', CASE WHEN s = 'account_suspended' THEN 'PASS' ELSE 'FAIL ' || s END);

    BEGIN
      UPDATE public.organization_members SET license_status = 'suspended' WHERE id = m_agt; s := 'ok';
    EXCEPTION WHEN OTHERS THEN s := SQLERRM; END;
    r := r || jsonb_build_object('A10_deactivate_allowed', CASE WHEN s = 'ok' THEN 'PASS' ELSE 'FAIL ' || s END);
    BEGIN
      UPDATE public.organization_members SET license_status = 'active' WHERE id = m_agt; s := 'ok';
    EXCEPTION WHEN OTHERS THEN s := SQLERRM; END;
    r := r || jsonb_build_object('A10b_reactivate_refused', CASE WHEN s = 'account_suspended' THEN 'PASS' ELSE 'FAIL ' || s END);

    v := public._billing_change_seats(o_b, 9, u_staff);
    r := r || jsonb_build_object('C_seats_refused', CASE WHEN v->>'error' = 'account_suspended' THEN 'PASS' ELSE 'FAIL ' || v::text END);

    -- ===== R4 / R14 darkness =====
    v := public._billing_save_deal(o_l, '{"stripe_mode":"live","seats":3}'::jsonb, u_staff, 'p3853', NULL);
    r := r || jsonb_build_object('C13_save_live_refused', CASE WHEN v->>'error' = 'billing_not_live' AND NOT EXISTS (SELECT 1 FROM public.org_deals WHERE organization_id = o_l) THEN 'PASS' ELSE 'FAIL ' || v::text END);
    BEGIN
      v := public._billing_save_deal(o_l, '{"stripe_mode":"test","seats":3}'::jsonb, u_staff, 'p3853', NULL); s := v::text;
    EXCEPTION WHEN OTHERS THEN s := SQLSTATE; END;
    r := r || jsonb_build_object('C13_test_deal_needs_is_test_org', CASE WHEN s = '42501' THEN 'PASS' ELSE 'FAIL ' || s END);
    INSERT INTO public.org_deals (organization_id, stripe_mode, seats, status) VALUES (o_l2, 'live', 3, 'active');
    PERFORM pg_temp.as_user(u_staff, 'p3853-staff@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    v := public.admin_suspend_org(o_l2, 'other', 'p3853');
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('C13_suspend_live_refused', CASE WHEN v->>'error' = 'billing_not_live' THEN 'PASS' ELSE 'FAIL ' || v::text END);
    UPDATE public.org_deals SET status = 'suspended', suspended_reason = 'other' WHERE organization_id = o_l2;
    PERFORM pg_temp.as_user(u_staff, 'p3853-staff@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    v := public.admin_reinstate_org(o_l2, 'p3853');
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('C13_reinstate_live_refused', CASE WHEN v->>'error' = 'billing_not_live' THEN 'PASS' ELSE 'FAIL ' || v::text END);
    UPDATE public.billing_settings SET enabled = true WHERE key = 'brokerage_billing_live';
    v := public._billing_save_deal(o_l, '{"stripe_mode":"live","seats":3}'::jsonb, u_staff, 'p3853', NULL);
    UPDATE public.billing_settings SET enabled = false WHERE key = 'brokerage_billing_live';
    r := r || jsonb_build_object('C13_switch_is_the_gate', CASE WHEN v->>'success' = 'true' THEN 'PASS' ELSE 'FAIL ' || v::text END);

    INSERT INTO public.org_deals (organization_id, stripe_mode, seats, status) VALUES (o_c, 'test', 3, 'canceled');
    PERFORM pg_temp.as_user(u_staff, 'p3853-staff@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN
      v := public.admin_suspend_org(o_c, 'non_payment', 'p3853');
    EXCEPTION WHEN OTHERS THEN v := jsonb_build_object('raised', SQLSTATE || ' ' || left(SQLERRM, 60)); END;
    f := public.admin_suspend_org(o_n, 'non_payment', 'p3853');
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('C13_R4_needs_active_deal', CASE WHEN v->>'error' = 'deal_not_active' AND f->>'error' = 'no_deal' THEN 'PASS' ELSE 'FAIL ' || v::text || ' ' || f::text END);

    BEGIN
      PERFORM pg_temp.as_user(u_adm, 'p3853-adm@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      v := public.admin_suspend_org(o_c, 'non_payment', 'p3853');
      EXECUTE 'RESET ROLE'; s := v::text;
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; s := SQLSTATE; END;
    r := r || jsonb_build_object('C13_suspend_needs_billing_suspend', CASE WHEN s = '42501' THEN 'PASS' ELSE 'FAIL ' || s END);

    -- SR required change 3: a brokerage admin (no billing.suspend) cannot reinstate their own org
    BEGIN
      PERFORM pg_temp.as_user(u_adm, 'p3853-adm@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      v := public.admin_reinstate_org(o_b, 'p3853 self');
      EXECUTE 'RESET ROLE'; s := v::text;
    EXCEPTION WHEN OTHERS THEN EXECUTE 'RESET ROLE'; s := SQLSTATE; END;
    r := r || jsonb_build_object('C13_reinstate_needs_billing_suspend', CASE WHEN s = '42501' AND public.org_billing_suspended(o_b) THEN 'PASS' ELSE 'FAIL ' || left(s, 60) || ' suspended=' || public.org_billing_suspended(o_b)::text END);
    IF NOT public.org_billing_suspended(o_b) THEN  -- keep the fixture suspended for the checks that follow
      PERFORM pg_temp.as_user(u_staff, 'p3853-staff@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM public.admin_suspend_org(o_b, 'non_payment', 'p3853');
      EXECUTE 'RESET ROLE';
    END IF;

    -- ===== C-8 catalog =====
    SELECT count(*) INTO n FROM unnest(ARRAY['public.billing_settings', 'public.price_book_items', 'public.price_book_prices', 'public.org_deals',
                                             'public.org_deal_lines', 'public.org_billing_stripe', 'public.billing_change_log']) t
     WHERE has_table_privilege('anon', t, 'SELECT') OR has_table_privilege('authenticated', t, 'SELECT')
        OR has_table_privilege('anon', t, 'INSERT') OR has_table_privilege('authenticated', t, 'INSERT');
    SELECT count(*) INTO n2 FROM unnest(ARRAY['public._billing_save_deal(uuid,jsonb,uuid,text,integer)', 'public._billing_suspend_org(uuid,text,text,uuid)',
                                              'public._billing_reinstate_org(uuid,text,uuid)', 'public._billing_auto_reinstate(uuid,text)',
                                              'public._billing_apply_org_entitlement(uuid)', 'public._billing_change_seats(uuid,integer,uuid)',
                                              'public._billing_apply_org_subscription(uuid,text,jsonb,bigint)', 'public.billing_deciding_org(uuid)',
                                              'public.billing_purchase_blocked(uuid)', 'public._billing_brokerage_live()']) fn
     WHERE has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE');
    r := r || jsonb_build_object('C8_catalog', CASE
      WHEN n = 0 AND n2 = 0
       AND NOT has_function_privilege('anon', 'public.org_billing_suspended(uuid)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'public.org_billing_suspended(uuid)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.admin_suspend_org(uuid,text,text)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.admin_reinstate_org(uuid,text)', 'EXECUTE') THEN 'PASS'
      ELSE 'FAIL tables=' || n || ' fns=' || n2 END);

    -- ===== engine rules: A12 (R8), C-12 db half, C-9 db half, A11 + C-7 =====
    PERFORM pg_temp.as_user(u_staff, 'p3853-staff@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.admin_reinstate_org(o_b, 'p3853');
    v := public.admin_suspend_org(o_b, 'other', 'p3853');
    EXECUTE 'RESET ROLE';
    PERFORM public._billing_apply_org_subscription(o_b, 'test', '{"status":"active","stripe_customer_id":"cus_p3853","stripe_subscription_id":"sub_p3853"}'::jsonb, 100);
    v := public._billing_auto_reinstate(o_b, 'test');
    r := r || jsonb_build_object('A12_payment_never_lifts_other', CASE WHEN public.org_billing_suspended(o_b) THEN 'PASS' ELSE 'FAIL ' || v::text END);

    PERFORM pg_temp.as_user(u_staff, 'p3853-staff@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.admin_reinstate_org(o_b, 'p3853');
    PERFORM public.admin_suspend_org(o_b, 'non_payment', 'p3853');
    EXECUTE 'RESET ROLE';
    PERFORM public._billing_apply_org_subscription(o_b, 'test', '{"status":"past_due"}'::jsonb, 200);
    v := public._billing_auto_reinstate(o_b, 'test');
    r := r || jsonb_build_object('C12db_reinstate_needs_active_subscription', CASE WHEN public.org_billing_suspended(o_b) THEN 'PASS' ELSE 'FAIL ' || v::text END);
    v := public._billing_apply_org_subscription(o_b, 'test', '{"status":"active"}'::jsonb, 150);
    r := r || jsonb_build_object('C9db_older_event_ignored', CASE WHEN v->>'applied' = 'false'
      AND (SELECT status FROM public.org_billing_stripe WHERE organization_id = o_b AND stripe_mode = 'test') = 'past_due' THEN 'PASS' ELSE 'FAIL ' || v::text END);
    PERFORM public._billing_apply_org_subscription(o_b, 'test', '{"status":"active"}'::jsonb, 300);
    v := public._billing_auto_reinstate(o_b, 'test');

    PERFORM pg_temp.as_user(u_adm, 'p3853-adm@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    f := public.get_org_features(o_b) -> 'features';
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.as_user(u_brk, 'p3853-brk@example.test'); EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) INTO n FROM public.transaction_submissions WHERE organization_id = o_b;
    EXECUTE 'RESET ROLE';
    r := r || jsonb_build_object('A11_paid_non_payment_reinstates', CASE
      WHEN v->>'success' = 'true' AND NOT public.org_billing_suspended(o_b)
       AND f->'unlimited_transactions'->>'enabled' = 'true' AND f->'account_suspended'->>'enabled' = 'false'
       AND f->'broker_portal_access'->>'source' <> 'override' AND n >= 3 THEN 'PASS'
      ELSE 'FAIL ' || v::text || ' u=' || coalesce(f->'unlimited_transactions'->>'enabled', 'null') || ' s=' || coalesce(f->'account_suspended'->>'enabled', 'null') || ' bpa=' || coalesce(f->'broker_portal_access'->>'source', 'null') || ' n=' || n END);
    r := r || jsonb_build_object('C7_prior_support_grant_restored', CASE
      WHEN (SELECT feature_overrides->'broker_submission' FROM public.organization_plans WHERE organization_id = o_b) = '{"enabled":true,"source":"support"}'::jsonb
       AND f->'broker_submission'->>'enabled' = 'true' THEN 'PASS'
      ELSE 'FAIL ' || coalesce((SELECT feature_overrides::text FROM public.organization_plans WHERE organization_id = o_b), 'null') END);

    RETURN r;
  END $b$$f$;

  FOREACH v_m IN ARRAY v_modes LOOP
    BEGIN
      v_mut := pg_temp.apply_mode(v_m);
      v_r := pg_temp.run();
      RAISE EXCEPTION 'MODE_DONE' USING DETAIL = (jsonb_build_object('mutation', v_mut, 'checks', v_r))::text;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'MODE_DONE' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        v_r := v_detail::jsonb;
        v_res := v_res || jsonb_build_object(v_m, jsonb_build_object(
          'mutation', v_r->'mutation',
          'pass', (SELECT count(*) FROM jsonb_each_text(v_r->'checks') e WHERE e.value = 'PASS'),
          'fail', (SELECT count(*) FROM jsonb_each_text(v_r->'checks') e WHERE e.value <> 'PASS' AND e.value NOT LIKE 'RECORDED%'),
          'reds', CASE WHEN v_m = 'base' THEN (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r->'checks') e WHERE e.value <> 'PASS')
                       ELSE (SELECT coalesce(jsonb_agg(e.key || CASE WHEN e.value LIKE 'FAIL ERR%' OR length(e.value) < 40 THEN ':' || e.value ELSE '' END ORDER BY e.key), '[]'::jsonb) FROM jsonb_each_text(v_r->'checks') e WHERE e.value <> 'PASS') END)
          || CASE WHEN v_m = 'base' THEN jsonb_build_object('checks', v_r->'checks') ELSE '{}'::jsonb END);
      ELSE
        v_res := v_res || jsonb_build_object(v_m, 'ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 200));
      END IF;
    END;
  END LOOP;
  RAISE EXCEPTION 'P3853_RESULT %', v_res;
END
$drv$;
