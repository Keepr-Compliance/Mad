-- Migration: Prepaid-credit / transaction-unlock ledger foundation (BACKLOG-2004)
--
-- PURPOSE
--   Foundation for the individual-scope "Paid Launch v1" pay-as-you-go (PAYG)
--   monetization model. A user unlocks a transaction (both comms tabs + full
--   export, permanently) by consuming exactly 1 credit. Credits enter the ledger
--   via card purchases (BACKLOG-2005 Stripe) or admin/support grants; they leave
--   via debits (unlocks). Everything is an append-only ledger; balance = SUM.
--
-- SCOPE / DECISIONS (founder, 2026-07-14)
--   1. INDIVIDUAL scope only. No org / brokerage dimension in v1 (extension point
--      documented at the bottom of this file).
--   2. Pricing = annual-volume DESCENDING per-deal tiers, data-driven & effective-
--      dated (changing a price is an INSERT, not a migration):
--        1-3 deals -> $14.99 | 4-10 -> $13.00 | 11-25 -> $12.00 | 26+ -> $11.00
--      Money is stored as INTEGER CENTS everywhere (no floats).
--   3. Period for the volume ladder = CALENDAR YEAR, UTC (reset Jan 1), isolated in
--      one IMMUTABLE function so a future rolling/anniversary policy is a 1-function
--      swap with no schema change.
--   4. Credits ALWAYS spend before card: unlock_transaction() consumes an existing
--      credit only; at zero balance it RAISES 'Insufficient credits' and the
--      desktop routes to BACKLOG-2005's card-charge path.
--   5. Only PAID (purchase-funded) unlocks advance the tier ladder; grant/adjustment-
--      funded unlocks are free and excluded (transaction_unlocks.counts_toward_tier).
--   6. Trial grants NO credits. Sales/support grant free credits via admin ADJUSTMENT
--      entries (the official free-credits lever).
--
-- KEYING (evidence-backed; see BACKLOG-2004 plan)
--   Desktop transactions are identified by a stable CLIENT-GENERATED UUID stored as
--   TEXT (electron/services/db/transactionDbService.ts: crypto.randomUUID(); PK TEXT)
--   and are NOT synced to Supabase as rows -- they are only submitted for broker
--   review into transaction_submissions via local_transaction_id TEXT NOT NULL (no
--   FK). transaction_unlocks therefore keys on (user_id, local_transaction_id TEXT)
--   with NO foreign key, mirroring the existing transaction_submissions precedent.
--
-- SECURITY MODEL
--   All 3 tables: RLS enabled, own-row SELECT (+ internal-role read-all), service_role
--   ALL, and NO direct user INSERT/UPDATE/DELETE. Every write goes through a SECURITY
--   DEFINER RPC (runs as owner, bypasses RLS). Guard matrix:
--     unlock_transaction     -> authenticated user (auth.uid() not null)
--     admin_adjust_credits   -> internal role (has_internal_role(auth.uid()))
--     record_credit_purchase -> service_role OR internal role (BACKLOG-1875 bypass:
--                               auth.uid() is NULL under service_role, so the guard
--                               must check auth.role() = 'service_role' explicitly)
--   Guard style / has_internal_role / log_admin_action / SET search_path all mirror
--   the live house patterns (admin_update_license, licenses_select_public).
--
-- FUTURE COMPOSITION (BACKLOG-2005/2006 -- NOT built here)
--   purchase_and_unlock(local_transaction_id): PAYG one-shot = quote -> +1 purchase
--   (record_credit_purchase) -> -1 debit + unlock (unlock_transaction), all under the
--   SAME per-user advisory lock. Deferred to 2005/2006 (needs the payment leg).
--   Consumers: 2005 prices via get_next_unlock_quote() and records purchases under
--   service_role; 2006 reads is-unlocked / balance / quote and calls unlock_transaction.
--
-- ROLLBACK (clean; append-only, net-new empty tables, nothing references them yet)
--   DROP FUNCTION IF EXISTS public.get_next_unlock_quote(uuid);
--   DROP FUNCTION IF EXISTS public.get_credit_balance(uuid);
--   DROP FUNCTION IF EXISTS public.credit_period_start(uuid);
--   DROP FUNCTION IF EXISTS public.record_credit_purchase(uuid, integer, integer, jsonb);
--   DROP FUNCTION IF EXISTS public.admin_adjust_credits(uuid, integer, text, jsonb);
--   DROP FUNCTION IF EXISTS public.unlock_transaction(text);
--   DROP TABLE IF EXISTS public.transaction_unlocks;
--   DROP TABLE IF EXISTS public.credit_ledger;
--   DROP TABLE IF EXISTS public.credit_pricing_tiers CASCADE;

