-- Migration: harden credit read RPCs against cross-user disclosure (BACKLOG-2094)
--
-- PURPOSE
--   Two SECURITY DEFINER read RPCs -- get_credit_balance and
--   get_next_unlock_quote -- accepted an arbitrary `p_user_id` and were
--   EXECUTE-granted to anon/authenticated. Because they run as the definer
--   (RLS-bypassing) and resolved the target with COALESCE(p_user_id, auth.uid()),
--   ANY caller holding the anon or authenticated key could read ANY user's credit
--   balance or PAYG tier position/quote simply by passing that user's uuid.
--
--   Reported: SR review PR #1957 (get_next_unlock_quote) + Fable-5 review PR #1958
--   (get_credit_balance). Pre-existing since 2004/2005a; the 2086 tier columns
--   marginally widened the get_next_unlock_quote surface.
--
-- FIX
--   Introduce a single resolver, public.resolve_credit_read_user_id(p_user_id),
--   that both RPCs call to decide WHOSE data they may read:
--     * service_role OR internal_roles member -> the override is honored
--       (COALESCE(p_user_id, auth.uid())). This preserves the admin-portal and
--       broker-portal (both service-role clients) cross-user reads.
--     * everyone else (anon / authenticated desktop clients) -> constrained to
--       the AUTHENTICATED caller. Passing NULL (or one's own id) is fine; passing
--       a DIFFERENT uuid is a privilege-escalation attempt and is REJECTED with an
--       exception rather than silently rescoped, so a broken/malicious caller
--       fails loudly instead of leaking or masking the attempt.
--
--   The RPC bodies (the actual balance/quote math) are UNCHANGED -- they simply
--   read from the resolved id instead of COALESCE(p_user_id, auth.uid()). Because
--   the guard needs to RAISE, both functions become plpgsql wrappers around the
--   identical SQL, and the resolver runs as SECURITY DEFINER on the caller's real
--   auth context (auth.uid()/auth.role() are evaluated for the INVOKER, so the
--   SECURITY DEFINER RPCs still see the true caller identity).
--
-- CALLER VERIFICATION (all pass their own / an authorized id -- no anon-path use):
--   * electron/services/entitlementService.ts -> passes the signed-in user's own
--     id via the authed anon-key client (p_user_id == auth.uid()). OK.
--   * admin-portal/lib/billing-queries.ts -> service-role client, cross-user
--     user-detail page. Uses the honored override path. OK.
--   * broker-portal/lib/payments/fulfillment.ts + app/api/payments/checkout-session
--     -> service-role client (createServiceClient()), server-side fulfillment/quote.
--     Uses the honored override path. OK.
--
-- ROLLBACK (restores the pre-2094 permissive behavior):
--   DROP FUNCTION IF EXISTS public.resolve_credit_read_user_id(uuid);
--   -- then re-create get_credit_balance / get_next_unlock_quote from
--   -- 20260714_backlog_2004_credit_ledger.sql / 20260717_backlog_2086_*.sql
--
-- SAFETY
--   Read-only hardening. No table/column/grant surface is widened. Grants are
--   restored to the identical pre-2094 set so the callable surface is unchanged;
--   only WHOSE rows a non-service caller may read is constrained.

-- ============================================================================
-- Resolver: decide the authorized target user id for a credit read.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.resolve_credit_read_user_id(p_user_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_privileged boolean;
BEGIN
  -- Trusted server callers: the project service key (auth.role() = 'service_role')
  -- or an internal_roles member. They may read cross-user (admin/broker portals).
  v_privileged := (auth.role() = 'service_role')
                  OR (v_caller IS NOT NULL
                      AND EXISTS (SELECT 1 FROM public.internal_roles ir
                                  WHERE ir.user_id = v_caller));

  IF v_privileged THEN
    RETURN COALESCE(p_user_id, v_caller);
  END IF;

  -- Non-privileged callers are constrained to themselves.
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not authenticated'
      USING ERRCODE = '42501'; -- insufficient_privilege
  END IF;

  IF p_user_id IS NOT NULL AND p_user_id <> v_caller THEN
    RAISE EXCEPTION 'not authorized to read another user''s credit data'
      USING ERRCODE = '42501'; -- insufficient_privilege
  END IF;

  RETURN v_caller;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_credit_read_user_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_credit_read_user_id(uuid)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.resolve_credit_read_user_id(uuid) IS
  'BACKLOG-2094: resolves the authorized target user id for the credit read RPCs. '
  'service_role and internal_roles members may override p_user_id (cross-user '
  'portal reads); everyone else is constrained to auth.uid() and a mismatched '
  'p_user_id is rejected (42501).';

-- ============================================================================
-- get_credit_balance: identical math (2004), now on the resolved id.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_credit_balance(p_user_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := public.resolve_credit_read_user_id(p_user_id);
BEGIN
  RETURN (
    SELECT COALESCE(SUM(amount), 0)::int
    FROM public.credit_ledger
    WHERE user_id = v_uid
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_credit_balance(uuid)
  TO PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_credit_balance(uuid) IS
  'BACKLOG-2004/2094: current credit balance (sum of credit_ledger.amount) for '
  'the resolved user. Non-service/non-internal callers are constrained to '
  'auth.uid() (BACKLOG-2094 hardening); service_role/internal may read cross-user.';

-- ============================================================================
-- get_next_unlock_quote: identical math (2005a + 2086 tier columns), now on the
-- resolved id (the two COALESCE(p_user_id, auth.uid()) uses become v_uid).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_next_unlock_quote(p_user_id uuid DEFAULT NULL)
RETURNS TABLE(
  next_unit_index integer,
  unit_price_cents integer,
  currency text,
  pricing_tier_id uuid,
  current_band_max_units integer,
  units_until_next_band integer,
  next_band_unit_price_cents integer,
  next_band_currency text,
  base_unit_price_cents integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := public.resolve_credit_read_user_id(p_user_id);
BEGIN
  RETURN QUERY
  WITH cnt AS (
    SELECT count(*)::int AS n
    FROM public.transaction_unlocks u
    WHERE u.user_id = v_uid
      AND u.counts_toward_tier                                    -- PAID unlocks only
      AND u.refunded_at IS NULL                                   -- BACKLOG-2005a: exclude refunded
      AND u.unlocked_at >= public.credit_period_start(v_uid)
  ),
  cur AS (
    -- The CURRENT band that prices the next unit (identical selection to 2005a).
    SELECT cnt.n, t.id, t.min_units, t.max_units, t.unit_price_cents, t.currency
    FROM cnt
    JOIN public.credit_pricing_tiers t
      ON t.scope = 'individual'
     AND t.effective_to IS NULL
     AND (cnt.n + 1) >= t.min_units
     AND ((cnt.n + 1) <= t.max_units OR t.max_units IS NULL)
    LIMIT 1
  ),
  nxt AS (
    -- The NEXT (cheaper) band up the ladder: smallest active min_units strictly
    -- greater than the current band's min_units. NULL row when on the top band.
    SELECT n2.unit_price_cents, n2.currency
    FROM cur
    JOIN public.credit_pricing_tiers n2
      ON n2.scope = 'individual'
     AND n2.effective_to IS NULL
     AND n2.min_units > cur.min_units
    ORDER BY n2.min_units ASC
    LIMIT 1
  ),
  base AS (
    -- The HIGHEST/starting price = the active individual band with the smallest
    -- min_units (band 1). Used ONLY to compute the savings % in the best-price
    -- celebration copy; never the current charge. NULL only if the ladder has no
    -- min_units=1 band (misconfigured) -- the UI falls back to a quiet affirmation.
    SELECT b.unit_price_cents
    FROM public.credit_pricing_tiers b
    WHERE b.scope = 'individual'
      AND b.effective_to IS NULL
    ORDER BY b.min_units ASC
    LIMIT 1
  )
  SELECT (cur.n + 1)                                             AS next_unit_index,
         cur.unit_price_cents                                   AS unit_price_cents,
         cur.currency                                           AS currency,
         cur.id                                                 AS pricing_tier_id,
         cur.max_units                                          AS current_band_max_units,
         -- unlocks remaining at the current price (incl. the one being priced).
         -- NULL on the open-ended top band (no next band to descend into).
         CASE WHEN cur.max_units IS NULL THEN NULL
              ELSE (cur.max_units - cur.n) END                  AS units_until_next_band,
         nxt.unit_price_cents                                   AS next_band_unit_price_cents,
         nxt.currency                                           AS next_band_currency,
         base.unit_price_cents                                  AS base_unit_price_cents
  FROM cur
  LEFT JOIN nxt ON true
  LEFT JOIN base ON true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_next_unlock_quote(uuid)
  TO PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_next_unlock_quote(uuid) IS
  'BACKLOG-2086/2094: live PAYG quote for the next unlock + read-only tier-progress '
  'fields for the credit-first paywall. Position math (paid, non-refunded, current '
  'period) unchanged from 2005a; next_* + units_until_next_band are NULL on the '
  'open-ended top band; base_unit_price_cents is the band-1 price. '
  'BACKLOG-2094: non-service/non-internal callers are constrained to auth.uid().';
