-- Migration: Chargeback -> account suspension (BACKLOG-2077, epic 1998 Payments)
--
-- FILE ONLY -- NOT YET APPLIED TO PROD. Ships via the normal release migration run.
-- (The BACKLOG-2097 file in this tree was already-applied and self-documents that;
--  this one is brand new and must run on deploy.)
--
-- CONTEXT (founder decision 2026-07-16, pm_events on BACKLOG-1998)
--   On a Stripe chargeback (charge.dispute.created) we block the WHOLE account, not
--   just the disputed deal. The desktop app already enforces a suspended state:
--   electron/services/licenseService.ts maps public.licenses.status = 'suspended'
--   -> LicenseValidationResult.blockReason = 'suspended', which AppRouter / LicenseGate
--   render as the humane UpgradeScreen ("License Suspended -- contact support", with a
--   Sign Out affordance). So the ONE switch the desktop honours is licenses.status.
--
--   This migration adds:
--     1. account_suspensions       -- append-only audit of suspend/reinstate events
--                                     (which tx, amount, dispute id, date, who acted).
--     2. suspend_account_for_dispute(...) -- SERVICE-ROLE-only RPC the webhook calls to
--                                     flip licenses.status -> 'suspended' + record the event.
--                                     Idempotent per (user, dispute).
--     3. reinstate_suspended_account(...) -- INTERNAL-ROLE-guarded RPC for support to lift
--                                     a suspension (restores the pre-suspension status) +
--                                     record the event. Mirrors the admin_adjust_credits
--                                     auth pattern (browser cookie session -> auth.uid()
--                                     -> has_internal_role guard).
--
--   Dispute WON/LOST auto-lift is intentionally OUT of v1 (founder): support lifts manually.
--
-- SECURITY / AUTH
--   * suspend_account_for_dispute is SYSTEM-triggered (Stripe webhook, service-role). It has
--     NO internal-role guard (there is no auth.uid() in a service-role call) but is REVOKEd
--     from PUBLIC/anon/authenticated so only service_role (and internal callers) can invoke it.
--   * reinstate_suspended_account is HUMAN-triggered by support and IS guarded by
--     has_internal_role(auth.uid()); REVOKEd from PUBLIC/anon so the pre-auth surface is gone.
--   * account_suspensions is written ONLY via these SECURITY DEFINER RPCs; RLS allows
--     internal-role SELECT for the support UI and blocks all direct client writes.
--
-- ROLLBACK
--   DROP FUNCTION public.reinstate_suspended_account(uuid, text);
--   DROP FUNCTION public.suspend_account_for_dispute(uuid, text, text, text, integer, timestamptz);
--   DROP TABLE IF EXISTS public.account_suspensions;
--   (Restoring a suspended license to active is a manual data fix if needed.)
-- ============================================================================

