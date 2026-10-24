-- Migration: Refund must never drive credit balance negative (BACKLOG-2345)
--
-- INCIDENT (verified live, user agent@izzyrescue.org, 2026-07-28)
--   credit_ledger for a PAYG unlock looks like:
--     purchase  +1  (Stripe payment_intent.succeeded -> finalize_paid_unlock)
--     debit     -1  (SAME finalize_paid_unlock immediately consumes the credit)
--   i.e. balance is already 0 (credit spent) the instant the unlock exists.
--   A later Stripe refund (charge.refunded / refund.created) called record_refund,
--   which UNCONDITIONALLY wrote a compensating adjustment(-1) referencing the funding
--   purchase (6adba912...). That double-subtracts an ALREADY-CONSUMED credit:
--     +1 (purchase) -1 (debit) -1 (refund)  =  -1   <-- INVALID (balance = SUM(amount))
--
-- ROOT CAUSE
--   The pre-2345 record_refund body assumed the purchased credit was still sitting in
--   the balance and could be netted out with a flat -1. In the PAYG model the credit is
--   consumed at purchase time, so the -1 has nothing left to net against and underflows.
--   Because record_refund had NO balance floor (unlike unlock_transaction /
--   finalize_paid_unlock, which both RAISE on balance < 0), the underflow persisted.
--
-- FIX (policy (b) = clamp refund to the still-UNSPENT portion of the funding credit)
--   A refund may only reverse the units of the funding entry that were NOT yet consumed:
--       refundable = funding_entry.amount - (# debit rows drawn against that entry)
--   clamped to >= 0, and additionally clamped to the user's current (>=0) balance as a
--   hard floor so a refund can NEVER take balance below 0 regardless of prior ledger state.
--     * Fully-consumed credit (the incident case): refundable = 0 -> write NO ledger row
--       (an adjustment must be non-zero per credit_ledger_amount_sign_ck) and record
--       credit_already_consumed=true. Balance stays where it was (0). No free credit is
--       granted; the entitlement is still marked refunded so it drops from the tier ladder.
--     * Genuinely unspent credit (e.g. an un-consumed top-up purchase): refundable = 1 ->
--       write adjustment(-1) exactly as before. Balance 1 -> 0. Correct.
--   This preserves money integrity in BOTH directions: it never underflows the balance
--   AND it never silently hands back a spendable credit for money that is being refunded.
--
-- WHY NOT a hard balance CHECK/trigger on credit_ledger (documented alternative)
--   A CHECK cannot reference an aggregate (SUM over the user's rows); it would have to be
--   an AFTER-INSERT trigger that RAISEs when the resulting balance < 0. That is deliberately
--   NOT added here: (a) it would convert the refund webhook path into a hard error, making
--   Stripe RETRY the event forever on any future regression instead of self-healing;
--   (b) it would also block a legitimate support clawback via admin_adjust_credits that
--   intentionally lands a user at a corrected negative-then-topped-up state. The correct
--   invariant lives in the write paths (this fix + the existing per-RPC balance floors),
--   not in a blanket table trigger. A trigger backstop remains an option for founder
--   sign-off; it is intentionally left out of this migration.
--
-- SECURITY / BEHAVIOUR: unchanged from the 2005a definition. service_role OR internal
--   role only; same per-user advisory lock; idempotent (no-op if already refunded);
--   still sets transaction_unlocks.refunded_at and marks the payment_intents row refunded.
--
-- ROLLBACK: CREATE OR REPLACE with the 2005a body (see 20260715_backlog_2005_stripe_payg.sql).

CREATE OR REPLACE FUNCTION public.record_refund(
  p_user_id            uuid,
  p_local_transaction_id text,
  p_metadata           jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_unlock           public.transaction_unlocks;
  v_funding_entry    uuid;
  v_funding_amount   integer;
  v_debits_drawn     integer;
  v_refundable       integer;
  v_balance          integer;
  v_adjustment_id    uuid;
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.has_internal_role(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  SELECT * INTO v_unlock
  FROM public.transaction_unlocks
  WHERE user_id = p_user_id AND local_transaction_id = p_local_transaction_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('refunded', false, 'reason', 'no unlock for tx');
  END IF;

  -- Idempotent: already refunded -> no-op (unchanged).
  IF v_unlock.refunded_at IS NOT NULL THEN
    RETURN jsonb_build_object('refunded', true, 'already', true, 'unlock_id', v_unlock.id);
  END IF;

  -- The funding entry (purchase, or a grant adjustment) that this unlock's debit drew down.
  SELECT d.funded_by INTO v_funding_entry
  FROM public.credit_ledger d
  WHERE d.id = v_unlock.ledger_entry_id;

  -- BACKLOG-2345: reverse ONLY the still-unspent units of the funding entry, so an
  -- already-consumed credit is never double-subtracted (which drove balance to -1).
  -- refundable = funding_amount - debits_drawn_against_it, clamped >= 0.
  v_refundable := 0;
  IF v_funding_entry IS NOT NULL THEN
    SELECT f.amount,
           (SELECT count(*)::int FROM public.credit_ledger d
              WHERE d.entry_type = 'debit' AND d.funded_by = f.id)
      INTO v_funding_amount, v_debits_drawn
    FROM public.credit_ledger f
    WHERE f.id = v_funding_entry;

    v_refundable := GREATEST(COALESCE(v_funding_amount, 0) - COALESCE(v_debits_drawn, 0), 0);
  END IF;

  -- Hard floor: never remove more credits than the user currently holds. Guarantees the
  -- refund itself can never push balance below 0 even under an unforeseen prior ledger state.
  v_balance := public.get_credit_balance(p_user_id);
  v_refundable := LEAST(v_refundable, GREATEST(v_balance, 0));

  IF v_refundable > 0 THEN
    -- Some (or all) of the funding credit was still unspent -> reverse just those units.
    -- funded_by stays NULL (this is not a debit); the purchase link lives in metadata.
    INSERT INTO public.credit_ledger
      (user_id, entry_type, amount, reason, metadata, created_by)
    VALUES
      (p_user_id, 'adjustment', -v_refundable, 'refund',
       COALESCE(p_metadata, '{}'::jsonb)
         || jsonb_build_object('refund_of_ledger_entry_id', v_funding_entry),
       NULL)
    RETURNING id INTO v_adjustment_id;
  END IF;

  -- Mark the entitlement refunded -> drops out of get_next_unlock_quote's counter
  -- (unchanged; happens whether or not a ledger row was written).
  UPDATE public.transaction_unlocks
  SET refunded_at = now()
  WHERE id = v_unlock.id;

  -- Mark the matching payment_intents row (best-effort; keyed by tx + user; unchanged).
  UPDATE public.payment_intents
  SET status = 'refunded', updated_at = now()
  WHERE user_id = p_user_id AND local_transaction_id = p_local_transaction_id
    AND status IN ('succeeded','fulfilled');

  RETURN jsonb_build_object(
    'refunded', true,
    'already', false,
    'unlock_id', v_unlock.id,
    'adjustment_ledger_id', v_adjustment_id,          -- NULL when the credit was already consumed
    'credit_already_consumed', (v_refundable = 0),
    'balance_after', public.get_credit_balance(p_user_id)
  );
END;
$$;

COMMENT ON FUNCTION public.record_refund(uuid, text, jsonb) IS
  'BACKLOG-2345 (supersedes 2005a): refund netting that can NEVER drive balance < 0. '
  'service_role/internal only. Sets transaction_unlocks.refunded_at, marks payment_intents '
  'refunded, and writes a compensating adjustment for ONLY the still-unspent units of the '
  'funding credit (refundable = funding_amount - debits_drawn, clamped to >=0 and to the '
  'current balance). A fully-consumed credit (PAYG unlock) writes NO ledger row '
  '(credit_already_consumed=true) so the balance stays at 0 instead of underflowing to -1. '
  'Idempotent (no-op if already refunded).';