-- ============================================================================
-- Table 1: credit_pricing_tiers -- data-driven, effective-dated price catalog
-- ============================================================================
CREATE TABLE public.credit_pricing_tiers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  min_units        integer NOT NULL,   -- inclusive lower bound of the annual-volume band
  max_units        integer,            -- inclusive upper bound; NULL = open-ended (26+)
  unit_price_cents integer NOT NULL,   -- money as integer cents (1499,1300,1200,1100)
  currency         text    NOT NULL DEFAULT 'usd',
  effective_from   timestamptz NOT NULL DEFAULT now(),
  effective_to     timestamptz,        -- NULL = currently active; set to now() to retire a set
  scope            text    NOT NULL DEFAULT 'individual',  -- future: 'team' (v1 only 'individual')
  metadata         jsonb   NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES auth.users(id),
  CONSTRAINT credit_pricing_tiers_band_ck  CHECK (max_units IS NULL OR max_units >= min_units),
  CONSTRAINT credit_pricing_tiers_min_ck   CHECK (min_units >= 1),
  CONSTRAINT credit_pricing_tiers_price_ck CHECK (unit_price_cents >= 0)
);

-- Only one active band may start at a given min_units per scope/currency.
CREATE UNIQUE INDEX credit_pricing_tiers_active_band
  ON public.credit_pricing_tiers (scope, currency, min_units)
  WHERE effective_to IS NULL;

COMMENT ON TABLE public.credit_pricing_tiers IS
  'BACKLOG-2004: data-driven, effective-dated per-deal price catalog. Changing a '
  'price or band is an INSERT + retire (effective_to=now()), never a migration. '
  'Write path (RLS default-deny is INTENTIONAL): edited via direct SQL as postgres '
  '(migration/MCP seeding) or service_role (2005/ops tooling). No user/internal-role '
  'write policy in v1; a future admin UI would add a SECURITY DEFINER RPC guarded by '
  'has_internal_role rather than a broad write policy.';

-- ============================================================================
-- Table 2: credit_ledger -- append-only credit movements
-- ============================================================================
CREATE TABLE public.credit_ledger (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entry_type       text NOT NULL,     -- 'purchase' (+N) | 'debit' (-1) | 'adjustment' (+/-N)
  amount           integer NOT NULL,  -- signed
  reason           text,              -- human note (esp. adjustment: 'sales grant', 'refund')
  unit_price_cents integer,           -- captured price at purchase/debit time (NULL for adjustment/grant debit)
  pricing_tier_id  uuid REFERENCES public.credit_pricing_tiers(id),  -- tier that priced this row
  funded_by        uuid REFERENCES public.credit_ledger(id),  -- for a DEBIT: the purchase/adjustment it drew down
  funding_source   text,              -- for a DEBIT: 'purchase' | 'grant' (else NULL)
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- stripe ids, offer/bundle id, webhook_event_id
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,              -- who caused it (auth.uid() / admin / service_role NULL)
  CONSTRAINT credit_ledger_type_ck CHECK (entry_type IN ('purchase','debit','adjustment')),
  -- amount sign must agree with entry_type
  CONSTRAINT credit_ledger_amount_sign_ck CHECK (
       (entry_type = 'purchase'   AND amount > 0)
    OR (entry_type = 'debit'      AND amount < 0)
    OR (entry_type = 'adjustment' AND amount <> 0)
  ),
  CONSTRAINT credit_ledger_funding_source_ck CHECK (
    funding_source IS NULL OR funding_source IN ('purchase','grant')
  )
);

CREATE INDEX credit_ledger_user_created ON public.credit_ledger (user_id, created_at);
CREATE INDEX credit_ledger_user_type    ON public.credit_ledger (user_id, entry_type);

-- C1 (SR 2026-07-14): webhook idempotency as a DB INVARIANT, not deferred to 2005.
-- A double-delivered Stripe event carrying the same webhook_event_id cannot create
-- two purchase rows. 2005's record_credit_purchase relies on the resulting 23505 to
-- no-op a replay. Partial predicate leaves grants/manual/debit rows unconstrained.
CREATE UNIQUE INDEX credit_ledger_webhook_event
  ON public.credit_ledger ((metadata->>'webhook_event_id'))
  WHERE metadata ? 'webhook_event_id';