-- --- 1. Append-only suspension/reinstatement audit table --------------------
CREATE TABLE IF NOT EXISTS public.account_suspensions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- 'suspended' = account blocked (chargeback); 'reinstated' = support lifted it.
  event_type               text NOT NULL CHECK (event_type IN ('suspended', 'reinstated')),
  -- Human-readable reason (chargeback summary or support's lift justification).
  reason                   text NOT NULL,
  -- Dispute provenance (populated on 'suspended'; null on 'reinstated').
  stripe_dispute_id        text,
  stripe_payment_intent_id text,
  local_transaction_id     text,
  amount_cents             integer,
  dispute_created_at       timestamptz,
  -- The license status the account held immediately BEFORE this suspension, so a
  -- reinstate restores it (e.g. a suspended-then-lifted expired trial goes back to
  -- 'expired', not 'active'). Populated on 'suspended'.
  previous_license_status  text,
  -- Who acted: the support operator (auth.uid()) for a reinstate; NULL for the
  -- system/webhook suspend (service-role has no auth.uid()).
  acted_by                 uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_suspensions_user_id_created_at_idx
  ON public.account_suspensions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS account_suspensions_dispute_id_idx
  ON public.account_suspensions (stripe_dispute_id)
  WHERE stripe_dispute_id IS NOT NULL;

COMMENT ON TABLE public.account_suspensions IS
  'BACKLOG-2077: append-only audit of account suspend/reinstate events (chargeback path). Written only via suspend_account_for_dispute / reinstate_suspended_account RPCs.';

-- RLS: internal-role SELECT only; no direct client writes (RPCs are SECURITY DEFINER).
ALTER TABLE public.account_suspensions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_suspensions_internal_select ON public.account_suspensions;
CREATE POLICY account_suspensions_internal_select
  ON public.account_suspensions
  FOR SELECT
  TO authenticated
  USING (public.has_internal_role(auth.uid()));

-- --- 2. System RPC: suspend on chargeback (service-role / webhook) ----------
CREATE OR REPLACE FUNCTION public.suspend_account_for_dispute(
  p_user_id              uuid,
  p_stripe_dispute_id    text,
  p_payment_intent_id    text DEFAULT NULL,
  p_local_transaction_id text DEFAULT NULL,
  p_amount_cents         integer DEFAULT NULL,
  p_dispute_created_at   timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_prev_status text;
  v_event_id    uuid;
  v_reason      text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;
  IF p_stripe_dispute_id IS NULL OR btrim(p_stripe_dispute_id) = '' THEN
    RAISE EXCEPTION 'p_stripe_dispute_id is required';
  END IF;

  -- Idempotency: Stripe retries webhooks. If we already recorded a 'suspended'
  -- event for this dispute, do nothing and report already_suspended.
  IF EXISTS (
    SELECT 1 FROM public.account_suspensions
    WHERE stripe_dispute_id = p_stripe_dispute_id
      AND event_type = 'suspended'
  ) THEN
    RETURN jsonb_build_object('already_suspended', true, 'user_id', p_user_id);
  END IF;

  -- Capture the current license status so a later reinstate can restore it.
  SELECT status INTO v_prev_status
  FROM public.licenses
  WHERE user_id = p_user_id;

  -- Flip the license to suspended (the switch the desktop app honours). A user
  -- with no license row is still audited below; there is simply nothing to flip.
  UPDATE public.licenses
  SET status = 'suspended', updated_at = now()
  WHERE user_id = p_user_id;

  v_reason := 'Chargeback opened (dispute ' || p_stripe_dispute_id || ')'
    || COALESCE(' on tx ' || p_local_transaction_id, '')
    || COALESCE(' for ' || (p_amount_cents::text) || ' cents', '');

  INSERT INTO public.account_suspensions (
    user_id, event_type, reason,
    stripe_dispute_id, stripe_payment_intent_id, local_transaction_id,
    amount_cents, dispute_created_at, previous_license_status, acted_by
  ) VALUES (
    p_user_id, 'suspended', v_reason,
    p_stripe_dispute_id, p_payment_intent_id, p_local_transaction_id,
    p_amount_cents, p_dispute_created_at, v_prev_status, NULL
  )
  RETURNING id INTO v_event_id;

  -- Audit (actor_id is NULL for a system/service-role call -- correct: no human acted).
  PERFORM public.log_admin_action(
    'account.suspend',
    'user',
    p_user_id::text,
    jsonb_build_object(
      'reason', v_reason,
      'stripe_dispute_id', p_stripe_dispute_id,
      'stripe_payment_intent_id', p_payment_intent_id,
      'local_transaction_id', p_local_transaction_id,
      'amount_cents', p_amount_cents,
      'previous_license_status', v_prev_status,
      'suspension_event_id', v_event_id,
      'source', 'stripe_webhook'
    )
  );

  RETURN jsonb_build_object(
    'already_suspended', false,
    'user_id', p_user_id,
    'suspension_event_id', v_event_id,
    'previous_license_status', v_prev_status
  );
END;
$$;

-- System-triggered only: remove the pre-auth + human surface, keep service_role.
REVOKE EXECUTE ON FUNCTION public.suspend_account_for_dispute(uuid, text, text, text, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.suspend_account_for_dispute(uuid, text, text, text, integer, timestamptz) TO service_role;

-- --- 3. Support RPC: reinstate (internal-role guarded) ----------------------
CREATE OR REPLACE FUNCTION public.reinstate_suspended_account(
  p_user_id uuid,
  p_reason  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_prev_status    text;
  v_restore_status text;
  v_event_id       uuid;
BEGIN
  -- Human, internal-role gate (mirrors admin_adjust_credits). auth.uid() flows in
  -- via the operator's browser cookie session.
  IF NOT public.has_internal_role(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to reinstate an account';
  END IF;

  -- Only act if the account is actually suspended -- never silently "reactivate"
  -- an expired/cancelled license that was never a chargeback.
  SELECT status INTO v_prev_status
  FROM public.licenses
  WHERE user_id = p_user_id;

  IF v_prev_status IS DISTINCT FROM 'suspended' THEN
    RAISE EXCEPTION 'Account is not suspended (current status: %)', COALESCE(v_prev_status, 'no license');
  END IF;

  -- Restore the status the account held before the most recent suspension; default
  -- to 'active' if we have no record of a prior status.
  SELECT previous_license_status INTO v_restore_status
  FROM public.account_suspensions
  WHERE user_id = p_user_id AND event_type = 'suspended'
  ORDER BY created_at DESC
  LIMIT 1;

  -- Guard against restoring straight back into 'suspended' (bad prior capture).
  IF v_restore_status IS NULL OR v_restore_status = 'suspended' THEN
    v_restore_status := 'active';
  END IF;

  UPDATE public.licenses
  SET status = v_restore_status, updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.account_suspensions (
    user_id, event_type, reason, previous_license_status, acted_by
  ) VALUES (
    p_user_id, 'reinstated', p_reason, v_prev_status, auth.uid()
  )
  RETURNING id INTO v_event_id;

  PERFORM public.log_admin_action(
    'account.reinstate',
    'user',
    p_user_id::text,
    jsonb_build_object(
      'reason', p_reason,
      'restored_license_status', v_restore_status,
      'suspension_event_id', v_event_id
    )
  );

  RETURN jsonb_build_object(
    'reinstated', true,
    'user_id', p_user_id,
    'restored_license_status', v_restore_status,
    'suspension_event_id', v_event_id
  );
END;
$$;

-- Human internal-role caller: drop the pre-auth surface; the body guard is the gate.
REVOKE EXECUTE ON FUNCTION public.reinstate_suspended_account(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reinstate_suspended_account(uuid, text) TO authenticated, service_role;
