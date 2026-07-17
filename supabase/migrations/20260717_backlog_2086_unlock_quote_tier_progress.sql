-- Migration: get_next_unlock_quote tier-progress surfacing (BACKLOG-2086)
--
-- PURPOSE
--   The unlock/paywall UI is being reframed to be CREDIT-FIRST and
--   DISCOUNT-FORWARD (BACKLOG-2086): instead of leading with the raw dollar
--   price it leads with the credit requirement and makes the descending
--   calendar-year PAYG price ladder VISIBLE via a tier-progress incentive bar
--   ("N more unlocks and every deal drops to the next tier").
--
--   To render that bar WITHOUT the renderer re-deriving the ladder, this
--   migration extends get_next_unlock_quote with FOUR additional, NULLABLE,
--   READ-ONLY output columns describing the user's position in the ladder:
--
--     current_band_max_units      -- max_units of the CURRENT band (NULL on the
--                                    open-ended top band -> "best price reached").
--     units_until_next_band       -- (current_band_max_units - paid_count):
--                                    unlocks remaining at the CURRENT price before
--                                    the per-deal cost drops (includes the deal
--                                    being priced now). NULL on the top band.
--     next_band_unit_price_cents  -- the unit price of the NEXT (cheaper) band.
--                                    NULL on the top band.
--     next_band_currency          -- currency of the next band (NULL on top band).
--
-- DESIGN NOTES
--   * PURE DISPLAY SURFACING. The tier POSITION math is IDENTICAL to 2004/2005a:
--     paid (counts_toward_tier), non-refunded unlocks in the current credit
--     period. NO charge / debit / ledger / entitlement logic is changed. The
--     first four output columns (next_unit_index, unit_price_cents, currency,
--     pricing_tier_id) are byte-identical to the 2005a body.
--   * The "next band" is the active individual band whose min_units is the
--     smallest min_units strictly greater than the current band's min_units
--     (i.e. the next rung up the ladder). On the open-ended top band
--     (max_units IS NULL) there is no next band -> the three next_* columns and
--     units_until_next_band resolve NULL.
--   * "units_until_next_band" can be 0 only transiently (a user sitting exactly
--     at a band boundary mid-period is always re-quoted for the NEXT unit, so
--     next_unit_index = n+1 lands in-band and current_band_max_units - n >= 1).
--     The UI treats <= 0 / NULL defensively.
--
-- ROLLBACK (restore the 2005a 4-column body)
--   CREATE OR REPLACE FUNCTION public.get_next_unlock_quote(p_user_id uuid DEFAULT NULL)
--   RETURNS TABLE (next_unit_index integer, unit_price_cents integer, currency text, pricing_tier_id uuid)
--   ... (2005a body) ...

-- ============================================================================
-- get_next_unlock_quote -- ADD tier-progress columns (additive only).
--   Changing a function's RETURNS TABLE shape requires DROP + CREATE (Postgres
--   forbids CREATE OR REPLACE when the OUT-parameter row type changes). The only
--   in-DB caller, finalize_paid_unlock, selects the FIRST FOUR columns by name
--   (next_unit_index, unit_price_cents, currency, pricing_tier_id) which are
--   preserved byte-identically, so the DROP/re-CREATE is transparent to it.
--   Rows 1-4 unchanged from 2005a; rows 5-8 are the new NULLABLE progress fields.
-- ============================================================================
DROP FUNCTION IF EXISTS public.get_next_unlock_quote(uuid);

CREATE FUNCTION public.get_next_unlock_quote(p_user_id uuid DEFAULT NULL)
RETURNS TABLE (
  next_unit_index            integer,
  unit_price_cents           integer,
  currency                   text,
  pricing_tier_id            uuid,
  current_band_max_units     integer,
  units_until_next_band       integer,
  next_band_unit_price_cents integer,
  next_band_currency         text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH cnt AS (
    SELECT count(*)::int AS n
    FROM public.transaction_unlocks u
    WHERE u.user_id = COALESCE(p_user_id, auth.uid())
      AND u.counts_toward_tier                                    -- PAID unlocks only
      AND u.refunded_at IS NULL                                   -- BACKLOG-2005a: exclude refunded
      AND u.unlocked_at >= public.credit_period_start(COALESCE(p_user_id, auth.uid()))
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
         nxt.currency                                           AS next_band_currency
  FROM cur
  LEFT JOIN nxt ON true;
$$;

-- DROP removes existing grants; restore the pre-2086 grant set (was default
-- PUBLIC EXECUTE, which covers anon/authenticated/service_role). Keep it explicit
-- so the surface is auditable and stable regardless of default-privilege config.
GRANT EXECUTE ON FUNCTION public.get_next_unlock_quote(uuid)
  TO PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_next_unlock_quote(uuid) IS
  'BACKLOG-2086: returns the live PAYG quote for the next unlock PLUS read-only '
  'tier-progress fields (current_band_max_units, units_until_next_band, '
  'next_band_unit_price_cents, next_band_currency) so the credit-first paywall UI '
  'can render a descending-ladder incentive bar without re-deriving the ladder. '
  'Position math (paid, non-refunded, current period) is unchanged from 2005a; '
  'the three next_* columns + units_until_next_band are NULL on the open-ended '
  'top band. Pure display surfacing -- no charge/debit/ledger change.';