COMMENT ON TABLE public.credit_ledger IS
  'BACKLOG-2004: append-only credit ledger. balance = SUM(amount) per user. '
  'entry_type purchase(+)/debit(-1)/adjustment(+/-). DEBIT rows carry funded_by + '
  'funding_source for paid-vs-grant attribution WITHOUT timestamp inference. '
  'No org_id in v1 (extension point documented in the migration file).';

-- ============================================================================
-- Table 3: transaction_unlocks -- durable, idempotent unlock entitlement
-- ============================================================================
CREATE TABLE public.transaction_unlocks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  local_transaction_id text NOT NULL,  -- desktop client-generated UUID (TEXT). NO FK (not synced).
  ledger_entry_id      uuid REFERENCES public.credit_ledger(id),  -- the DEBIT that paid for this unlock
  funding_source       text NOT NULL,  -- 'purchase' (paid) | 'grant' (free)
  counts_toward_tier   boolean NOT NULL DEFAULT false,  -- = (funding_source='purchase'); paid-only counter
  unlocked_at          timestamptz NOT NULL DEFAULT now(),
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT transaction_unlocks_funding_source_ck CHECK (funding_source IN ('purchase','grant')),
  -- Idempotency lives at the DB level (NOT app logic): 1 unlock per (user, tx).
  CONSTRAINT transaction_unlocks_user_tx_uq UNIQUE (user_id, local_transaction_id)
);

CREATE INDEX transaction_unlocks_user ON public.transaction_unlocks (user_id);
-- Paid-only tier counter is index-backed.
CREATE INDEX transaction_unlocks_paid_counter
  ON public.transaction_unlocks (user_id, unlocked_at) WHERE counts_toward_tier;

COMMENT ON TABLE public.transaction_unlocks IS
  'BACKLOG-2004: durable per-(user, local_transaction_id) unlock entitlement '
  '(both comms tabs + full export, permanent). UNIQUE(user_id, local_transaction_id) '
  '= idempotency. counts_toward_tier (=paid) drives the annual volume ladder; '
  'grant-funded unlocks are free and excluded.';

-- ============================================================================
-- RLS -- enable + policies (own-row SELECT, service_role ALL, no user writes)
-- ============================================================================
ALTER TABLE public.credit_pricing_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_ledger        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_unlocks  ENABLE ROW LEVEL SECURITY;

-- credit_pricing_tiers: price list is not secret -> readable by all; writes service_role only.
CREATE POLICY credit_pricing_tiers_select_all ON public.credit_pricing_tiers
  FOR SELECT TO public USING (true);
-- C2: service_role ALL for 2005/ops seeding/retiring tiers (consistency with other tables).
CREATE POLICY credit_pricing_tiers_service_role_all ON public.credit_pricing_tiers
  FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- credit_ledger: own-row read (+ internal-role read-all); writes via RPC / service_role.
CREATE POLICY credit_ledger_select_own ON public.credit_ledger
  FOR SELECT TO public
  USING ((( SELECT auth.uid()) = user_id) OR public.has_internal_role(( SELECT auth.uid())));
CREATE POLICY credit_ledger_service_role_all ON public.credit_ledger
  FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- transaction_unlocks: own-row read (+ internal-role read-all); writes via RPC / service_role.
CREATE POLICY transaction_unlocks_select_own ON public.transaction_unlocks
  FOR SELECT TO public
  USING ((( SELECT auth.uid()) = user_id) OR public.has_internal_role(( SELECT auth.uid())));
CREATE POLICY transaction_unlocks_service_role_all ON public.transaction_unlocks
  FOR ALL TO public
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================================
-- Seed the individual pricing ladder (cents). Retire+reinsert to change prices.
-- ============================================================================
INSERT INTO public.credit_pricing_tiers (min_units, max_units, unit_price_cents, currency, scope)
VALUES
  (1,  3,    1499, 'usd', 'individual'),
  (4,  10,   1300, 'usd', 'individual'),
  (11, 25,   1200, 'usd', 'individual'),
  (26, NULL, 1100, 'usd', 'individual');

-- ============================================================================
-- Period boundary -- CALENDAR YEAR, UTC. Isolated so a future policy is 1 edit.
-- p_user_id kept in the signature only for a future per-user anchor (v1 ignores it).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.credit_period_start(p_user_id uuid DEFAULT NULL)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT date_trunc('year', (now() AT TIME ZONE 'UTC'))::timestamptz;
$$;

