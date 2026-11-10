-- BACKLOG-2345 DB controls: record_refund never takes the credit balance below zero.
-- Venue: keepr-test, ONE call, ONE transaction that ends in RAISE, so nothing persists.
-- Run after 20261110100000 is applied, or compose it in front (compose.py --with-migration).
-- Run WITHOUT the migration on a venue that still has the 2005a body to see the incident reds.
-- __MODES__ is replaced with a comma list of quoted mode names. Each mode runs in its own
-- subtransaction: apply the mutation(s) (exact-once replace that raises on 0 or 2+ matches; the
-- md5 of pg_get_functiondef must change, else MUTATION NOT APPLIED), build fixtures, run every
-- check, roll back. 'base' = no mutation.
-- Output: RAISE 'P2345_RESULT {mode: {mutation, pass, fail, reds}}'.
--
-- Fixtures are built by the real producers, not hand-written ledger rows:
--   * PAYG: finalize_paid_unlock (service_role), the function payment_intent.succeeded calls
--     (broker-portal/lib/payments/fulfillment.ts). Writes purchase +1 and a purchase-funded debit -1.
--   * Pack: record_credit_purchase(uid, N>1, ...) (service_role) then unlock_transaction (as the
--     user). No portal caller sends N>1 today; the producer accepts it.
--   * Grant / clawback: adjustment rows with the shape admin_adjust_credits writes in production
--     (reason text, metadata keys source + surface; read 2026-11-09 by grouping prod credit_ledger).
--   * payment_intents rows: stripe_mode 'test' (keepr-test trigger guard_stripe_mode_is_test),
--     status 'succeeded'.
-- Every ledger assertion reads credit_ledger directly (SUM(amount)), never balance_after.
-- Fixtures: new auth users p2345-*@example.test.
-- Helpers mut_fn and the mode driver are copied from supabase/tests/backlog-4033/controls.sql.

DO $drv$
DECLARE
  v_modes text[] := ARRAY[__MODES__]::text[];
  v_m text;
  v_mut text;
  v_res jsonb := '{}'::jsonb;
  v_r jsonb;
  v_detail text;
