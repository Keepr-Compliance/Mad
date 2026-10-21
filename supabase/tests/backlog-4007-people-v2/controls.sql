-- BACKLOG-4007 People v2 DB controls (user_phones, org_contacts as a member link, People RPCs,
-- the billing-contact triggers). Venue: keepr-test, ONE call, ONE transaction ending in RAISE,
-- so nothing persists. Run after 20261020200000 is applied, or compose it in front
-- (compose.py --with-migration).
-- __MODES__ is replaced with a comma list of quoted mode names. Each mode runs in its own
-- subtransaction: apply the mutation (exact-once replace that raises on 0 or 2+ matches; the md5
-- of pg_get_functiondef must change, else MUTATION NOT APPLIED), build fixtures, run every
-- check, roll back. 'base' = no mutation (every check must PASS).
-- Output: RAISE 'P4007V2_RESULT {mode: {mutation, pass, fail, reds}}'.
-- Fixtures: auth users p4007v-*@example.test, organizations "P4007V *" (is_test), phones
-- 202-555-01xx (reserved fictional range).

DO $drv$
DECLARE
  v_modes text[] := ARRAY[__MODES__]::text[];
  v_m text;
  v_mut text;
  v_res jsonb := '{}'::jsonb;
  v_r jsonb;
  v_detail text;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.as_user(u uuid) RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', u::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  END $b$$f$;

  -- run q as u with role authenticated; the result text, or 'ERR <sqlstate> <message>'
  EXECUTE $f$CREATE FUNCTION pg_temp.call_as(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE v jsonb;
  BEGIN
    BEGIN
      PERFORM pg_temp.as_user(u);
      EXECUTE 'SET LOCAL ROLE authenticated';
      EXECUTE q INTO v;
      EXECUTE 'RESET ROLE';
      RETURN coalesce(v::text, 'null');
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
    END;
  END $b$$f$;

  -- a statement as the service role (SCIM / directory-sync); 'ok' or 'ERR ...'
  EXECUTE $f$CREATE FUNCTION pg_temp.as_service(q text) RETURNS text LANGUAGE plpgsql AS $b$
  BEGIN
    BEGIN
      PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
      PERFORM set_config('request.jwt.claim.sub', '', true);
      EXECUTE 'SET LOCAL ROLE service_role';
      EXECUTE q;
      EXECUTE 'RESET ROLE';
      RETURN 'ok';
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
    END;
  END $b$$f$;

  -- a statement as an authenticated user that returns no value; 'ok:<rows>' or 'ERR ...'
  EXECUTE $f$CREATE FUNCTION pg_temp.exec_as(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE n int;
  BEGIN
    BEGIN
      PERFORM pg_temp.as_user(u);
      EXECUTE 'SET LOCAL ROLE authenticated';
      EXECUTE q;
      GET DIAGNOSTICS n = ROW_COUNT;
      EXECUTE 'RESET ROLE';
      RETURN 'ok:' || n;
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
    END;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.j(s text) RETURNS jsonb LANGUAGE plpgsql AS $b$
  BEGIN
    IF s IS NULL OR s LIKE 'ERR%' THEN RETURN '{}'::jsonb; END IF;
    RETURN s::jsonb;
  END $b$$f$;

  -- one matrix cell: run q as u and roll its effects back. 'allowed' | 'denied' (42501) |
  -- 'refused:<code>' (success false) | 'ERR ...'
  EXECUTE $f$CREATE FUNCTION pg_temp.cell(u uuid, q text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE d text;
  BEGIN
    BEGIN
      d := pg_temp.call_as(u, q);
      RAISE EXCEPTION 'CELL_DONE' USING DETAIL = d;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'CELL_DONE' THEN RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 60); END IF;
      GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL;
      IF d LIKE 'ERR 42501%' THEN RETURN 'denied'; END IF;
      IF d LIKE 'ERR%' THEN RETURN d; END IF;
      IF d::jsonb ->> 'success' = 'false' THEN RETURN 'refused:' || (d::jsonb ->> 'error'); END IF;
      RETURN 'allowed';
    END;
  END $b$$f$;

  -- may u read the phone of (target user, target member)? Pure helper call, no role switch.
  EXECUTE $f$CREATE FUNCTION pg_temp.can_read(u uuid, tu uuid, tm uuid) RETURNS boolean LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM pg_temp.as_user(u);
    RETURN public._can_read_person_phone(tu, tm);
  END $b$$f$;

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
    RETURN 'MUTATION APPLIED ' || p_sig || ' ' || left(m1, 8) || '->' || left(m2, 8) || ' [' || left(p_to, 70) || ']';
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.seats(o uuid) RETURNS int LANGUAGE sql AS $b$
    SELECT count(*)::int FROM public.organization_members m
     WHERE m.organization_id = o AND public.member_row_holds_seat(m.license_status, m.invitation_expires_at, m.user_id)
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.outbox(o uuid, k text) RETURNS int LANGUAGE sql AS $b$
    SELECT count(*)::int FROM public.billing_outbox b WHERE b.organization_id = o AND b.kind = k
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.billing_member(o uuid) RETURNS uuid LANGUAGE sql AS $b$
    SELECT c.member_id FROM public.org_contacts c WHERE c.organization_id = o AND c.role = 'billing' AND c.removed_at IS NULL
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.mem(o uuid, u uuid) RETURNS uuid LANGUAGE sql AS $b$
    SELECT m.id FROM public.organization_members m WHERE m.organization_id = o AND m.user_id = u
  $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.pass(ok boolean, info text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL ' || coalesce(left(info, 120), '') END
  $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE
    rd text := 'public._can_read_person_phone(uuid,uuid)';
    sv text := 'public.org_contact_save(uuid,jsonb)';
    ps text := 'public.org_member_phone_set(uuid,uuid,text)';
    iv text := 'public.org_people_invite(uuid,jsonb)';
    ir text := 'public._org_people_invite_row(uuid,text,text,text,text,uuid)';
    lk text := 'public._org_billing_contact_link(uuid,uuid,text,uuid,boolean)';
    ra text := 'public._org_billing_contact_reassign(uuid,uuid,text)';
    aa text := 'public._org_account_admin_member(uuid,uuid)';
    dg text := 'public._org_billing_contact_member_delete_guard()';
    cp text := 'public._user_phones_claim_pending()';
    im text := 'public._member_role_idp_managed(uuid)';
    rf text := 'public._org_billing_login_refusal(uuid,text)';
    gp text := 'public._guard_billing_login_personal_account()';
  BEGIN
    CASE m
    WHEN 'base' THEN RETURN 'none';
    -- C1: the agent role in the read helper
    WHEN 'read_agent_in_roles' THEN RETURN pg_temp.mut_fn(rd,
      $q$c.role IN ('admin', 'broker', 'it_admin')))$q$, $q$c.role IN ('admin', 'broker', 'it_admin', 'agent')))$q$);
    -- C1: the caller's active term dropped (a suspended admin reads)
    WHEN 'read_no_active_term' THEN RETURN pg_temp.mut_fn(rd,
      $q$            AND c.license_status = 'active'
$q$, '');
    -- C1: the most likely wrong build: a client SELECT grant + a same-org policy
    WHEN 'read_colleague_policy' THEN
      EXECUTE 'GRANT SELECT ON public.user_phones TO authenticated';
      EXECUTE $p$CREATE POLICY p4007v_mut ON public.user_phones FOR SELECT TO authenticated USING (
        EXISTS (SELECT 1 FROM public.organization_members t JOIN public.organization_members c ON c.organization_id = t.organization_id
                 WHERE t.user_id = user_phones.user_id AND c.user_id = auth.uid()))$p$;
      IF NOT has_table_privilege('authenticated', 'public.user_phones', 'SELECT') THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: grant missing'; END IF;
      RETURN 'MUTATION APPLIED GRANT SELECT ON user_phones TO authenticated + same-org policy';
    -- R2: a helper left callable by authenticated
    WHEN 'grant_phone_helper' THEN
      EXECUTE 'GRANT EXECUTE ON FUNCTION public._org_billing_contact_phone(uuid) TO authenticated';
      IF NOT has_function_privilege('authenticated', 'public._org_billing_contact_phone(uuid)', 'EXECUTE') THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: grant missing'; END IF;
      RETURN 'MUTATION APPLIED GRANT EXECUTE _org_billing_contact_phone TO authenticated';
    -- R1: admin_get_org_billing still reads a dropped column
    WHEN 'r1_admin_billing_unreplaced' THEN RETURN pg_temp.mut_fn('public.admin_get_org_billing(uuid)',
      $q$'name', public._member_person(m.id) ->> 'name',$q$, $q$'name', c.full_name,$q$);
    -- R3/C2: the phone setter gated on "any People caller" (lets an IT admin write)
    WHEN 'phone_set_any_caller' THEN RETURN pg_temp.mut_fn(ps,
      $q$IF v_caller IS NULL OR v_caller NOT IN ('staff', 'admin', 'broker') THEN$q$, $q$IF v_caller IS NULL THEN$q$);
    -- R3: org_contact_save takes a phone from an IT admin
    WHEN 'save_phone_any_caller' THEN RETURN pg_temp.mut_fn(sv,
      $q$IF v_phone_raw IS NOT NULL AND v_caller NOT IN ('staff', 'admin', 'broker') THEN$q$, $q$IF false THEN$q$);
    -- R3: org_people_invite takes a phone from an IT admin
    WHEN 'invite_phone_any_caller' THEN RETURN pg_temp.mut_fn(iv,
      $q$IF v_phone_raw IS NOT NULL AND v_caller NOT IN ('staff', 'admin', 'broker') THEN$q$, $q$IF false THEN$q$);
    -- R4: a member of another brokerage linked / written
    WHEN 'save_cross_org' THEN RETURN pg_temp.mut_fn(sv,
      $q$   WHERE m.organization_id = p_org
     AND ((v_member_in$q$, $q$   WHERE true
     AND ((v_member_in$q$);
    WHEN 'phone_set_cross_org' THEN RETURN pg_temp.mut_fn(ps,
      $q$WHERE m.id = p_member_id AND m.organization_id = p_org) THEN$q$, $q$WHERE m.id = p_member_id) THEN$q$);
    WHEN 'link_cross_org' THEN RETURN pg_temp.mut_fn(lk,
      $q$WHERE m.id = p_member AND m.organization_id = p_org) THEN$q$, $q$WHERE m.id = p_member) THEN$q$);
    -- R5: the claim trigger not SECURITY DEFINER
    WHEN 'claim_invoker' THEN
      EXECUTE 'ALTER FUNCTION public._user_phones_claim_pending() SECURITY INVOKER';
      IF (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(cp)) THEN RAISE EXCEPTION 'MUTATION NOT APPLIED'; END IF;
      RETURN 'MUTATION APPLIED ALTER FUNCTION _user_phones_claim_pending SECURITY INVOKER';
    -- C7: the pending phone overwrites the person's own
    WHEN 'claim_overwrites' THEN RETURN pg_temp.mut_fn(cp,
      $q$  IF EXISTS (SELECT 1 FROM public.user_phones p WHERE p.user_id = NEW.user_id) THEN$q$,
      $q$  DELETE FROM public.user_phones WHERE user_id = NEW.user_id;
  IF false THEN$q$);
    -- R6: org flag ignored / member flag ignored
    WHEN 'idp_org_flag_ignored' THEN RETURN pg_temp.mut_fn(im,
      $q$coalesce(idp.attribute_mapping ->> 'group_sync_enabled', '') = 'true'$q$, 'true');
    WHEN 'idp_member_flag_ignored' THEN RETURN pg_temp.mut_fn(im,
      $q$       AND coalesce(m.group_sync_enabled, true))$q$, ')');
    -- R7: a broker may set the IT contact; an IT admin may set the billing contact
    WHEN 'r7_broker_sets_it' THEN RETURN pg_temp.mut_fn(sv,
      $q$OR (v_role IN ('it', 'msp') AND v_caller NOT IN ('staff', 'admin', 'it_admin')) THEN$q$,
      $q$OR (v_role IN ('it', 'msp') AND v_caller NOT IN ('staff', 'admin', 'it_admin', 'broker')) THEN$q$);
    WHEN 'r7_broker_invites_it' THEN RETURN pg_temp.mut_fn(iv,
      $q$OR (v_slot IN ('it', 'msp') AND v_caller NOT IN ('staff', 'admin', 'it_admin')) THEN$q$,
      $q$OR (v_slot IN ('it', 'msp') AND v_caller NOT IN ('staff', 'admin', 'it_admin', 'broker')) THEN$q$);
    WHEN 'r7_it_admin_sets_billing' THEN RETURN pg_temp.mut_fn(sv,
      $q$IF (v_role = 'billing' AND v_caller NOT IN ('staff', 'admin', 'broker'))$q$,
      $q$IF (v_role = 'billing' AND v_caller NOT IN ('staff', 'admin', 'broker', 'it_admin'))$q$);
    -- both layers off for the invite: the RPC gate and the INSERT trigger
    WHEN 'r7_broker_invites_it_no_trigger' THEN
      EXECUTE 'ALTER TABLE public.organization_members DISABLE TRIGGER _guard_it_admin_grant_ins';
      RETURN pg_temp.mut_fn(iv,
      $q$OR (v_slot IN ('it', 'msp') AND v_caller NOT IN ('staff', 'admin', 'it_admin')) THEN$q$,
      $q$OR (v_slot IN ('it', 'msp') AND v_caller NOT IN ('staff', 'admin', 'it_admin', 'broker')) THEN$q$) || ' + DISABLE TRIGGER _guard_it_admin_grant_ins';
    WHEN 'r7_trigger_off' THEN
      EXECUTE 'ALTER TABLE public.organization_members DISABLE TRIGGER _guard_it_admin_grant_upd';
      RETURN 'MUTATION APPLIED DISABLE TRIGGER _guard_it_admin_grant_upd';
    -- C3: every role promoted (admin too); confirm skipped
    WHEN 'c3_promote_admin' THEN RETURN pg_temp.mut_fn(sv,
      $q$IF v_role IN ('it', 'msp') AND v_m.role NOT IN ('admin', 'it_admin') THEN$q$,
      $q$IF v_role IN ('it', 'msp') AND v_m.role NOT IN ('it_admin') THEN$q$);
    WHEN 'c3_skip_confirm' THEN RETURN pg_temp.mut_fn(sv,
      $q$    IF NOT v_confirm THEN$q$, $q$    IF false THEN$q$);
    -- R8a: an unlicensed / billing-only member made it_admin
    WHEN 'r8_unlicensed_promoted' THEN RETURN pg_temp.mut_fn(sv,
      $q$    IF v_m.license_status <> 'active' OR v_m.user_id IS NULL
       OR coalesce(v_m.provisioning_metadata ->> 'billing_only', '') = 'true' THEN$q$, '    IF false THEN');
    -- R8b / C4: provisioned_by 'jit' (the seat trigger turns the invite into a free seat)
    WHEN 'r8_provisioned_jit' THEN RETURN pg_temp.mut_fn(ir,
      $q$          'invite',$q$, $q$          'jit',$q$);
    -- C4: billing-only invite takes a seat / IT invite takes none
    WHEN 'c4_billing_pending' THEN RETURN pg_temp.mut_fn(ir,
      $q$CASE p_kind WHEN 'billing' THEN 'unassigned' ELSE 'pending' END$q$, $q$'pending'$q$);
    WHEN 'c4_it_unassigned' THEN RETURN pg_temp.mut_fn(ir,
      $q$CASE p_kind WHEN 'billing' THEN 'unassigned' ELSE 'pending' END$q$, $q$'unassigned'$q$);
    -- C5: F6 dropped from the refusal; the acceptance trigger reads NEW only
    WHEN 'c5_no_personal_check' THEN RETURN pg_temp.mut_fn(rf,
      $q$  IF v_user IS NOT NULL AND public._user_has_personal_account(v_user) THEN$q$, '  IF false THEN');
    WHEN 'c5_trigger_new_only' THEN RETURN pg_temp.mut_fn(gp,
      $q$
      OR coalesce(OLD.provisioning_metadata ->> 'billing_only', '') = 'true')$q$, ')');
    -- C6: the old billing-only login left behind / an old licensed member removed
    WHEN 'c6_old_login_kept' THEN RETURN pg_temp.mut_fn(lk,
      $q$      IF NOT p_keep_old_login THEN$q$, '      IF false THEN');
    WHEN 'c6_licensed_removed' THEN RETURN pg_temp.mut_fn(lk,
      $q$           AND m.license_status = 'unassigned'
$q$, '');
    -- R9: the client delete guard off; no email queued; acceptor ignored; no staff alert
    WHEN 'r9_delete_unguarded' THEN RETURN pg_temp.mut_fn(dg,
      $q$    IF current_setting('role', true) IN ('authenticated', 'anon') THEN$q$, '    IF false THEN');
    WHEN 'r9_no_email' THEN RETURN pg_temp.mut_fn(ra,
      $q$    IF v_mode IS NOT NULL THEN
      INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
      VALUES (v_mode, 'notify_billing_contact_reassigned'$q$,
      $q$    IF false THEN
      INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
      VALUES (v_mode, 'notify_billing_contact_reassigned'$q$);
    WHEN 'r9_acceptor_ignored' THEN RETURN pg_temp.mut_fn(aa,
      $q$ORDER BY (m.user_id = d.setup_completed_by) DESC NULLS LAST, m.created_at, m.id$q$, 'ORDER BY m.created_at, m.id');
    WHEN 'r9_no_alert' THEN RETURN pg_temp.mut_fn(ra,
      $q$  IF v_mode IS NOT NULL THEN
    INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
    VALUES (v_mode, 'notify_account_manager'$q$,
      $q$  IF false THEN
    INSERT INTO public.billing_outbox (stripe_mode, kind, organization_id, dedupe_key, payload)
    VALUES (v_mode, 'notify_account_manager'$q$);
    -- Shadowed since F1: the BEFORE suspend guard refuses a stamp-less suspend before this AFTER
    -- trigger runs, so its scim_synced_at term no longer decides any cell (expected green).
    WHEN 'r9_any_service_suspend' THEN
      EXECUTE 'DROP TRIGGER org_billing_contact_on_deprovision ON public.organization_members';
      EXECUTE $t$CREATE TRIGGER org_billing_contact_on_deprovision AFTER UPDATE OF license_status, scim_synced_at ON public.organization_members
        FOR EACH ROW WHEN (OLD.license_status IS DISTINCT FROM 'suspended' AND NEW.license_status = 'suspended')
        EXECUTE FUNCTION public._org_billing_contact_on_deprovision()$t$;
      RETURN 'MUTATION APPLIED trigger WHEN without the scim_synced_at term';
    -- R9 (F1): the Deactivate refusal off; the likely wrong build (no scim_synced_at term, so it
    -- also refuses the IdP deprovision)
    WHEN 'r9_suspend_guard_off' THEN
      EXECUTE 'ALTER TABLE public.organization_members DISABLE TRIGGER org_billing_contact_member_suspend_guard';
      RETURN 'MUTATION APPLIED DISABLE TRIGGER org_billing_contact_member_suspend_guard';
    WHEN 'r9_suspend_guard_any_suspend' THEN
      EXECUTE 'DROP TRIGGER org_billing_contact_member_suspend_guard ON public.organization_members';
      EXECUTE $t$CREATE TRIGGER org_billing_contact_member_suspend_guard BEFORE UPDATE OF license_status ON public.organization_members
        FOR EACH ROW WHEN (OLD.license_status IS DISTINCT FROM 'suspended' AND NEW.license_status = 'suspended')
        EXECUTE FUNCTION public._org_billing_contact_member_suspend_guard()$t$;
      RETURN 'MUTATION APPLIED suspend guard WHEN without the scim_synced_at term';
    -- over-broad guards (SR delta cef0832c): refuse EVERY stamp-less suspend / any contact role
    WHEN 'r9_suspend_guard_all' THEN RETURN pg_temp.mut_fn('public._org_billing_contact_member_suspend_guard()',
      E'IF EXISTS (SELECT 1 FROM public.org_contacts c\n              WHERE c.member_id = NEW.id AND c.role = \'billing\' AND c.removed_at IS NULL) THEN',
      'IF true THEN');
    WHEN 'r9_suspend_guard_any_contact' THEN RETURN pg_temp.mut_fn('public._org_billing_contact_member_suspend_guard()',
      $q$c.member_id = NEW.id AND c.role = 'billing' AND c.removed_at IS NULL$q$, $q$c.member_id = NEW.id AND c.removed_at IS NULL$q$);
    WHEN 'r9_suspend_guard_unworded' THEN RETURN pg_temp.mut_fn('public._org_billing_contact_member_suspend_guard()',
      $q$    RAISE EXCEPTION 'billing_contact_member' USING ERRCODE = 'P0001',$q$, $q$    RAISE EXCEPTION 'suspend_refused' USING ERRCODE = 'P0001',$q$);
    -- F2: the email mask put back (the cell now asserts the IT admin sees the email)
    WHEN 'f2_mask_back' THEN RETURN pg_temp.mut_fn('public.org_contacts_list(uuid)',
      $q$               'email', public._member_person(m.id) ->> 'email',
               'phone', public._member_phone(m.id),
               'company_name', c.company_name,$q$,
      $q$               'email', CASE WHEN c.role = 'billing' AND v_caller = 'it_admin' THEN NULL ELSE public._member_person(m.id) ->> 'email' END,
               'phone', public._member_phone(m.id),
               'company_name', c.company_name,$q$);
    WHEN 'r9_deprovision_trigger_off' THEN
      EXECUTE 'ALTER TABLE public.organization_members DISABLE TRIGGER org_billing_contact_on_deprovision';
      RETURN 'MUTATION APPLIED DISABLE TRIGGER org_billing_contact_on_deprovision';
    -- R10b: the SCIM orphan re-key off
    WHEN 'r10b_rekey_off' THEN
      EXECUTE 'ALTER TABLE public.organization_members DISABLE TRIGGER org_billing_login_orphan_rekey';
      RETURN 'MUTATION APPLIED DISABLE TRIGGER org_billing_login_orphan_rekey';
    ELSE RAISE EXCEPTION 'unknown mode %', m;
    END CASE;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    o1 uuid := gen_random_uuid();  -- main brokerage, active deal, billing contact = u_b (setup "me")
    o2 uuid := gen_random_uuid();  -- another brokerage
    o3 uuid := gen_random_uuid();  -- full brokerage (seats = holders)
    o4 uuid := gen_random_uuid();  -- waiting deal (draft): setup "Someone else"
    o5 uuid := gen_random_uuid();  -- no admin: setup by a broker; deprovision -> staff alert
    o6 uuid := gen_random_uuid();  -- IdP group mapping on
    op uuid := gen_random_uuid();  -- personal organization of u_pers
    u_sales uuid := gen_random_uuid(); u_exec uuid := gen_random_uuid();
    u_b uuid := gen_random_uuid(); u_b2 uuid := gen_random_uuid(); u_br uuid := gen_random_uuid();
    u_it uuid := gen_random_uuid(); u_ag uuid := gen_random_uuid(); u_ag2 uuid := gen_random_uuid();
    u_un uuid := gen_random_uuid(); u_sa uuid := gen_random_uuid(); u_x uuid := gen_random_uuid();
    u_xa uuid := gen_random_uuid(); u_b3 uuid := gen_random_uuid(); u_a3 uuid := gen_random_uuid();
    u_b4 uuid := gen_random_uuid(); u_b5 uuid := gen_random_uuid(); u_a5 uuid := gen_random_uuid();
    u_b6 uuid := gen_random_uuid(); u_g6 uuid := gen_random_uuid(); u_f6 uuid := gen_random_uuid();
    u_pers uuid := gen_random_uuid(); u_inv uuid := gen_random_uuid(); u_inv2 uuid := gen_random_uuid();
    u_scim uuid := gen_random_uuid();
    e_inv text := 'p4007v-inv-' || left(gen_random_uuid()::text, 6) || '@example.test';
    e_inv2 text := 'p4007v-inv2-' || left(gen_random_uuid()::text, 6) || '@example.test';
    e_pay text := 'p4007v-pay-' || left(gen_random_uuid()::text, 6) || '@example.test';
    e_scim text := 'p4007v-scim-' || left(gen_random_uuid()::text, 6) || '@example.test';
    e_new text;
    v_team uuid; s text; s2 text; n int; n2 int; rw record; v_mem uuid; v_mem2 uuid; v_tok text; v_cid uuid;
    v_who record; v_ok boolean; v_txt text;
    q10 text := 'SELECT public.admin_save_deal(%L::uuid, %L, %s, %s, %L, %L, NULL::uuid, %L, %s, %s)';
    qt  text := 'SELECT public.broker_accept_terms(%L::uuid, %s, %L, %L)';
    qc  text := 'SELECT public.broker_complete_billing_setup(%L::uuid, %s, %L::jsonb, %L::jsonb, %s)';
    qs  text := 'SELECT public.org_contact_save(%L::uuid, %L::jsonb)';
    qp  text := 'SELECT public.org_member_phone_set(%L::uuid, %L::uuid, %L)';
    qi  text := 'SELECT public.org_people_invite(%L::uuid, %L::jsonb)';
    ql  text := 'SELECT public.org_contacts_list(%L::uuid)';
    co  text := '{"legal_name":"P4007V Realty LLC","address_line1":"1 Main St","city":"Seattle","region":"WA","postal_code":"98101","country":"US"}';
    tv  text := 'keepr-terms-2026-10'; tu text := 'https://keeprcompliance.com/terms';
  BEGIN
    SELECT id INTO v_team FROM public.plans WHERE name = 'Team';

    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    SELECT x, 'p4007v-' || left(x::text, 8) || '@example.test', 'authenticated', 'authenticated',
           '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()
      FROM unnest(ARRAY[u_sales, u_exec, u_b, u_b2, u_br, u_it, u_ag, u_ag2, u_un, u_sa, u_x, u_xa, u_b3, u_a3,
                        u_b4, u_b5, u_a5, u_b6, u_g6, u_f6, u_pers]) x;
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (u_inv, e_inv, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()),
           (u_inv2, e_inv2, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now()),
           (u_scim, e_scim, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now());
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    SELECT x, (SELECT a.email FROM auth.users a WHERE a.id = x), 'email', x::text, 'P4007V ' || left(x::text, 4)
      FROM unnest(ARRAY[u_sales, u_exec, u_b, u_b2, u_br, u_it, u_ag, u_ag2, u_un, u_sa, u_x, u_xa, u_b3, u_a3,
                        u_b4, u_b5, u_a5, u_b6, u_g6, u_f6, u_pers, u_inv, u_inv2, u_scim]) x
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.internal_roles (user_id, role_id)
    SELECT x.u, ar.id FROM (VALUES (u_sales, 'sales'), (u_exec, 'executive')) x(u, slug) JOIN public.admin_roles ar ON ar.slug = x.slug;
    INSERT INTO public.organizations (id, name, slug, max_seats, is_test)
    SELECT x, 'P4007V ' || left(x::text, 8), 'p4007v-' || left(x::text, 8), 20, true FROM unnest(ARRAY[o1, o2, o3, o4, o5, o6]) x;
    INSERT INTO public.organizations (id, name, slug, max_seats, is_test, personal_owner_user_id)
    VALUES (op, 'P4007V personal', 'p4007v-p-' || left(op::text, 8), 1, true, u_pers);
    INSERT INTO public.organization_plans (organization_id, plan_id) SELECT x, v_team FROM unnest(ARRAY[o1, o2, o3, o4, o5, o6]) x;
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, created_at) VALUES
      (o1, u_b2, 'admin', 'active', now(), now() - interval '2 years'),
      (o1, u_b, 'admin', 'active', now(), now()), (o1, u_br, 'broker', 'active', now(), now()),
      (o1, u_it, 'it_admin', 'active', now(), now()), (o1, u_ag, 'agent', 'active', now(), now()),
      (o1, u_ag2, 'agent', 'active', now(), now()), (o1, u_un, 'agent', 'unassigned', now(), now()),
      (o1, u_sa, 'admin', 'suspended', now(), now()),
      (o2, u_x, 'admin', 'active', now(), now()), (o2, u_xa, 'agent', 'active', now(), now()),
      (o3, u_b3, 'admin', 'active', now(), now()), (o3, u_a3, 'agent', 'active', now(), now()),
      (o4, u_b4, 'admin', 'active', now(), now()),
      (o5, u_b5, 'broker', 'active', now(), now()), (o5, u_a5, 'agent', 'active', now(), now()),
      (o6, u_b6, 'admin', 'active', now(), now()), (o6, u_g6, 'agent', 'active', now(), now()),
      (o6, u_f6, 'agent', 'active', now(), now()),
      (op, u_pers, 'admin', 'active', now(), now());
    UPDATE public.organization_members SET group_sync_enabled = NULL WHERE organization_id = o6 AND user_id = u_g6;
    UPDATE public.organization_members SET group_sync_enabled = false WHERE organization_id = o6 AND user_id = u_f6;
    -- o2 has an IdP with group mapping OFF; its agent is not opted out (flag NULL)
    UPDATE public.organization_members SET group_sync_enabled = NULL WHERE organization_id = o2 AND user_id = u_xa;
    INSERT INTO public.organization_identity_providers (organization_id, provider_type, display_name, attribute_mapping, is_active)
    VALUES (o6, 'azure_ad', 'P4007V IdP', '{"group_sync_enabled":"true"}', true),
           (o2, 'azure_ad', 'P4007V IdP off', '{"group_sync_enabled":"false"}', true);
    -- a phone for the target agent (u_ag2), set by the person
    PERFORM pg_temp.as_user(u_ag2);
    PERFORM public.my_phone_set('202-555-0111');

    -- deals: o1, o2, o3, o5, o6 completed; o4 waiting
    FOR rw IN SELECT * FROM (VALUES (o1, 15), (o2, 6), (o3, 2), (o4, 6), (o5, 6), (o6, 6)) t(o, seats) LOOP
      s := pg_temp.call_as(u_sales, format(q10, rw.o, 'test', rw.seats, 2499, NULL, NULL, 'new deal', 'NULL', 'NULL::date'));
      IF pg_temp.j(s)->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'fixture deal % %', rw.o, s; END IF;
    END LOOP;
    FOR v_who IN SELECT * FROM (VALUES (o1, u_b, '202-555-0101'), (o2, u_x, '202-555-0102'), (o3, u_b3, '202-555-0103'),
                                       (o5, u_b5, '202-555-0105'), (o6, u_b6, '202-555-0106')) t(o, u, ph) LOOP
      s := pg_temp.call_as(v_who.u, format(qt, v_who.o, 1, tv, tu));
      s := pg_temp.call_as(v_who.u, format(qc, v_who.o, 1, json_build_object('who', 'me', 'phone', v_who.ph)::text, co, 'false'));
      IF pg_temp.j(s)->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'fixture setup % %', v_who.o, s; END IF;
    END LOOP;

    -- ===== C8 / R1 / R2 / R10c: schema and catalog =====
    r := r || jsonb_build_object('C8_contacts_schema', pg_temp.pass(
      NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'org_contacts'
                   AND column_name IN ('full_name', 'email', 'phone'))
      AND (SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'org_contacts' AND column_name = 'member_id') = 'NO'
      AND (SELECT confdeltype FROM pg_constraint WHERE conname = 'org_contacts_member_id_fkey') = 'c'
      AND to_regclass('public.org_contacts_one_it_idx') IS NOT NULL
      AND to_regclass('public.org_contacts_one_person_per_slot_idx') IS NOT NULL
      AND to_regclass('public.org_contacts_one_billing_idx') IS NOT NULL, 'schema'));
    SELECT string_agg(p.proname, ',') INTO v_txt FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc ILIKE '%org_contacts%'
       AND p.prosrc ~ '\m(c|v_c|v_cur)\.(full_name|email|phone)\M';
    r := r || jsonb_build_object('R1_no_fn_reads_dropped_columns', pg_temp.pass(v_txt IS NULL, v_txt));
    SELECT string_agg(p.proname, ',') INTO v_txt FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.prosrc ~ '(org_billing_login_set|admin_search_users_for_contact|_org_billing_login_create)';
    r := r || jsonb_build_object('R10c_no_fn_names_dropped_rpcs', pg_temp.pass(v_txt IS NULL, v_txt));
    s := pg_temp.call_as(u_b, format('SELECT public.org_billing_login_set(%L::uuid, true)', o1));
    s2 := pg_temp.call_as(u_sales, format('SELECT public.admin_search_users_for_contact(%L::uuid, %L)', o1, 'p4007'));
    r := r || jsonb_build_object('R10c_dropped_rpcs_42883', pg_temp.pass(s LIKE 'ERR 42883%' AND s2 LIKE 'ERR 42883%'
      AND to_regprocedure('public._org_billing_login_create(uuid,uuid)') IS NULL, s || ' / ' || s2));
    SELECT string_agg(f, ',') INTO v_txt FROM unnest(ARRAY[
      'public._org_people_caller(uuid,boolean)', 'public._can_read_person_phone(uuid,uuid)', 'public._member_phone(uuid)',
      'public._member_person(uuid)', 'public._member_phone_put(uuid,text,uuid)', 'public._member_role_idp_managed(uuid)',
      'public._org_account_admin_member(uuid,uuid)', 'public._org_billing_contact_link(uuid,uuid,text,uuid,boolean)',
      'public._org_billing_contact_set(uuid,text,text,text,uuid)', 'public._org_billing_login_refusal(uuid,text)',
      'public._org_people_invite_row(uuid,text,text,text,text,uuid)', 'public._org_billing_contact_phone(uuid)',
      'public._guard_billing_login_personal_account()', 'public._user_phones_claim_pending()',
      'public._org_billing_login_orphan_rekey()', 'public._org_billing_contact_reassign(uuid,uuid,text)',
      'public._org_billing_contact_member_delete_guard()', 'public._org_billing_contact_on_deprovision()',
      'public._guard_it_admin_grant()']) f
     WHERE has_function_privilege('authenticated', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE');
    r := r || jsonb_build_object('R2_helpers_not_client_callable', pg_temp.pass(v_txt IS NULL, v_txt));
    r := r || jsonb_build_object('R2_user_phones_no_client_rights', pg_temp.pass(
      NOT has_table_privilege('authenticated', 'public.user_phones', 'SELECT') AND NOT has_table_privilege('anon', 'public.user_phones', 'SELECT')
      AND NOT has_table_privilege('authenticated', 'public.user_phones', 'INSERT') AND NOT has_table_privilege('authenticated', 'public.user_phones', 'UPDATE')
      AND NOT has_table_privilege('authenticated', 'public.user_phones', 'DELETE')
      AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE schemaname = 'public' AND tablename = 'user_phones')
      AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.user_phones'::regclass), 'grants'));
    SELECT string_agg(p.proname, ',') INTO v_txt FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc LIKE '%BACKLOG-4007 People v2%'
       AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=""');
    r := r || jsonb_build_object('R2_search_path_pinned', pg_temp.pass(v_txt IS NULL, v_txt));

    -- ===== C1: who reads a phone =====
    v_mem := pg_temp.mem(o1, u_ag2);
    r := r || jsonb_build_object('C1_direct_select_refused_for_agent', pg_temp.pass(
      pg_temp.exec_as(u_ag, 'SELECT * FROM public.user_phones') LIKE 'ERR 42501%', 'agent select'));
    r := r || jsonb_build_object('C1_read_matrix', pg_temp.pass(
          NOT pg_temp.can_read(u_ag, u_ag2, NULL)          -- an agent colleague
      AND pg_temp.can_read(u_br, u_ag2, NULL)              -- broker
      AND pg_temp.can_read(u_it, u_ag2, NULL)              -- IT admin
      AND pg_temp.can_read(u_b, u_ag2, NULL)               -- admin
      AND NOT pg_temp.can_read(u_sa, u_ag2, NULL)          -- a suspended admin
      AND NOT pg_temp.can_read(u_x, u_ag2, NULL)           -- an admin of another brokerage
      AND pg_temp.can_read(u_sales, u_ag2, NULL)           -- staff
      AND pg_temp.can_read(u_ag2, u_ag2, NULL),            -- self
      'matrix'));
    s := pg_temp.call_as(u_br, format(ql, o1));
    s2 := pg_temp.call_as(u_ag, format(ql, o1));
    r := r || jsonb_build_object('C1_list_phone_broker_yes_agent_refused', pg_temp.pass(
      EXISTS (SELECT 1 FROM jsonb_array_elements(pg_temp.j(s)->'members') e WHERE e->>'member_id' = v_mem::text AND e->>'phone' = '+12025550111')
      AND s2 LIKE 'ERR 42501%', s2));
    r := r || jsonb_build_object('C1_own_phone_my_phone_get', pg_temp.pass(
      pg_temp.j(pg_temp.call_as(u_ag2, 'SELECT public.my_phone_get()'))->>'phone' = '+12025550111', 'my_phone_get'));
    s := pg_temp.call_as(u_it, format(ql, o1));
    -- PM 6a68d0a2 (F2): no email mask; an IT admin sees the billing contact's name, email and phone.
    r := r || jsonb_build_object('C1_it_admin_sees_billing_phone_and_email', pg_temp.pass(
      EXISTS (SELECT 1 FROM jsonb_array_elements(pg_temp.j(s)->'contacts') e
               WHERE e->>'role' = 'billing' AND e->>'phone' = '+12025550101'
                 AND e->>'email' = public._member_person((e->>'member_id')::uuid) ->> 'email'
                 AND e->>'email' IS NOT NULL), s));

    -- ===== C9: Stripe phone helper =====
    r := r || jsonb_build_object('C9_billing_contact_phone', pg_temp.pass(
      public._org_billing_contact_phone(o1) = '+12025550101'
      AND pg_temp.call_as(u_b, format('SELECT to_jsonb(public._org_billing_contact_phone(%L::uuid))', o1)) LIKE 'ERR 42501%', 'helper'));

    -- ===== C2 / R3: phone writers x callers =====
    v_mem := pg_temp.mem(o1, u_ag);
    r := r || jsonb_build_object('C2_phone_set_matrix', pg_temp.pass(
          pg_temp.cell(u_ag, format(qp, o1, v_mem, '202-555-0112')) = 'denied'
      AND pg_temp.cell(u_it, format(qp, o1, v_mem, '202-555-0112')) = 'denied'
      AND pg_temp.cell(u_br, format(qp, o1, v_mem, '202-555-0112')) = 'allowed'
      AND pg_temp.cell(u_b, format(qp, o1, v_mem, '202-555-0112')) = 'allowed'
      AND pg_temp.cell(u_sales, format(qp, o1, v_mem, '202-555-0112')) = 'allowed'
      AND pg_temp.cell(u_exec, format(qp, o1, v_mem, '202-555-0112')) = 'denied',
      pg_temp.cell(u_it, format(qp, o1, v_mem, '202-555-0112'))));
    r := r || jsonb_build_object('C2_save_phone_matrix', pg_temp.pass(
          pg_temp.cell(u_it, format(qs, o1, json_build_object('role', 'office', 'member_id', v_mem, 'phone', '202-555-0113'))) = 'denied'
      AND pg_temp.cell(u_br, format(qs, o1, json_build_object('role', 'office', 'member_id', v_mem, 'phone', '202-555-0113'))) = 'allowed'
      AND pg_temp.cell(u_b, format(qs, o1, json_build_object('role', 'office', 'member_id', v_mem, 'phone', '202-555-0113'))) = 'allowed'
      AND pg_temp.cell(u_sales, format(qs, o1, json_build_object('role', 'office', 'member_id', v_mem, 'phone', '202-555-0113'))) = 'allowed'
      AND pg_temp.cell(u_it, format(qs, o1, json_build_object('role', 'office', 'member_id', v_mem))) = 'allowed',
      pg_temp.cell(u_it, format(qs, o1, json_build_object('role', 'office', 'member_id', v_mem, 'phone', '202-555-0113')))));
    e_new := 'p4007v-it-' || left(gen_random_uuid()::text, 6) || '@example.test';
    r := r || jsonb_build_object('C2_invite_phone_matrix', pg_temp.pass(
          pg_temp.cell(u_it, format(qi, o1, json_build_object('slot', 'msp', 'email', e_new, 'phone', '202-555-0114', 'company_name', 'P4007V MSP'))) = 'denied'
      AND pg_temp.cell(u_it, format(qi, o1, json_build_object('slot', 'msp', 'email', e_new, 'company_name', 'P4007V MSP'))) = 'allowed'
      AND pg_temp.cell(u_b, format(qi, o1, json_build_object('slot', 'msp', 'email', e_new, 'phone', '202-555-0114', 'company_name', 'P4007V MSP'))) = 'allowed',
      pg_temp.cell(u_it, format(qi, o1, json_build_object('slot', 'msp', 'email', e_new, 'phone', '202-555-0114', 'company_name', 'P4007V MSP')))));

    -- ===== R4: a member id of another brokerage =====
    v_mem2 := pg_temp.mem(o2, u_xa);
    s := pg_temp.call_as(u_b, format(qp, o1, v_mem2, '202-555-0115'));
    s2 := pg_temp.call_as(u_b, format(qs, o1, json_build_object('role', 'office', 'member_id', v_mem2)));
    r := r || jsonb_build_object('R4_cross_org_refused', pg_temp.pass(
      pg_temp.j(s)->>'error' = 'user_not_found' AND pg_temp.j(s2)->>'error' = 'user_not_found'
      AND NOT EXISTS (SELECT 1 FROM public.user_phones p WHERE p.user_id = u_xa)
      AND NOT EXISTS (SELECT 1 FROM public.org_contacts c WHERE c.member_id = v_mem2), s || ' / ' || s2));
    BEGIN
      PERFORM public._org_billing_contact_link(o1, v_mem2, NULL, u_b);
      v_txt := 'linked';
    EXCEPTION WHEN OTHERS THEN v_txt := SQLERRM;
    END;
    r := r || jsonb_build_object('R4_link_refuses_other_brokerage', pg_temp.pass(v_txt = 'billing_contact_not_member', v_txt));

    -- ===== R7: who sets the IT contact / MSP / billing contact =====
    v_mem := pg_temp.mem(o1, u_ag);
    r := r || jsonb_build_object('R7_save_it_matrix', pg_temp.pass(
          pg_temp.cell(u_ag, format(qs, o1, json_build_object('role', 'it', 'member_id', v_mem, 'confirm_role_change', true))) = 'denied'
      AND pg_temp.cell(u_br, format(qs, o1, json_build_object('role', 'it', 'member_id', v_mem, 'confirm_role_change', true))) = 'denied'
      AND pg_temp.cell(u_br, format(qs, o1, json_build_object('role', 'msp', 'member_id', v_mem, 'company_name', 'X', 'confirm_role_change', true))) = 'denied'
      -- no role change needed (the person is already an admin): only the RPC gate refuses
      AND pg_temp.cell(u_br, format(qs, o1, json_build_object('role', 'it', 'member_id', pg_temp.mem(o1, u_b2)))) = 'denied'
      AND pg_temp.cell(u_b, format(qs, o1, json_build_object('role', 'it', 'member_id', v_mem, 'confirm_role_change', true))) = 'allowed'
      AND pg_temp.cell(u_it, format(qs, o1, json_build_object('role', 'msp', 'member_id', v_mem, 'company_name', 'X', 'confirm_role_change', true))) = 'allowed'
      AND pg_temp.cell(u_sales, format(qs, o1, json_build_object('role', 'msp', 'member_id', v_mem, 'company_name', 'X', 'confirm_role_change', true))) = 'allowed',
      pg_temp.cell(u_br, format(qs, o1, json_build_object('role', 'it', 'member_id', v_mem, 'confirm_role_change', true)))));
    e_new := 'p4007v-r7-' || left(gen_random_uuid()::text, 6) || '@example.test';
    r := r || jsonb_build_object('R7_invite_it_matrix', pg_temp.pass(
          pg_temp.cell(u_ag, format(qi, o1, json_build_object('slot', 'it', 'email', e_new))) = 'denied'
      AND pg_temp.cell(u_br, format(qi, o1, json_build_object('slot', 'it', 'email', e_new))) = 'denied'
      AND pg_temp.cell(u_b, format(qi, o1, json_build_object('slot', 'it', 'email', e_new))) = 'allowed'
      AND pg_temp.cell(u_it, format(qi, o1, json_build_object('slot', 'it', 'email', e_new))) = 'allowed'
      AND pg_temp.cell(u_sales, format(qi, o1, json_build_object('slot', 'it', 'email', e_new))) = 'allowed',
      pg_temp.cell(u_br, format(qi, o1, json_build_object('slot', 'it', 'email', e_new)))));
    r := r || jsonb_build_object('R7_billing_matrix', pg_temp.pass(
          pg_temp.cell(u_it, format(qs, o1, json_build_object('role', 'billing', 'member_id', pg_temp.mem(o1, u_ag2)))) = 'denied'
      AND pg_temp.cell(u_br, format(qs, o1, json_build_object('role', 'billing', 'member_id', pg_temp.mem(o1, u_ag2)))) = 'allowed'
      AND pg_temp.cell(u_b, format(qs, o1, json_build_object('role', 'billing', 'member_id', pg_temp.mem(o1, u_ag2)))) = 'allowed'
      AND pg_temp.cell(u_sales, format(qs, o1, json_build_object('role', 'billing', 'member_id', pg_temp.mem(o1, u_ag2)))) = 'allowed'
      AND pg_temp.cell(u_it, format(qs, o1, json_build_object('role', 'office', 'member_id', pg_temp.mem(o1, u_ag2)))) = 'allowed',
      pg_temp.cell(u_it, format(qs, o1, json_build_object('role', 'billing', 'member_id', pg_temp.mem(o1, u_ag2))))));
    -- DB guard (the trigger, behind RLS): a temporary open UPDATE policy exposes it; a broker
    -- is refused it_admin, an admin is not. Rolled back by the cell.
    EXECUTE 'CREATE POLICY p4007v_open ON public.organization_members FOR UPDATE TO authenticated USING (true) WITH CHECK (true)';
    s := pg_temp.exec_as(u_br, format('UPDATE public.organization_members SET role = %L WHERE id = %L', 'it_admin', v_mem));
    BEGIN
      s2 := pg_temp.exec_as(u_b, format('UPDATE public.organization_members SET role = %L WHERE id = %L', 'it_admin', v_mem));
      RAISE EXCEPTION 'UNDO';
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    EXECUTE 'DROP POLICY p4007v_open ON public.organization_members';
    r := r || jsonb_build_object('R7_db_guard_trigger', pg_temp.pass(s LIKE 'ERR 42501%it_admin_not_allowed%' AND s2 = 'ok:1', s || ' / ' || s2));

    -- ===== C3: an existing member as the IT contact =====
    s := pg_temp.call_as(u_b, format(qs, o1, json_build_object('role', 'it', 'member_id', v_mem)));
    r := r || jsonb_build_object('C3_agent_needs_confirm', pg_temp.pass(pg_temp.j(s)->>'error' = 'role_change_needs_confirm'
      AND pg_temp.j(s)->>'role' = 'agent'
      AND (SELECT role FROM public.organization_members WHERE id = v_mem) = 'agent', s));
    s := pg_temp.cell(u_b, format(qs, o1, json_build_object('role', 'it', 'member_id', pg_temp.mem(o1, u_b2))));
    BEGIN
      s2 := pg_temp.call_as(u_b, format(qs, o1, json_build_object('role', 'msp', 'member_id', pg_temp.mem(o1, u_b2), 'company_name', 'X')));
      v_txt := (SELECT role FROM public.organization_members WHERE id = pg_temp.mem(o1, u_b2));
      RAISE EXCEPTION 'UNDO';
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    r := r || jsonb_build_object('C3_admin_stays_admin', pg_temp.pass(s = 'allowed' AND v_txt = 'admin', s || ' ' || coalesce(v_txt, '')));
    s := pg_temp.call_as(u_b, format(qs, o1, json_build_object('role', 'it', 'member_id', v_mem, 'confirm_role_change', true)));
    r := r || jsonb_build_object('C3_agent_promoted_after_confirm', pg_temp.pass(pg_temp.j(s)->>'success' = 'true'
      AND (SELECT role FROM public.organization_members WHERE id = v_mem) = 'it_admin'
      AND EXISTS (SELECT 1 FROM public.org_contacts c WHERE c.member_id = v_mem AND c.role = 'it' AND c.removed_at IS NULL), s));
    s := pg_temp.call_as(u_b, format(qs, o1, json_build_object('role', 'it', 'member_id', pg_temp.mem(o1, u_ag2), 'confirm_role_change', true)));
    r := r || jsonb_build_object('C3_one_it_contact', pg_temp.pass(pg_temp.j(s)->>'error' = 'it_contact_exists', s));

    -- ===== R6: the IdP owns the role =====
    r := r || jsonb_build_object('R6_idp_managed', pg_temp.pass(
          pg_temp.cell(u_b6, format(qs, o6, json_build_object('role', 'it', 'member_id', pg_temp.mem(o6, u_g6), 'confirm_role_change', true))) = 'refused:managed_by_idp'
      AND pg_temp.cell(u_b6, format(qs, o6, json_build_object('role', 'it', 'member_id', pg_temp.mem(o6, u_f6), 'confirm_role_change', true))) = 'allowed'
      AND pg_temp.cell(u_x, format(qs, o2, json_build_object('role', 'it', 'member_id', pg_temp.mem(o2, u_xa), 'confirm_role_change', true))) = 'allowed'
      AND (pg_temp.j(pg_temp.call_as(u_b6, format(ql, o6)))->'members') @> jsonb_build_array(jsonb_build_object('member_id', pg_temp.mem(o6, u_g6), 'idp_managed', true)),
      pg_temp.cell(u_b6, format(qs, o6, json_build_object('role', 'it', 'member_id', pg_temp.mem(o6, u_f6), 'confirm_role_change', true)))
        || ' / ' || pg_temp.cell(u_x, format(qs, o2, json_build_object('role', 'it', 'member_id', pg_temp.mem(o2, u_xa), 'confirm_role_change', true)))));

    -- ===== R8: shape of the it_admin promotion and invite =====
    r := r || jsonb_build_object('R8a_unlicensed_not_promoted', pg_temp.pass(
      pg_temp.cell(u_b, format(qs, o1, json_build_object('role', 'msp', 'member_id', pg_temp.mem(o1, u_un), 'company_name', 'X', 'confirm_role_change', true))) = 'refused:needs_license'
      AND (SELECT role FROM public.organization_members WHERE id = pg_temp.mem(o1, u_un)) = 'agent', 'unassigned'));
    e_new := 'p4007v-r8-' || left(gen_random_uuid()::text, 6) || '@example.test';
    s := pg_temp.call_as(u_b, format(qi, o1, json_build_object('slot', 'msp', 'email', e_new, 'company_name', 'P4007V MSP',
           'billing_only', true, 'license_status', 'unassigned', 'role', 'admin', 'provisioned_by', 'jit')));
    r := r || jsonb_build_object('R8b_client_keys_ignored', pg_temp.pass(pg_temp.j(s)->>'success' = 'true'
      AND EXISTS (SELECT 1 FROM public.organization_members m WHERE m.id = (pg_temp.j(s)->>'member_id')::uuid
                   AND m.role = 'it_admin' AND m.license_status = 'pending' AND m.provisioned_by = 'invite'
                   AND coalesce(m.provisioning_metadata ->> 'billing_only', '') = ''), s));

    -- ===== C4: seats =====
    n := pg_temp.seats(o3);
    e_new := 'p4007v-c4b-' || left(gen_random_uuid()::text, 6) || '@example.test';
    s := pg_temp.call_as(u_b3, format(qi, o3, json_build_object('slot', 'billing', 'email', e_new, 'phone', '202-555-0116', 'first_name', 'Pat', 'last_name', 'Payer')));
    r := r || jsonb_build_object('C4_billing_invite_no_seat_in_full_brokerage', pg_temp.pass(pg_temp.j(s)->>'success' = 'true'
      AND pg_temp.seats(o3) = n
      AND EXISTS (SELECT 1 FROM public.organization_members m WHERE m.id = (pg_temp.j(s)->>'member_id')::uuid
                   AND m.license_status = 'unassigned' AND m.provisioning_metadata ->> 'billing_only' = 'true'
                   AND m.invited_first_name = 'Pat')
      AND pg_temp.billing_member(o3) = (pg_temp.j(s)->>'member_id')::uuid
      AND EXISTS (SELECT 1 FROM public.user_phones p WHERE p.pending_member_id = (pg_temp.j(s)->>'member_id')::uuid AND p.phone = '+12025550116'), s));
    e_new := 'p4007v-c4i-' || left(gen_random_uuid()::text, 6) || '@example.test';
    s := pg_temp.call_as(u_b3, format(qi, o3, json_build_object('slot', 'it', 'email', e_new)));
    r := r || jsonb_build_object('C4_it_invite_refused_when_full', pg_temp.pass(pg_temp.j(s)->>'error' = 'seat_limit_reached'
      AND pg_temp.seats(o3) = n AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.invited_email = e_new), s));
    e_new := 'p4007v-c4j-' || left(gen_random_uuid()::text, 6) || '@example.test';
    n := pg_temp.seats(o1);
    s := pg_temp.call_as(u_b, format(qi, o1, json_build_object('slot', 'msp', 'email', e_new, 'company_name', 'P4007V MSP')));
    r := r || jsonb_build_object('C4_it_invite_holds_seat', pg_temp.pass(pg_temp.j(s)->>'success' = 'true' AND pg_temp.seats(o1) = n + 1, s));

    -- ===== C6: changing the billing contact moves the login =====
    v_mem := pg_temp.billing_member(o3);  -- the billing-only invite from C4
    s := pg_temp.call_as(u_b3, format(qs, o3, json_build_object('role', 'billing', 'member_id', pg_temp.mem(o3, u_a3), 'phone', '202-555-0117')));
    r := r || jsonb_build_object('C6_old_billing_only_login_removed', pg_temp.pass(pg_temp.j(s)->>'success' = 'true'
      AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.id = v_mem)
      AND pg_temp.billing_member(o3) = pg_temp.mem(o3, u_a3)
      AND (SELECT d.billing_contact_email FROM public.org_deals d WHERE d.organization_id = o3) = (SELECT lower(email) FROM public.users WHERE id = u_a3), s));
    -- a licensed member who was the contact stays a member
    s := pg_temp.call_as(u_b3, format(qs, o3, json_build_object('role', 'billing', 'member_id', pg_temp.mem(o3, u_b3))));
    r := r || jsonb_build_object('C6_old_licensed_member_kept', pg_temp.pass(pg_temp.j(s)->>'success' = 'true'
      AND pg_temp.mem(o3, u_a3) IS NOT NULL AND pg_temp.billing_member(o3) = pg_temp.mem(o3, u_b3), s));

    -- ===== C5: founder F6 (personal account) =====
    s := pg_temp.call_as(u_b, format(qi, o1, json_build_object('slot', 'billing', 'email', (SELECT email FROM public.users WHERE id = u_pers), 'phone', '202-555-0118')));
    r := r || jsonb_build_object('C5_invite_refuses_personal_account', pg_temp.pass(pg_temp.j(s)->>'error' = 'has_personal_account', s));
    s := pg_temp.call_as(u_b4, format(qt, o4, 1, tv, tu));
    s := pg_temp.call_as(u_b4, format(qc, o4, 1, json_build_object('who', 'other', 'name', 'P4007V Personal',
           'email', (SELECT email FROM public.users WHERE id = u_pers), 'phone', '202-555-0119')::text, co, 'true'));
    r := r || jsonb_build_object('C5_setup_other_refused_before_write', pg_temp.pass(pg_temp.j(s)->>'error' = 'has_personal_account'
      AND (SELECT status FROM public.org_deals WHERE organization_id = o4) = 'draft'
      AND pg_temp.billing_member(o4) IS NULL, s));
    -- an older billing-only invitation claimed by a person with a personal account, clearing
    -- billing_only in the same statement (a493cf6f)
    INSERT INTO public.organization_members (organization_id, invited_email, role, license_status, invitation_token,
      invitation_expires_at, provisioned_by, provisioning_metadata)
    VALUES (o2, (SELECT email FROM public.users WHERE id = u_pers), 'agent', 'unassigned', 'p4007v-tok-' || left(gen_random_uuid()::text, 8),
      now() + interval '7 days', 'invite', '{"billing_only": true}') RETURNING id INTO v_mem;
    BEGIN
      UPDATE public.organization_members SET user_id = u_pers, provisioning_metadata = '{}'::jsonb WHERE id = v_mem;
      v_txt := 'claimed';
    EXCEPTION WHEN OTHERS THEN v_txt := SQLERRM;
    END;
    r := r || jsonb_build_object('C5_accept_clearing_flag_refused', pg_temp.pass(v_txt = 'has_personal_account', v_txt));

    -- ===== setup "Someone else": existing member linked, else a billing-only login =====
    s := pg_temp.call_as(u_b4, format(qc, o4, 1, json_build_object('who', 'other', 'name', 'payer team', 'email', e_pay, 'phone', '202-555-0120')::text, co, 'false'));
    SELECT m.* INTO rw FROM public.organization_members m WHERE m.organization_id = o4 AND m.invited_email = e_pay;
    r := r || jsonb_build_object('S1_setup_other_creates_login', pg_temp.pass(pg_temp.j(s)->>'success' = 'true'
      AND pg_temp.j(s)->'billing_login'->>'token' IS NOT NULL
      AND rw.license_status = 'unassigned' AND rw.provisioning_metadata ->> 'billing_only' = 'true'
      AND pg_temp.billing_member(o4) = rw.id
      AND (SELECT status FROM public.org_deals WHERE organization_id = o4) = 'active', s));

    -- ===== R5 / C7: the pending phone follows acceptance =====
    s := pg_temp.call_as(u_b, format(qi, o1, json_build_object('slot', 'msp', 'email', e_inv, 'company_name', 'P4007V MSP', 'phone', '202-555-0121')));
    v_tok := pg_temp.j(s)->>'token';
    s2 := pg_temp.call_as(u_inv, format('SELECT public.accept_invitation(%L, NULL)', v_tok));
    r := r || jsonb_build_object('R5_accept_claims_pending_phone', pg_temp.pass(pg_temp.j(s2)->>'success' = 'true'
      AND EXISTS (SELECT 1 FROM public.user_phones p WHERE p.user_id = u_inv AND p.phone = '+12025550121')
      AND NOT EXISTS (SELECT 1 FROM public.user_phones p WHERE p.pending_member_id = (pg_temp.j(s)->>'member_id')::uuid), s2));
    -- the person already has a phone: theirs wins
    PERFORM pg_temp.as_user(u_inv2);
    PERFORM public.my_phone_set('202-555-0122');
    s := pg_temp.call_as(u_b, format(qi, o1, json_build_object('slot', 'msp', 'email', e_inv2, 'company_name', 'P4007V MSP', 'phone', '202-555-0123')));
    -- No client-role claim path exists (users_can_view_own_invite / users_can_accept_invite are
    -- false; guard_invite_acceptance), so the claim is accept_invitation.
    s2 := pg_temp.call_as(u_inv2, format('SELECT public.accept_invitation(%L, NULL)', pg_temp.j(s)->>'token'));
    r := r || jsonb_build_object('C7_own_phone_wins_on_claim', pg_temp.pass(pg_temp.j(s2)->>'success' = 'true'
      AND (SELECT p.phone FROM public.user_phones p WHERE p.user_id = u_inv2) = '+12025550122'
      AND NOT EXISTS (SELECT 1 FROM public.user_phones p WHERE p.pending_member_id = (pg_temp.j(s)->>'member_id')::uuid), s2));

    -- ===== R10b: SCIM inserts a second row for the billing-only invite's email =====
    s := pg_temp.call_as(u_x, format(qi, o2, json_build_object('slot', 'billing', 'email', e_scim, 'phone', '202-555-0124')));
    v_mem := (pg_temp.j(s)->>'member_id')::uuid;
    s2 := pg_temp.as_service(format('INSERT INTO public.organization_members (organization_id, user_id, role, license_status, provisioned_by, joined_at) VALUES (%L, %L, %L, %L, %L, now())',
                                    o2, u_scim, 'agent', 'active', 'scim'));
    r := r || jsonb_build_object('R10b_scim_row_takes_over', pg_temp.pass(s2 = 'ok'
      AND pg_temp.billing_member(o2) = pg_temp.mem(o2, u_scim)
      AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.id = v_mem)
      AND EXISTS (SELECT 1 FROM public.user_phones p WHERE p.user_id = u_scim AND p.phone = '+12025550124'), s || ' / ' || s2));

    -- ===== R9: the live billing contact's member row =====
    -- Users-page removal (a client delete) is refused
    v_mem := pg_temp.billing_member(o1);   -- u_b, the admin who completed setup
    EXECUTE 'CREATE POLICY p4007v_del ON public.organization_members FOR DELETE TO authenticated USING (true)';
    s := pg_temp.exec_as(u_b2, format('DELETE FROM public.organization_members WHERE id = %L', v_mem));
    EXECUTE 'DROP POLICY p4007v_del ON public.organization_members';
    r := r || jsonb_build_object('R9_users_page_removal_refused', pg_temp.pass(s LIKE 'ERR P0001 billing_contact_member%'
      AND pg_temp.billing_member(o1) = v_mem, s));
    -- IdP deprovision: the contact moves to the account admin (the setup completer, not the oldest
    -- admin) and an email is queued. Contact = an agent first, so the admin is the target.
    s := pg_temp.call_as(u_b, format(qs, o1, json_build_object('role', 'billing', 'member_id', pg_temp.mem(o1, u_ag2))));
    n := pg_temp.outbox(o1, 'notify_billing_contact_reassigned');
    s2 := pg_temp.as_service(format('UPDATE public.organization_members SET license_status = %L, scim_synced_at = now() WHERE id = %L', 'suspended', pg_temp.mem(o1, u_ag2)));
    r := r || jsonb_build_object('R9_deprovision_moves_to_account_admin', pg_temp.pass(pg_temp.j(s)->>'success' = 'true' AND s2 = 'ok'
      AND pg_temp.billing_member(o1) = pg_temp.mem(o1, u_b)
      AND (SELECT d.billing_contact_email FROM public.org_deals d WHERE d.organization_id = o1) = (SELECT lower(email) FROM public.users WHERE id = u_b),
      s || ' / ' || s2 || ' now ' || coalesce(pg_temp.billing_member(o1)::text, 'none')));
    r := r || jsonb_build_object('R9_deprovision_queues_email', pg_temp.pass(
      pg_temp.outbox(o1, 'notify_billing_contact_reassigned') = n + 1
      AND EXISTS (SELECT 1 FROM public.billing_outbox b WHERE b.organization_id = o1 AND b.kind = 'notify_billing_contact_reassigned'
                   AND b.payload ->> 'member_id' = pg_temp.mem(o1, u_b)::text), 'outbox'));
    -- a Users-page Deactivate (deactivateUser.ts: service client, no scim_synced_at) is refused
    -- (PM 6a68d0a2 F1): the member stays active and stays the billing contact.
    s := pg_temp.call_as(u_b, format(qs, o1, json_build_object('role', 'billing', 'member_id', pg_temp.mem(o1, u_br), 'phone', '202-555-0126')));
    s2 := pg_temp.as_service(format('UPDATE public.organization_members SET license_status = %L, updated_at = now() WHERE id = %L', 'suspended', pg_temp.mem(o1, u_br)));
    r := r || jsonb_build_object('R9_users_page_deactivate_refused', pg_temp.pass(s2 LIKE 'ERR P0001 billing_contact_member%'
      AND pg_temp.billing_member(o1) = pg_temp.mem(o1, u_br)
      AND (SELECT m.license_status FROM public.organization_members m WHERE m.id = pg_temp.mem(o1, u_br)) = 'active', s || ' / ' || s2));
    -- a Users-page Deactivate of a member who is NOT the billing contact still succeeds
    -- (SR delta cef0832c: a guard refusing every Deactivate left all other cells green)
    s2 := pg_temp.as_service(format('UPDATE public.organization_members SET license_status = %L, updated_at = now() WHERE id = %L', 'suspended', pg_temp.mem(o1, u_ag)));
    r := r || jsonb_build_object('R9_deactivate_non_contact_ok', pg_temp.pass(s2 = 'ok'
      AND (SELECT m.license_status FROM public.organization_members m WHERE m.id = pg_temp.mem(o1, u_ag)) = 'suspended'
      AND pg_temp.billing_member(o1) = pg_temp.mem(o1, u_br), s2));
    s2 := pg_temp.as_service(format('UPDATE public.organization_members SET license_status = %L, updated_at = now() WHERE id = %L', 'suspended', pg_temp.mem(o1, u_it)));
    r := r || jsonb_build_object('R9_deactivate_it_member_ok', pg_temp.pass(s2 = 'ok'
      AND (SELECT m.license_status FROM public.organization_members m WHERE m.id = pg_temp.mem(o1, u_it)) = 'suspended', s2));
    -- no active admin: the deal cache is cleared and the account manager is alerted
    n := pg_temp.outbox(o5, 'notify_account_manager');
    s2 := pg_temp.as_service(format('UPDATE public.organization_members SET license_status = %L, scim_synced_at = now() WHERE id = %L', 'suspended', pg_temp.mem(o5, u_b5)));
    r := r || jsonb_build_object('R9_no_admin_alerts_staff', pg_temp.pass(s2 = 'ok'
      AND pg_temp.billing_member(o5) IS NULL
      AND (SELECT d.billing_contact_id IS NULL AND d.billing_contact_email IS NULL FROM public.org_deals d WHERE d.organization_id = o5)
      AND pg_temp.outbox(o5, 'notify_account_manager') = n + 1
      AND EXISTS (SELECT 1 FROM public.billing_outbox b WHERE b.organization_id = o5 AND b.kind = 'notify_account_manager'
                   AND b.payload ->> 'reason' = 'billing_contact_removed'), s2));
    -- a non-client delete (service role) reassigns before the cascade
    s := pg_temp.call_as(u_x, format(qs, o2, json_build_object('role', 'billing', 'member_id', pg_temp.mem(o2, u_xa), 'phone', '202-555-0125')));
    s2 := pg_temp.as_service(format('DELETE FROM public.organization_members WHERE id = %L', pg_temp.mem(o2, u_xa)));
    r := r || jsonb_build_object('R9_service_delete_reassigns', pg_temp.pass(s2 = 'ok' AND pg_temp.billing_member(o2) = pg_temp.mem(o2, u_x), s2));

    -- ===== 3998 users guards untouched =====
    r := r || jsonb_build_object('G_users_guards_unchanged', pg_temp.pass(
      (SELECT string_agg(p.proname || '=' || left(md5(p.prosrc), 8), ',' ORDER BY p.proname) FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('users_client_write_guard', 'users_email_from_auth', 'users_keep_onboarding_completed'))
      = 'users_client_write_guard=22a40e68,users_email_from_auth=eb762a86,users_keep_onboarding_completed=95196b72', 'users guards'));

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
          'fail', (SELECT count(*) FROM jsonb_each_text(v_r->'checks') e WHERE e.value <> 'PASS'),
          'reds', CASE WHEN v_m = 'base' THEN (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each_text(v_r->'checks') e WHERE e.value <> 'PASS')
                       ELSE (SELECT coalesce(jsonb_agg(e.key ORDER BY e.key), '[]'::jsonb) FROM jsonb_each_text(v_r->'checks') e WHERE e.value <> 'PASS') END));
      ELSE
        v_res := v_res || jsonb_build_object(v_m, 'ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 300));
      END IF;
    END;
  END LOOP;
  RAISE EXCEPTION 'P4007V2_RESULT %', v_res;
END
$drv$;