-- ============================================================================
-- Balance -- cheap indexed read. Defaults to the caller for the desktop app.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_credit_balance(p_user_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(SUM(amount), 0)::int
  FROM public.credit_ledger
  WHERE user_id = COALESCE(p_user_id, auth.uid());
$$;

-- ============================================================================
-- Price quote for the caller's NEXT PAID unlock (drives 2005 checkout + 2006 paywall).
-- Counts only PAID unlocks (counts_toward_tier) in the current calendar year.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_next_unlock_quote(p_user_id uuid DEFAULT NULL)
RETURNS TABLE (next_unit_index integer, unit_price_cents integer, currency text, pricing_tier_id uuid)
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
      AND u.unlocked_at >= public.credit_period_start(COALESCE(p_user_id, auth.uid()))
  )
  SELECT (cnt.n + 1),
         t.unit_price_cents,
         t.currency,
         t.id
  FROM cnt
  JOIN public.credit_pricing_tiers t
    ON t.scope = 'individual'
   AND t.effective_to IS NULL
   AND (cnt.n + 1) >= t.min_units
   AND ((cnt.n + 1) <= t.max_units OR t.max_units IS NULL)
  LIMIT 1;
$$;

-- ============================================================================
-- RPC A: unlock_transaction -- authenticated user consumes ONE existing credit.
--   Credits-before-card: never charges; RAISES at zero balance (2005 card signal).
--   B1 (SR 2026-07-14): pg_advisory_xact_lock serializes a user's concurrent unlocks
--   (READ COMMITTED would otherwise allow double-spend across DIFFERENT tx ids). The
--   lock also covers the grants-first funding-selection read-then-write.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.unlock_transaction(p_local_transaction_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid            uuid := auth.uid();
  v_existing       public.transaction_unlocks;
  v_unlock_id      uuid;
  v_grant_remaining   integer;
  v_purchase_remaining integer;
  v_funded_by      uuid;
  v_funding_source text;
  v_debit_id       uuid;
  v_price_cents    integer;
  v_tier_id        uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- B1: serialize this user's unlock/funding operations for the whole txn.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

  -- Idempotency: already unlocked -> return existing, no debit.
  SELECT * INTO v_existing
  FROM public.transaction_unlocks
  WHERE user_id = v_uid AND local_transaction_id = p_local_transaction_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'unlocked', false,
      'already', true,
      'ledger_entry_id', v_existing.ledger_entry_id,
      'funding_source', v_existing.funding_source,
      'counts_toward_tier', v_existing.counts_toward_tier,
      'balance_after', public.get_credit_balance(v_uid)
    );
  END IF;

  -- Funding selection (explicit, under the advisory lock; grants-first policy).
  -- Remaining per source = SUM(+ entries of that source) - COUNT(debits funded_by that source).
  -- Grant/adjustment credits are spent FIRST (free, do not count toward the paid ladder).
  SELECT COALESCE((
    SELECT SUM(l.amount) FROM public.credit_ledger l
    WHERE l.user_id = v_uid AND l.entry_type = 'adjustment' AND l.amount > 0
  ), 0) - COALESCE((
    SELECT count(*) FROM public.credit_ledger d
    JOIN public.credit_ledger f ON f.id = d.funded_by
    WHERE d.user_id = v_uid AND d.entry_type = 'debit' AND f.entry_type = 'adjustment'
  ), 0)
  INTO v_grant_remaining;

  SELECT COALESCE((
    SELECT SUM(l.amount) FROM public.credit_ledger l
    WHERE l.user_id = v_uid AND l.entry_type = 'purchase'
  ), 0) - COALESCE((
    SELECT count(*) FROM public.credit_ledger d
    JOIN public.credit_ledger f ON f.id = d.funded_by
    WHERE d.user_id = v_uid AND d.entry_type = 'debit' AND f.entry_type = 'purchase'
  ), 0)
  INTO v_purchase_remaining;

  IF v_grant_remaining > 0 THEN
    -- Draw down the oldest grant/adjustment entry that still has capacity.
    SELECT l.id INTO v_funded_by
    FROM public.credit_ledger l
    WHERE l.user_id = v_uid AND l.entry_type = 'adjustment' AND l.amount > 0
      AND l.amount > (
        SELECT count(*) FROM public.credit_ledger d
        WHERE d.user_id = v_uid AND d.entry_type = 'debit' AND d.funded_by = l.id
      )
    ORDER BY l.created_at ASC
    LIMIT 1;
    v_funding_source := 'grant';
  ELSIF v_purchase_remaining > 0 THEN
    SELECT l.id INTO v_funded_by
    FROM public.credit_ledger l
    WHERE l.user_id = v_uid AND l.entry_type = 'purchase'
      AND l.amount > (
        SELECT count(*) FROM public.credit_ledger d
        WHERE d.user_id = v_uid AND d.entry_type = 'debit' AND d.funded_by = l.id
      )
    ORDER BY l.created_at ASC
    LIMIT 1;
    v_funding_source := 'purchase';
  ELSE
    -- No credit available -> credits-before-card RAISE (2005 card-route signal).
    RAISE EXCEPTION 'Insufficient credits';
  END IF;

  -- For a paid debit, capture the price the ladder would charge for this unit.
  IF v_funding_source = 'purchase' THEN
    SELECT q.unit_price_cents, q.pricing_tier_id INTO v_price_cents, v_tier_id
    FROM public.get_next_unlock_quote(v_uid) q;
  END IF;

  -- Insert the debit row (amount -1) linked to the funding entry.
  INSERT INTO public.credit_ledger
    (user_id, entry_type, amount, unit_price_cents, pricing_tier_id, funded_by, funding_source, created_by)
  VALUES
    (v_uid, 'debit', -1, v_price_cents, v_tier_id, v_funded_by, v_funding_source, v_uid)
  RETURNING id INTO v_debit_id;

  -- Insert the durable unlock entitlement.
  INSERT INTO public.transaction_unlocks
    (user_id, local_transaction_id, ledger_entry_id, funding_source, counts_toward_tier)
  VALUES
    (v_uid, p_local_transaction_id, v_debit_id, v_funding_source, (v_funding_source = 'purchase'))
  RETURNING id INTO v_unlock_id;

  -- Backstop only (advisory lock is the primary guard): balance can never go < 0.
  IF public.get_credit_balance(v_uid) < 0 THEN
    RAISE EXCEPTION 'Insufficient credits';
  END IF;

  RETURN jsonb_build_object(
    'unlocked', true,
    'already', false,
    'ledger_entry_id', v_debit_id,
    'funding_source', v_funding_source,
    'counts_toward_tier', (v_funding_source = 'purchase'),
    'balance_after', public.get_credit_balance(v_uid)
  );