BEGIN
  EXECUTE $f$CREATE FUNCTION pg_temp.as_service() RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.as_user(u uuid) RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', u::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.mk_user() RETURNS uuid LANGUAGE plpgsql AS $b$
  DECLARE u uuid := gen_random_uuid();
  BEGIN
    INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (u, 'p2345-' || left(u::text, 8) || '@example.test', 'authenticated', 'authenticated',
            '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now());
    -- keepr-test: a stripe_mode 'test' payment_intents row needs an is_test personal organization
    INSERT INTO public.organizations (name, slug, max_seats, is_test, personal_owner_user_id)
    VALUES ('P2345 ' || left(u::text, 8), 'p2345-' || left(u::text, 8), 1, true, u);
    RETURN u;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.mk_pi(u uuid, tx text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE pi text := 'pi_test_p2345_' || replace(gen_random_uuid()::text, '-', '');
  BEGIN
    INSERT INTO public.payment_intents (user_id, local_transaction_id, stripe_payment_intent_id,
                                        quoted_unit_price_cents, status, stripe_mode)
    VALUES (u, tx, pi, 4900, 'succeeded', 'test');
    RETURN pi;
  END $b$$f$;

  -- admin_adjust_credits shape (prod): adjustment, reason text, metadata {source, surface}
  EXECUTE $f$CREATE FUNCTION pg_temp.adjust(u uuid, n int) RETURNS void LANGUAGE sql AS $b$
    INSERT INTO public.credit_ledger (user_id, entry_type, amount, reason, metadata)
    VALUES (u, 'adjustment', n, 'test', '{"source":"admin_portal","surface":"p2345"}'::jsonb)
  $b$$f$;

  -- PAYG paid unlock through the real producer
  EXECUTE $f$CREATE FUNCTION pg_temp.payg(u uuid, tx text) RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE pi text; r jsonb;
  BEGIN
    pi := pg_temp.mk_pi(u, tx);
    PERFORM pg_temp.as_service();
    r := public.finalize_paid_unlock(u, tx, 4900, NULL,
           jsonb_build_object('webhook_event_id', 'evt_p2345_' || pi, 'stripe_payment_intent_id', pi));
    UPDATE public.payment_intents SET status = 'fulfilled' WHERE stripe_payment_intent_id = pi;
    RETURN r;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.pack(u uuid, n int) RETURNS void LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM pg_temp.as_service();
    PERFORM public.record_credit_purchase(u, n, 4900,
      jsonb_build_object('webhook_event_id', 'evt_p2345_' || gen_random_uuid(), 'stripe_payment_intent_id', 'pi_test_p2345_pack'));
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.unlock(u uuid, tx text) RETURNS jsonb LANGUAGE plpgsql AS $b$
  BEGIN
    PERFORM pg_temp.as_user(u);
    RETURN public.unlock_transaction(tx);
  END $b$$f$;

  -- the webhook call: service_role, metadata as recordPerExportRefund sends it. Each call is a
  -- distinct Stripe event (charge.refunded and refund.created both fire for one refund), so the
  -- event id is unique per call (credit_ledger_webhook_event is a unique index).
  EXECUTE $f$CREATE FUNCTION pg_temp.refund(u uuid, tx text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE v jsonb;
  BEGIN
    BEGIN
      PERFORM pg_temp.as_service();
      -- run under the real database role so the EXECUTE grant is exercised (jwt claims alone are not)
      PERFORM set_config('role', 'service_role', true);
      v := public.record_refund(u, tx, jsonb_build_object('webhook_event_id', 'evt_p2345_r_' || gen_random_uuid(), 'stripe_payment_intent_id', 'pi_test_p2345_r'));
      PERFORM set_config('role', 'none', true);
      RETURN v::text;
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('role', 'none', true);
      RETURN 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
    END;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.j(s text) RETURNS jsonb LANGUAGE plpgsql AS $b$
  BEGIN
    IF s IS NULL OR s LIKE 'ERR%' THEN RETURN '{}'::jsonb; END IF;
    RETURN s::jsonb;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.sum_(u uuid) RETURNS int LANGUAGE sql AS $b$
    SELECT COALESCE(SUM(amount), 0)::int FROM public.credit_ledger WHERE user_id = u $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.refund_rows(u uuid) RETURNS text LANGUAGE sql AS $b$
    SELECT count(*) || ':' || COALESCE(SUM(amount), 0) FROM public.credit_ledger
     WHERE user_id = u AND entry_type = 'adjustment' AND reason = 'refund' $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.refunded(u uuid, tx text) RETURNS boolean LANGUAGE sql AS $b$
    SELECT refunded_at IS NOT NULL FROM public.transaction_unlocks WHERE user_id = u AND local_transaction_id = tx $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.pi_status(u uuid, tx text) RETURNS text LANGUAGE sql AS $b$
    SELECT string_agg(status, ',') FROM public.payment_intents WHERE user_id = u AND local_transaction_id = tx $b$$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.ck(ok boolean, got text) RETURNS text LANGUAGE sql AS $b$
    SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL ' || COALESCE(got, 'null') END $b$$f$;

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
    RETURN 'MUTATION APPLIED ' || left(m1, 8) || '->' || left(m2, 8) || ' [' || left(regexp_replace(p_to, '\s+', ' ', 'g'), 60) || ']';
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.apply_mode(m text) RETURNS text LANGUAGE plpgsql AS $b$
  DECLARE
    rr text := 'public.record_refund(uuid,text,jsonb)';
    bs text := E'\n    -- Backstop: this write must not leave the balance below zero.\n    IF public.get_credit_balance(p_user_id) < 0 THEN\n      RAISE EXCEPTION ''Balance invariant violated'';\n    END IF;\n';
    cap text := $q$    v_refundable := LEAST(v_refundable, GREATEST(v_balance, 0));$q$;
    out text; a1 text; a2 text;
  BEGIN
    CASE m
    WHEN 'base' THEN RETURN 'none';
    -- floor at 0 removed (GREATEST dropped)
    WHEN 'no_floor0' THEN RETURN pg_temp.mut_fn(rr,
      $q$v_refundable := GREATEST(v_purchase_amount - v_debits_drawn, 0);$q$,
      $q$v_refundable := v_purchase_amount - v_debits_drawn;$q$);
    -- consumption ignored: the whole purchase amount is refundable
    WHEN 'no_consumed' THEN RETURN pg_temp.mut_fn(rr,
      $q$v_refundable := GREATEST(v_purchase_amount - v_debits_drawn, 0);$q$,
      $q$v_refundable := v_purchase_amount;$q$);
    WHEN 'no_cap' THEN RETURN pg_temp.mut_fn(rr, cap, $q$    v_refundable := v_refundable;$q$);
    WHEN 'no_backstop' THEN RETURN pg_temp.mut_fn(rr, bs, E'\n');
    WHEN 'no_cap_no_backstop' THEN
      out := pg_temp.mut_fn(rr, cap, $q$    v_refundable := v_refundable;$q$);
      RETURN out || ' + ' || pg_temp.mut_fn(rr, bs, E'\n');
    -- grant-funded unlocks counted as a funding purchase
    WHEN 'no_purchase_only' THEN RETURN pg_temp.mut_fn(rr,
      $q$JOIN public.credit_ledger f ON f.id = d.funded_by AND f.entry_type = 'purchase'$q$,
      $q$JOIN public.credit_ledger f ON f.id = d.funded_by$q$);
    -- WRONG FIX (a): unconditional -1 kept, only the reported balance clamped
    WHEN 'wrong_clamp_read' THEN
      out := pg_temp.mut_fn(rr, bs, E'\n');
      out := out || ' + ' || pg_temp.mut_fn(rr, $q$  IF v_refundable > 0 THEN$q$, $q$  IF true THEN$q$);
      out := out || ' + ' || pg_temp.mut_fn(rr, $q$'adjustment', -v_refundable,$q$, $q$'adjustment', -1,$q$);
      RETURN out || ' + ' || pg_temp.mut_fn(rr, $q$'balance_after', public.get_credit_balance(p_user_id)$q$,
                                                $q$'balance_after', GREATEST(public.get_credit_balance(p_user_id), 0)$q$);
    -- WRONG FIX (b): consumed credit returns early, before refunded_at / payment_intents
    WHEN 'wrong_skip_refunded_at' THEN RETURN pg_temp.mut_fn(rr,
      $q$  IF v_refundable > 0 THEN$q$,
      $q$  IF v_refundable = 0 THEN
    RETURN jsonb_build_object('refunded', true, 'already', false, 'unlock_id', v_unlock.id, 'credit_already_consumed', true);
  END IF;
  IF v_refundable > 0 THEN$q$);
    -- R2 control: service_role loses its explicit grant AND is revoked (dropping the GRANT alone is
    -- vacuous: the explicit service_role grant is already in the catalog). Proof = proacl change.
    WHEN 'no_service_grant' THEN
      a1 := (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure(rr));
      EXECUTE 'REVOKE EXECUTE ON FUNCTION public.record_refund(uuid,text,jsonb) FROM service_role';
      a2 := (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure(rr));
      IF a1 = a2 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: proacl unchanged'; END IF;
      RETURN 'MUTATION APPLIED acl ' || left(md5(a1), 8) || '->' || left(md5(a2), 8) || ' ' || a2;
    -- S2: gate alone (equivalent while GREATEST floors at 0), and gate + floor removed
    WHEN 'gate_ne0' THEN RETURN pg_temp.mut_fn(rr, $q$  IF v_refundable > 0 THEN$q$, $q$  IF v_refundable <> 0 THEN$q$);
    WHEN 'no_floor0_gate_ne0' THEN
      out := pg_temp.mut_fn(rr, $q$v_refundable := GREATEST(v_purchase_amount - v_debits_drawn, 0);$q$, $q$v_refundable := v_purchase_amount - v_debits_drawn;$q$);
      RETURN out || ' + ' || pg_temp.mut_fn(rr, $q$  IF v_refundable > 0 THEN$q$, $q$  IF v_refundable <> 0 THEN$q$);
    ELSE RAISE EXCEPTION 'unknown mode %', m;
    END CASE;
  END $b$$f$;

  EXECUTE $f$CREATE FUNCTION pg_temp.run() RETURNS jsonb LANGUAGE plpgsql AS $b$
  DECLARE
    r jsonb := '{}'::jsonb;
    u uuid; s text; s2 text; pi text;
  BEGIN
    -- ===== S: spent PAYG credit, nothing else (the incident) =====
    u := pg_temp.mk_user();
    PERFORM pg_temp.payg(u, 'tx-s');
    r := r || jsonb_build_object('S_setup_balance0', pg_temp.ck(pg_temp.sum_(u) = 0, pg_temp.sum_(u)::text));
    s := pg_temp.refund(u, 'tx-s');
    r := r || jsonb_build_object('S_ledger_sum_0', pg_temp.ck(pg_temp.sum_(u) = 0, pg_temp.sum_(u)::text || ' ' || s));
    r := r || jsonb_build_object('S_no_refund_row', pg_temp.ck(pg_temp.refund_rows(u) = '0:0', pg_temp.refund_rows(u)));
    r := r || jsonb_build_object('S_refunded_at_set', pg_temp.ck(pg_temp.refunded(u, 'tx-s'), s));
    r := r || jsonb_build_object('S_pi_refunded', pg_temp.ck(pg_temp.pi_status(u, 'tx-s') = 'refunded', pg_temp.pi_status(u, 'tx-s')));
    r := r || jsonb_build_object('S_flag_consumed', pg_temp.ck(pg_temp.j(s)->>'credit_already_consumed' = 'true', s));
    s2 := pg_temp.refund(u, 'tx-s');
    r := r || jsonb_build_object('S_double_no_row', pg_temp.ck(pg_temp.refund_rows(u) = '0:0' AND pg_temp.j(s2)->>'already' = 'true', pg_temp.refund_rows(u) || ' ' || s2));

    -- ===== S5: spent PAYG credit, then a +5 grant (the prod row's shape: masked by a later grant) =====
    u := pg_temp.mk_user();
    PERFORM pg_temp.payg(u, 'tx-s5');
    PERFORM pg_temp.adjust(u, 5);
    s := pg_temp.refund(u, 'tx-s5');
    r := r || jsonb_build_object('S5_ledger_sum_5', pg_temp.ck(pg_temp.sum_(u) = 5, pg_temp.sum_(u)::text || ' ' || s));
    r := r || jsonb_build_object('S5_flag_consumed', pg_temp.ck(pg_temp.j(s)->>'credit_already_consumed' = 'true', s));

    -- ===== B: unspent purchased credit (pack of 2, one unlock) =====
    u := pg_temp.mk_user();
    PERFORM pg_temp.pack(u, 2);
    s := pg_temp.unlock(u, 'tx-b');
    pi := pg_temp.mk_pi(u, 'tx-b');
    r := r || jsonb_build_object('B_setup_purchase_funded', pg_temp.ck(pg_temp.j(s)->>'funding_source' = 'purchase' AND pg_temp.sum_(u) = 1, s));
    s := pg_temp.refund(u, 'tx-b');
    r := r || jsonb_build_object('B_one_row_minus1', pg_temp.ck(pg_temp.refund_rows(u) = '1:-1', pg_temp.refund_rows(u) || ' ' || s));
    r := r || jsonb_build_object('B_ledger_sum_0', pg_temp.ck(pg_temp.sum_(u) = 0, pg_temp.sum_(u)::text));
    r := r || jsonb_build_object('B_flag_not_consumed', pg_temp.ck(pg_temp.j(s)->>'credit_already_consumed' = 'false', s));
    r := r || jsonb_build_object('B_refunded_at_set', pg_temp.ck(pg_temp.refunded(u, 'tx-b'), s));
    r := r || jsonb_build_object('B_pi_refunded', pg_temp.ck(pg_temp.pi_status(u, 'tx-b') = 'refunded', pg_temp.pi_status(u, 'tx-b')));
    s2 := pg_temp.refund(u, 'tx-b');
    r := r || jsonb_build_object('B_double_no_second_row', pg_temp.ck(pg_temp.refund_rows(u) = '1:-1' AND pg_temp.sum_(u) = 0, pg_temp.refund_rows(u) || ' ' || s2));

    -- ===== P: partially consumed pack (3 bought, 2 unlocked) -> only the unspent 1 =====
    u := pg_temp.mk_user();
    PERFORM pg_temp.pack(u, 3);
    PERFORM pg_temp.unlock(u, 'tx-p1');
    PERFORM pg_temp.unlock(u, 'tx-p2');
    s := pg_temp.refund(u, 'tx-p1');
    r := r || jsonb_build_object('P_one_row_minus1', pg_temp.ck(pg_temp.refund_rows(u) = '1:-1', pg_temp.refund_rows(u) || ' ' || s));
    r := r || jsonb_build_object('P_ledger_sum_0', pg_temp.ck(pg_temp.sum_(u) = 0, pg_temp.sum_(u)::text));
    r := r || jsonb_build_object('P_other_unlock_untouched', pg_temp.ck(NOT pg_temp.refunded(u, 'tx-p2'), 'refunded'));

    -- ===== Q: pack of 3, one unlock -> unspent 2 taken back =====
    u := pg_temp.mk_user();
    PERFORM pg_temp.pack(u, 3);
    PERFORM pg_temp.unlock(u, 'tx-q');
    s := pg_temp.refund(u, 'tx-q');
    r := r || jsonb_build_object('Q_one_row_minus2', pg_temp.ck(pg_temp.refund_rows(u) = '1:-2', pg_temp.refund_rows(u) || ' ' || s));
    r := r || jsonb_build_object('Q_ledger_sum_0', pg_temp.ck(pg_temp.sum_(u) = 0, pg_temp.sum_(u)::text));

    -- ===== F: pack of 2, one unlock, then a +5 grant -> only the unspent 1 of the purchase =====
    u := pg_temp.mk_user();
    PERFORM pg_temp.pack(u, 2);
    PERFORM pg_temp.unlock(u, 'tx-f');
    PERFORM pg_temp.adjust(u, 5);
    s := pg_temp.refund(u, 'tx-f');
    r := r || jsonb_build_object('F_one_row_minus1', pg_temp.ck(pg_temp.refund_rows(u) = '1:-1', pg_temp.refund_rows(u) || ' ' || s));
    r := r || jsonb_build_object('F_ledger_sum_5', pg_temp.ck(pg_temp.sum_(u) = 5, pg_temp.sum_(u)::text));

    -- ===== K: cap. pack of 2, one unlock, then an admin clawback -1 -> balance 0, unspent 1 =====
    u := pg_temp.mk_user();
    PERFORM pg_temp.pack(u, 2);
    PERFORM pg_temp.unlock(u, 'tx-k');
    PERFORM pg_temp.adjust(u, -1);
    r := r || jsonb_build_object('K_setup_balance0', pg_temp.ck(pg_temp.sum_(u) = 0, pg_temp.sum_(u)::text));
    s := pg_temp.refund(u, 'tx-k');
    r := r || jsonb_build_object('K_no_error', pg_temp.ck(s NOT LIKE 'ERR%', s));
    r := r || jsonb_build_object('K_ledger_sum_0', pg_temp.ck(pg_temp.sum_(u) = 0, pg_temp.sum_(u)::text || ' ' || s));
    r := r || jsonb_build_object('K_no_refund_row', pg_temp.ck(pg_temp.refund_rows(u) = '0:0', pg_temp.refund_rows(u)));
    r := r || jsonb_build_object('K_refunded_at_set', pg_temp.ck(COALESCE(pg_temp.refunded(u, 'tx-k'), false), s));

    -- ===== G: grant-funded unlock with a payment_intents row -> grant credit not taken =====
    u := pg_temp.mk_user();
    PERFORM pg_temp.adjust(u, 3);
    s := pg_temp.unlock(u, 'tx-g');
    pi := pg_temp.mk_pi(u, 'tx-g');
    r := r || jsonb_build_object('G_setup_grant_funded', pg_temp.ck(pg_temp.j(s)->>'funding_source' = 'grant' AND pg_temp.sum_(u) = 2, s));
    s := pg_temp.refund(u, 'tx-g');
    r := r || jsonb_build_object('G_ledger_sum_2', pg_temp.ck(pg_temp.sum_(u) = 2, pg_temp.sum_(u)::text || ' ' || s));
    r := r || jsonb_build_object('G_refunded_at_set', pg_temp.ck(pg_temp.refunded(u, 'tx-g'), s));

    -- ===== O: over-drawn purchase (no producer emits this today): 1-unit purchase, TWO debits
    -- funded_by it. The second debit is a direct insert. Expect: nothing taken back, no row. =====
    u := pg_temp.mk_user();
    PERFORM pg_temp.adjust(u, 5);
    PERFORM pg_temp.payg(u, 'tx-o');
    INSERT INTO public.credit_ledger (user_id, entry_type, amount, funded_by, funding_source, metadata)
    SELECT u, 'debit', -1, d.funded_by, 'purchase', '{}'::jsonb
      FROM public.credit_ledger d WHERE d.user_id = u AND d.entry_type = 'debit';
    r := r || jsonb_build_object('O_setup_overdrawn', pg_temp.ck(
      (SELECT count(*) FROM public.credit_ledger WHERE user_id = u AND entry_type = 'debit') = 2 AND pg_temp.sum_(u) = 4, pg_temp.sum_(u)::text));
    s := pg_temp.refund(u, 'tx-o');
    r := r || jsonb_build_object('O_ledger_sum_4', pg_temp.ck(pg_temp.sum_(u) = 4, pg_temp.sum_(u)::text || ' ' || s));
    r := r || jsonb_build_object('O_no_refund_row', pg_temp.ck(pg_temp.refund_rows(u) = '0:0', pg_temp.refund_rows(u)));
    r := r || jsonb_build_object('O_refunded_at_set', pg_temp.ck(COALESCE(pg_temp.refunded(u, 'tx-o'), false), s));

    -- ===== N: no unlock row -> unchanged exit =====
    u := pg_temp.mk_user();
    pi := pg_temp.mk_pi(u, 'tx-n');
    s := pg_temp.refund(u, 'tx-n');
    r := r || jsonb_build_object('N_exit_reason', pg_temp.ck(pg_temp.j(s)->>'refunded' = 'false' AND pg_temp.j(s)->>'reason' = 'no unlock for tx', s));
    r := r || jsonb_build_object('N_no_rows', pg_temp.ck((SELECT count(*) FROM public.credit_ledger WHERE user_id = u) = 0, 'rows'));
    r := r || jsonb_build_object('N_pi_unchanged', pg_temp.ck(pg_temp.pi_status(u, 'tx-n') = 'succeeded', pg_temp.pi_status(u, 'tx-n')));

    -- ===== A: caller guard unchanged (a signed-in user is refused) =====
    u := pg_temp.mk_user();
    PERFORM pg_temp.as_user(u);
    BEGIN
      -- real role: with service_role-only EXECUTE a signed-in user is stopped by the grant
      -- ("permission denied"); the inner guard ("Unauthorized") is the second line
      PERFORM set_config('role', 'authenticated', true);
      PERFORM public.record_refund(u, 'tx-a', '{}'::jsonb);
      PERFORM set_config('role', 'none', true);
      r := r || jsonb_build_object('A_user_refused', 'FAIL no error');
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('role', 'none', true);
      r := r || jsonb_build_object('A_user_refused', pg_temp.ck(SQLERRM = 'Unauthorized' OR SQLERRM LIKE 'permission denied%', SQLERRM));
    END;

    -- ===== catalog: only service_role holds EXECUTE (PUBLIC, anon, authenticated do not), security definer =====
    r := r || jsonb_build_object('C_grants_secdef', pg_temp.ck(
      NOT has_function_privilege('anon', 'public.record_refund(uuid,text,jsonb)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.record_refund(uuid,text,jsonb)', 'EXECUTE')
      AND (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = 'public.record_refund(uuid,text,jsonb)'::regprocedure) = '{postgres=X/postgres,service_role=X/postgres}'
      AND has_function_privilege('service_role', 'public.record_refund(uuid,text,jsonb)', 'EXECUTE')
      AND (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.record_refund(uuid,text,jsonb)'::regprocedure),
      (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = 'public.record_refund(uuid,text,jsonb)'::regprocedure)));
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
                       ELSE (SELECT coalesce(jsonb_object_agg(e.key, left(e.value, 60)), '{}'::jsonb) FROM jsonb_each_text(v_r->'checks') e WHERE e.value <> 'PASS') END));
      ELSE
        v_res := v_res || jsonb_build_object(v_m, 'ERROR ' || SQLSTATE || ' ' || left(SQLERRM, 200));
      END IF;
    END;
  END LOOP;
  RAISE EXCEPTION 'P2345_RESULT %', v_res;
END
$drv$;
