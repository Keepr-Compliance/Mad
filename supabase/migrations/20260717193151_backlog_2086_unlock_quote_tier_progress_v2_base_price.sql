-- Migration: get_next_unlock_quote v2 -- add base_unit_price_cents (BACKLOG-2086 v2)
--
-- BACKLOG-2128 -- RECONSTRUCTED 2026-07-19.
--   This file was RECONSTRUCTED after the fact. The migration it represents was
--   originally applied directly to production on 2026-07-17 via the Supabase MCP
--   `apply_migration` tool WITHOUT a committed file, so its ledger entry
--   (schema_migrations version 20260717193151, name
--   backlog_2086_unlock_quote_tier_progress_v2_base_price) existed in prod but the
--   .sql file was absent from EVERY git branch (schema drift -- see BACKLOG-2128).
--
--   This reconstruction exists ONLY so the committed migration file set matches
--   prod's applied schema_migrations ledger. It is a FAITHFUL rebuild of the v2
--   function body (the same tier-progress quote math, INCLUDING the
--   base_unit_price_cents column) with the PRE-2094 auth semantics that were live
--   at the time it was applied: a plain LANGUAGE sql function resolving the target
--   with COALESCE(p_user_id, auth.uid()) -- NO resolve_credit_read_user_id resolver
--   and NO 42501 privilege guards (those arrive later in 2094).
--
--   SUPERSEDED by 20260717_backlog_2094_harden_credit_read_rpcs.sql, which
--   DROP/re-CREATEs get_next_unlock_quote with the identical RETURNS TABLE shape
--   (incl. base_unit_price_cents) as a plpgsql wrapper that routes through the
--   resolve_credit_read_user_id() resolver. Because 2094 runs AFTER this file in
--   filename order, a fresh-environment rebuild from git applies this v2 body and
--   then 2094 replaces it -- the final function on any fresh env is byte-identical
--   to prod. Safe to apply on fresh envs.
--
-- WHAT v2 ADDS OVER v1 (20260717175729 backlog_2086_unlock_quote_tier_progress)
--   The `base AS (...)` CTE and the `base_unit_price_cents` output column: the
--   HIGHEST/starting band price (the active individual band with the smallest
--   min_units, i.e. band 1 / $14.99). Drives the best-price "saving X%" celebration
--   copy in the credit-first paywall. NULL only if the ladder is misconfigured
--   (no min_units=1 band). Everything else (position math, the four next_*/
--   units_until_next_band progress columns) is unchanged from v1.
--
-- DESIGN NOTES (unchanged from v1)
--   * PURE DISPLAY SURFACING. Tier POSITION math is identical to 2005a: paid
--     (counts_toward_tier), non-refunded unlocks in the current credit period. NO
--     charge / debit / ledger / entitlement logic is changed. The first four output
--     columns (next_unit_index, unit_price_cents, currency, pricing_tier_id) are
--     byte-identical to the 2005a body.
--   * The "next band" is the active individual band whose min_units is the smallest
--     min_units strictly greater than the current band's min_units. On the
--     open-ended top band (max_units IS NULL) there is no next band -> the three
--     next_* columns and units_until_next_band resolve NULL.

-- ============================================================================
-- get_next_unlock_quote -- ADD base_unit_price_cents (additive column).
--   Changing a function's RETURNS TABLE shape requires DROP + CREATE (Postgres
--   forbids CREATE OR REPLACE when the OUT-parameter row type changes). The only
--   in-DB caller, finalize_paid_unlock, selects the FIRST FOUR columns by name
--   (next_unit_index, unit_price_cents, currency, pricing_tier_id) which are
--   preserved byte-identically, so the DROP/re-CREATE is transparent to it.
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
  next_band_currency         text,
  base_unit_price_cents      integer
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
$$;

-- DROP removes existing grants; restore the pre-2086 grant set (was default
-- PUBLIC EXECUTE, which covers anon/authenticated/service_role). Keep it explicit
-- so the surface is auditable and stable regardless of default-privilege config.
GRANT EXECUTE ON FUNCTION public.get_next_unlock_quote(uuid)
  TO PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_next_unlock_quote(uuid) IS
  'BACKLOG-2086 (v2): returns the live PAYG quote for the next unlock PLUS read-only '
  'tier-progress fields (current_band_max_units, units_until_next_band, '
  'next_band_unit_price_cents, next_band_currency, base_unit_price_cents) so the '
  'credit-first paywall UI can render a descending-ladder incentive bar and a '
  'best-price savings-% celebration without re-deriving the ladder. '
  'Position math (paid, non-refunded, current period) is unchanged from 2005a; '
  'the three next_* columns + units_until_next_band are NULL on the open-ended '
  'top band; base_unit_price_cents is the band-1 (highest) price for the savings '
  'calc. Pure display surfacing -- no charge/debit/ledger change. '
  'NOTE: superseded by BACKLOG-2094 (adds cross-user-read hardening via '
  'resolve_credit_read_user_id); this v2 body is the pre-2094 permissive form.';