END;
$$;

-- ============================================================================
-- RPC B: admin_adjust_credits -- internal-role only (sales/support free-credit lever).
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

-- ============================================================================
-- RPC C: record_credit_purchase -- service_role (2005 Stripe webhook) OR internal role.
--   BACKLOG-1875 bypass: auth.uid() is NULL under service_role, so the guard must
--   check auth.role() explicitly. Webhook idempotency is enforced by the
--   credit_ledger_webhook_event unique index (23505 on replay).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.record_credit_purchase(
  p_user_id         uuid,
  p_units           integer,
  p_unit_price_cents integer,
  p_metadata        jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ledger_id uuid;
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.has_internal_role(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  IF p_units <= 0 THEN
    RAISE EXCEPTION 'Purchase units must be positive';
  END IF;

  INSERT INTO public.credit_ledger
    (user_id, entry_type, amount, unit_price_cents, metadata, created_by)
  VALUES
    (p_user_id, 'purchase', p_units, p_unit_price_cents, COALESCE(p_metadata, '{}'::jsonb), auth.uid())
  RETURNING id INTO v_ledger_id;

  RETURN jsonb_build_object(
    'ledger_entry_id', v_ledger_id,
    'balance_after', public.get_credit_balance(p_user_id)
  );
END;
$$;

-- ============================================================================
-- FUTURE team/org extension point (do NOT build now)
--   credit_ledger / transaction_unlocks are keyed by user_id only. A future shared
--   org bank / per-user monthly grant adds a nullable owner_scope discriminator +
--   nullable organization_id (balance sums over the owning scope); credit_pricing_tiers.
--   scope already anticipates 'team'. Append-only + signed amounts + a scope column
--   added later is non-breaking. Monthly-resetting grants = periodic adjustment/purchase
--   rows with an expiry in metadata; period logic already lives in credit_period_start.
-- ============================================================================
