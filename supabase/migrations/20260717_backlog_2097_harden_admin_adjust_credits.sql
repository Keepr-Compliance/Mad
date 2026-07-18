-- Migration: Harden admin_adjust_credits RPC -- server-side reason + amount cap + revoke anon (BACKLOG-2097)
--
-- GIT<->PROD PARITY MIRROR: this file mirrors the migration applied to PROD
-- (supabase_migrations.schema_migrations version 20260717_backlog_2097_harden_admin_adjust_credits)
-- via MCP apply_migration on 2026-07-17. DO NOT re-apply -- the database already has it.
-- Refs BACKLOG-2097 (SR advisory from PR #1963 / BACKLOG-2016 review). Epic 1998 (Payments).
--
-- CONTEXT
--   admin_adjust_credits (RPC B, defined in 20260714_backlog_2004_credit_ledger.sql) is the
--   sales/support free-credit lever. It is reachable only by internal-role holders
--   (has_internal_role(auth.uid()) body guard) and every call is attributed
--   (credit_ledger.created_by = auth.uid()) and audited (log_admin_action).
--   The BACKLOG-2016 admin UI enforces "reason required" and |amount| <= 10000 CLIENT-SIDE
--   only; the RPC previously re-validated just p_amount != 0. That left two gaps:
--     * credit_ledger.reason is nullable -> the audit trail can contain empty-reason grants.
--     * no server-side magnitude ceiling -> a fat-finger / bypassed-client grant is uncapped.
--
-- ACTION (defense-in-depth, money-path; matches client rules in admin-portal/lib/credit-grant.ts)
--   1. RAISE on empty/whitespace p_reason (server-side mirror of the required-reason rule).
--   2. Enforce abs(p_amount) <= 10000 server-side (server-side mirror of MAX_GRANT_MAGNITUDE).
--   3. REVOKE EXECUTE FROM PUBLIC + anon so an unauthenticated session cannot even invoke it,
--      then GRANT EXECUTE back to authenticated + service_role (the intended callers).
--      NOTE: a bare `REVOKE ... FROM anon` is cosmetic here -- anon is a member of PUBLIC and
--      the function is created with the default PUBLIC EXECUTE grant, so anon keeps EXECUTE via
--      PUBLIC. Revoking from PUBLIC (and re-granting the real callers) is the only way to
--      actually drop anon's execute surface. Mirrors the precedent in
--      20260711071820_security_revoke_anon_exec_token_claim_jit_join.sql. The has_internal_role
--      body guard remains the real gate; this just removes the pre-auth surface.
--
-- Only the function body + EXECUTE grants change. No table/column/RLS changes. Idempotent:
-- CREATE OR REPLACE + REVOKE + GRANT are all safe to re-run against the current state.
--
-- ROLLBACK
--   Re-apply the admin_adjust_credits body from 20260714_backlog_2004_credit_ledger.sql
--   (drops the reason + cap guards) and, if desired, GRANT EXECUTE ... TO PUBLIC.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_adjust_credits(
  p_user_id  uuid,
  p_amount   integer,
  p_reason   text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ledger_id uuid;
BEGIN
  IF NOT public.has_internal_role(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  IF p_amount = 0 THEN
    RAISE EXCEPTION 'Adjustment amount must be non-zero';
  END IF;
  -- BACKLOG-2097: server-side magnitude ceiling (mirror of client MAX_GRANT_MAGNITUDE = 10000).
  IF abs(p_amount) > 10000 THEN
    RAISE EXCEPTION 'Adjustment amount magnitude exceeds the 10000 credit cap';
  END IF;
  -- BACKLOG-2097: reason is required for every adjustment (mirror of the client rule).
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required for every credit adjustment';
  END IF;

  INSERT INTO public.credit_ledger
    (user_id, entry_type, amount, reason, metadata, created_by)
  VALUES
    (p_user_id, 'adjustment', p_amount, p_reason, COALESCE(p_metadata, '{}'::jsonb), auth.uid())
  RETURNING id INTO v_ledger_id;

  PERFORM public.log_admin_action(
    'credits.adjust',
    'user',
    p_user_id::text,
    jsonb_build_object('amount', p_amount, 'reason', p_reason, 'ledger_entry_id', v_ledger_id)
  );

  RETURN jsonb_build_object(
    'ledger_entry_id', v_ledger_id,
    'balance_after', public.get_credit_balance(p_user_id)
  );
END;
$$;

-- BACKLOG-2097: remove the pre-auth EXECUTE surface. Revoke from PUBLIC + anon (anon inherits
-- EXECUTE via PUBLIC, so revoking anon alone is a no-op), then grant back the intended callers.
-- The has_internal_role body guard stays the real gate.
REVOKE EXECUTE ON FUNCTION public.admin_adjust_credits(uuid, integer, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_adjust_credits(uuid, integer, text, jsonb) TO authenticated, service_role;
