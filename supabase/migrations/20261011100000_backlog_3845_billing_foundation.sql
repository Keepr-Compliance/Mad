-- BACKLOG-3845 — billing foundation (epic BACKLOG-3648, plan v3 §2.3 + RC7/RC8/RC9, v3.2 D7).
--
-- Additive against the code running in production today:
--   * stripe_mode on stripe_customers / payment_intents is NOT NULL DEFAULT 'live',
--     so inserts from code that does not pass it still succeed (every existing row
--     was traced live). The DEFAULT is dropped at go-live, once production runs
--     code that always passes stripe_mode (go-live runbook item).
--   * the stripe_mode trigger refuses only 'test', which old code never writes.
--   * the three feature resolvers keep their signatures, attributes and grants;
--     only an expired or malformed override paid_through changes the answer, and
--     no live override carries paid_through today.
--
-- Objects:
--   organizations.is_test                     (server-only via the 3843 org guard)
--   stripe_customers.stripe_mode, PK (user_id, stripe_mode), select policy = live rows
--   payment_intents.stripe_mode
--   _override_effective(jsonb)                (paid_through rule, never raises)
--   get_org_features / broker_get_org_features / check_feature_access (rule applied)
--   _guard_stripe_mode_is_test()              (trigger: 'test' rows need an is_test org)
--   billing_subscriptions                     (Agent subscription record)
--   billing_outbox + billing_outbox_claim()   (Stripe side-effect queue, leased claim)
--   grant_unlimited_from_subscription() / revoke_unlimited_from_subscription()
--
-- Harness: supabase/tests/backlog-3845/ (controls + mutants, every run rolled back).
-- Rollback: supabase/tests/backlog-3845/rollback-3845.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Preconditions: the venue has the resolver bodies this file was written
--    against (production md5s, 2026-10-11), or this migration's own bodies
--    (second apply). Anything else is drift -> stop and re-review.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  r record;
BEGIN
  IF current_setting('server_version_num')::int < 160000 THEN
    RAISE EXCEPTION 'BACKLOG-3845: needs PostgreSQL 16+ (pg_input_is_valid); server is %',
      current_setting('server_version');
  END IF;
  FOR r IN
    SELECT v.fn, v.expected, md5(p.prosrc) AS actual, p.prosrc LIKE '%public._override_effective(v_override)%' AS ours
      FROM (VALUES ('public.get_org_features(uuid)',            '51401252aade8541bd69ca60ecfe21e2'),
                   ('public.broker_get_org_features(uuid)',     '8500027bde15be0c0993ea83455a3ca9'),
                   ('public.check_feature_access(uuid,text)',   '84add903044b6c2ac0d6a71248650325')) v(fn, expected)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(v.fn)
  LOOP
    IF r.actual IS NULL THEN
      RAISE EXCEPTION 'BACKLOG-3845: % does not exist', r.fn;
    END IF;
    IF r.actual <> r.expected AND NOT r.ours THEN
      RAISE EXCEPTION 'BACKLOG-3845: % body changed (md5 %, expected %); re-review before applying',
        r.fn, r.actual, r.expected;
    END IF;
  END LOOP;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. organizations.is_test — server-only (the 3843 guard refuses client
--    UPDATEs of any column not on its allow-list; there is no client INSERT
--    policy on organizations).
-- ---------------------------------------------------------------------------
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.organizations.is_test IS
  'BACKLOG-3845: test organization. Stripe test-mode rows may only reference is_test orgs (or users whose personal org is_test); live-mode grants refuse them.';

-- ---------------------------------------------------------------------------
-- 2. stripe_mode on the two existing Stripe tables.
--    DEFAULT 'live' is the expand step (see header); dropped at go-live.
-- ---------------------------------------------------------------------------
ALTER TABLE public.stripe_customers
  ADD COLUMN IF NOT EXISTS stripe_mode text NOT NULL DEFAULT 'live';
ALTER TABLE public.payment_intents
  ADD COLUMN IF NOT EXISTS stripe_mode text NOT NULL DEFAULT 'live';

DO $ck$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.stripe_customers'::regclass
                    AND conname = 'stripe_customers_stripe_mode_ck') THEN
    ALTER TABLE public.stripe_customers
      ADD CONSTRAINT stripe_customers_stripe_mode_ck CHECK (stripe_mode IN ('test', 'live'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payment_intents'::regclass
                    AND conname = 'payment_intents_stripe_mode_ck') THEN
    ALTER TABLE public.payment_intents
      ADD CONSTRAINT payment_intents_stripe_mode_ck CHECK (stripe_mode IN ('test', 'live'));
  END IF;
  -- PK (user_id) -> (user_id, stripe_mode): one customer per user per mode.
  -- Nothing references this PK (no FK, no view; step 0 §2).
  IF (SELECT array_agg(a.attname ORDER BY a.attname)
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.conrelid = 'public.stripe_customers'::regclass AND c.contype = 'p')
     IS DISTINCT FROM ARRAY['stripe_mode', 'user_id']::name[] THEN
    ALTER TABLE public.stripe_customers DROP CONSTRAINT stripe_customers_pkey;
    ALTER TABLE public.stripe_customers ADD CONSTRAINT stripe_customers_pkey PRIMARY KEY (user_id, stripe_mode);
  END IF;
END
$ck$;

-- Installed desktop builds (v2.33.0+) read their own stripe_customers row with
-- maybeSingle(); they only ever see the live row, so a test row cannot turn
-- that read into a multi-row error.
ALTER POLICY stripe_customers_select_own ON public.stripe_customers
  USING ((((SELECT auth.uid()) = user_id) AND stripe_mode = 'live')
         OR public.has_internal_role((SELECT auth.uid())));

-- ---------------------------------------------------------------------------
-- 3. paid_through rule. Never raises (it runs inside RLS via
--    check_feature_access, and the desktop feature gate fails OPEN on error).
--    absent / JSON null      -> true  (not enforced)
--    not a JSON string       -> false (override ignored)
--    not ISO date-time / not a valid timestamptz -> false
--    otherwise               -> paid_through > now()  (expired when <= now())
--    Same rule as the offline pass (parsePaidThrough + pte <= iat).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._override_effective(o jsonb)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_raw jsonb;
  v_s   text;
BEGIN
  v_raw := o -> 'paid_through';
  IF v_raw IS NULL OR jsonb_typeof(v_raw) = 'null' THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(v_raw) <> 'string' THEN
    RETURN false;
  END IF;
  v_s := v_raw #>> '{}';
  IF v_s !~ '^\d{4}-\d{2}-\d{2}T' THEN
    RETURN false;
  END IF;
  IF NOT pg_input_is_valid(v_s, 'timestamptz') THEN
    RETURN false;
  END IF;
  RETURN v_s::timestamptz > now();
END
$fn$;
REVOKE EXECUTE ON FUNCTION public._override_effective(jsonb) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The three resolvers: production bodies, plus one statement after the
--    override read — an override that is not effective is treated as absent
--    and falls through to plan_features (plan-sourced Unlimited is never
--    date-cut). Attributes repeated verbatim; CREATE OR REPLACE keeps grants.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_org_features(p_org_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org_plan RECORD;
  v_has_plan BOOLEAN := false;
  v_result JSONB := '{}';
  v_feature RECORD;
  v_plan_feature RECORD;
  v_override JSONB;
  v_enabled BOOLEAN;
  v_value TEXT;
  v_source TEXT;
  v_blocked BOOLEAN;
BEGIN
  -- Verify caller is a member of the organization
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE user_id = auth.uid() AND organization_id = p_org_id
  ) THEN
    RETURN jsonb_build_object('error', 'not_authorized', 'features', '[]'::jsonb);
  END IF;

  -- Get org's plan
  SELECT op.*, p.name as plan_name, p.tier as plan_tier INTO v_org_plan
  FROM public.organization_plans op
  JOIN public.plans p ON p.id = op.plan_id
  WHERE op.organization_id = p_org_id;

  v_has_plan := FOUND;

  -- Iterate all features
  FOR v_feature IN SELECT * FROM public.feature_definitions ORDER BY sort_order, key
  LOOP
    v_enabled := v_feature.default_value = 'true';
    v_value := v_feature.default_value;
    v_source := 'default';
    v_blocked := false;

    IF v_has_plan THEN
      -- Check per-org override first
      v_override := v_org_plan.feature_overrides -> v_feature.key;
      -- BACKLOG-3845: an expired or malformed paid_through makes the override absent.
      IF v_override IS NOT NULL AND NOT public._override_effective(v_override) THEN
        v_override := NULL;
      END IF;
      v_blocked := v_override IS NOT NULL
                   AND public._override_above_tier(v_feature.key, v_feature.min_tier, v_org_plan.plan_tier, v_override);
      IF v_override IS NOT NULL AND NOT v_blocked THEN
        v_enabled := COALESCE((v_override ->> 'enabled')::boolean, true);
        v_value := COALESCE(v_override ->> 'value', v_feature.default_value);
        v_source := 'override';
      ELSE
        -- Check plan-level feature
        SELECT * INTO v_plan_feature
        FROM public.plan_features pf
        WHERE pf.plan_id = v_org_plan.plan_id
          AND pf.feature_id = v_feature.id;

        IF FOUND THEN
          v_enabled := v_plan_feature.enabled;
          v_value := COALESCE(v_plan_feature.value, v_feature.default_value);
          v_source := 'plan';
        END IF;
      END IF;
    END IF;

    v_result := v_result || jsonb_build_object(
      v_feature.key, jsonb_build_object(
        'enabled', v_enabled,
        'value', v_value,
        'value_type', v_feature.value_type,
        'name', v_feature.name,
        'source', v_source
      ) || CASE WHEN v_blocked THEN '{"override_ignored": true}'::jsonb ELSE '{}'::jsonb END
    );
  END LOOP;

  RETURN jsonb_build_object(
    'org_id', p_org_id,
    'plan_name', COALESCE(v_org_plan.plan_name, 'none'),
    'plan_tier', COALESCE(v_org_plan.plan_tier, 'none'),
    'features', v_result
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.broker_get_org_features(p_org_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org_plan RECORD;
  v_has_plan BOOLEAN := false;
  v_result JSONB := '{}';
  v_feature RECORD;
  v_plan_feature RECORD;
  v_override JSONB;
  v_enabled BOOLEAN;
  v_value TEXT;
  v_source TEXT;
  v_blocked BOOLEAN;
BEGIN
  -- Only require authentication (no org membership check)
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object(
      'org_id', p_org_id,
      'plan_name', 'none',
      'plan_tier', 'none',
      'features', '{}'::jsonb,
      'error', 'not_authenticated'
    );
  END IF;

  -- Get org's plan
  SELECT op.*, p.name as plan_name, p.tier as plan_tier INTO v_org_plan
  FROM public.organization_plans op
  JOIN public.plans p ON p.id = op.plan_id
  WHERE op.organization_id = p_org_id;

  v_has_plan := FOUND;

  -- Iterate all features
  FOR v_feature IN SELECT * FROM public.feature_definitions ORDER BY sort_order, key
  LOOP
    v_enabled := v_feature.default_value = 'true';
    v_value := v_feature.default_value;
    v_source := 'default';
    v_blocked := false;

    IF v_has_plan THEN
      v_override := v_org_plan.feature_overrides -> v_feature.key;
      -- BACKLOG-3845: an expired or malformed paid_through makes the override absent.
      IF v_override IS NOT NULL AND NOT public._override_effective(v_override) THEN
        v_override := NULL;
      END IF;
      v_blocked := v_override IS NOT NULL
                   AND public._override_above_tier(v_feature.key, v_feature.min_tier, v_org_plan.plan_tier, v_override);
      IF v_override IS NOT NULL AND NOT v_blocked THEN
        v_enabled := COALESCE((v_override ->> 'enabled')::boolean, true);
        v_value := COALESCE(v_override ->> 'value', v_feature.default_value);
        v_source := 'override';
      ELSE
        SELECT * INTO v_plan_feature
        FROM public.plan_features pf
        WHERE pf.plan_id = v_org_plan.plan_id
          AND pf.feature_id = v_feature.id;

        IF FOUND THEN
          v_enabled := v_plan_feature.enabled;
          v_value := COALESCE(v_plan_feature.value, v_feature.default_value);
          v_source := 'plan';
        END IF;
      END IF;
    END IF;

    v_result := v_result || jsonb_build_object(
      v_feature.key, jsonb_build_object(
        'enabled', v_enabled,
        'value', v_value,
        'value_type', v_feature.value_type,
        'name', v_feature.name,
        'source', v_source
      ) || CASE WHEN v_blocked THEN '{"override_ignored": true}'::jsonb ELSE '{}'::jsonb END
    );
  END LOOP;

  RETURN jsonb_build_object(
    'org_id', p_org_id,
    'plan_name', COALESCE(v_org_plan.plan_name, 'none'),
    'plan_tier', COALESCE(v_org_plan.plan_tier, 'none'),
    'features', v_result
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_feature_access(p_org_id uuid, p_feature_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_feature RECORD;
  v_plan_feature RECORD;
  v_org_plan RECORD;
  v_override JSONB;
  v_result_enabled BOOLEAN;
  v_result_value TEXT;
  v_blocked BOOLEAN := false;
BEGIN
  -- 0. Verify caller is a member of the organization
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE user_id = auth.uid() AND organization_id = p_org_id
  ) THEN
    RETURN jsonb_build_object('allowed', false, 'error', 'not_authorized');
  END IF;

  -- 1. Get the feature definition
  SELECT * INTO v_feature
  FROM public.feature_definitions
  WHERE key = p_feature_key;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', false, 'error', 'unknown_feature', 'feature_key', p_feature_key);
  END IF;

  -- 2. Get the org's plan
  SELECT op.*, p.tier INTO v_org_plan
  FROM public.organization_plans op
  JOIN public.plans p ON p.id = op.plan_id
  WHERE op.organization_id = p_org_id;

  IF NOT FOUND THEN
    -- No plan assigned: use feature default
    RETURN jsonb_build_object(
      'allowed', v_feature.default_value = 'true',
      'value', v_feature.default_value,
      'source', 'default'
    );
  END IF;

  -- 3. Check for per-org override
  v_override := v_org_plan.feature_overrides -> p_feature_key;
  -- BACKLOG-3845: an expired or malformed paid_through makes the override absent.
  IF v_override IS NOT NULL AND NOT public._override_effective(v_override) THEN
    v_override := NULL;
  END IF;
  v_blocked := v_override IS NOT NULL
               AND public._override_above_tier(p_feature_key, v_feature.min_tier, v_org_plan.tier, v_override);
  IF v_override IS NOT NULL AND NOT v_blocked THEN
    v_result_enabled := COALESCE((v_override ->> 'enabled')::boolean, true);
    v_result_value := COALESCE(v_override ->> 'value', v_feature.default_value);
    RETURN jsonb_build_object(
      'allowed', v_result_enabled,
      'value', v_result_value,
      'source', 'override'
    );
  END IF;

  -- 4. Check plan-level feature
  SELECT * INTO v_plan_feature
  FROM public.plan_features pf
  WHERE pf.plan_id = v_org_plan.plan_id
    AND pf.feature_id = v_feature.id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'allowed', v_plan_feature.enabled,
      'value', COALESCE(v_plan_feature.value, v_feature.default_value),
      'source', 'plan'
    ) || CASE WHEN v_blocked THEN '{"override_ignored": true}'::jsonb ELSE '{}'::jsonb END;
  END IF;

  -- 5. Feature not explicitly in plan: use default
  RETURN jsonb_build_object(
    'allowed', v_feature.default_value = 'true',
    'value', v_feature.default_value,
    'source', 'default'
  ) || CASE WHEN v_blocked THEN '{"override_ignored": true}'::jsonb ELSE '{}'::jsonb END;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Mode separation in the DB (RC8, D7). A stripe_mode='test' row must
--    reference an is_test organization: the row's organization_id when the
--    table has one and it is set, else the user's personal organization.
--    No such organization (NULL is_test) -> refused. 'live' is never refused
--    here (the grant RPC refuses live for is_test users).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._guard_stripe_mode_is_test()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row     jsonb := to_jsonb(NEW);
  v_org_id  uuid;
  v_user_id uuid;
  v_is_test boolean;
BEGIN
  IF NEW.stripe_mode IS DISTINCT FROM 'test' THEN
    RETURN NEW;
  END IF;

  v_org_id  := (v_row ->> 'organization_id')::uuid;
  v_user_id := (v_row ->> 'user_id')::uuid;

  IF v_org_id IS NOT NULL THEN
    SELECT o.is_test INTO v_is_test FROM public.organizations o WHERE o.id = v_org_id;
  ELSIF v_user_id IS NOT NULL THEN
    SELECT o.is_test INTO v_is_test FROM public.organizations o WHERE o.personal_owner_user_id = v_user_id;
  END IF;

  IF v_is_test IS NOT TRUE THEN
    RAISE EXCEPTION 'stripe_mode test requires an is_test organization (%.%)', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE EXECUTE ON FUNCTION public._guard_stripe_mode_is_test() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_stripe_mode_is_test ON public.stripe_customers;
CREATE TRIGGER guard_stripe_mode_is_test
  BEFORE INSERT OR UPDATE OF stripe_mode, user_id ON public.stripe_customers
  FOR EACH ROW EXECUTE FUNCTION public._guard_stripe_mode_is_test();

DROP TRIGGER IF EXISTS guard_stripe_mode_is_test ON public.payment_intents;
CREATE TRIGGER guard_stripe_mode_is_test
  BEFORE INSERT OR UPDATE OF stripe_mode, user_id ON public.payment_intents
  FOR EACH ROW EXECUTE FUNCTION public._guard_stripe_mode_is_test();

-- ---------------------------------------------------------------------------
-- 6. billing_subscriptions — the Agent subscription money record. Written by
--    the service role only (webhook, 3846); a user can read their own rows.
--    price_book_price_id is plain text until the price-book table exists.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_subscriptions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_mode             text NOT NULL CONSTRAINT billing_subscriptions_stripe_mode_ck CHECK (stripe_mode IN ('test', 'live')),
  user_id                 uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id         uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  stripe_customer_id      text NOT NULL,
  stripe_subscription_id  text NOT NULL CONSTRAINT billing_subscriptions_stripe_subscription_id_key UNIQUE,
  status                  text NOT NULL CONSTRAINT billing_subscriptions_status_ck CHECK (status IN
                            ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  "interval"              text CONSTRAINT billing_subscriptions_interval_ck CHECK ("interval" IN ('month', 'year')),
  price_book_price_id     text,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean NOT NULL DEFAULT false,
  canceled_at             timestamptz,
  paused                  boolean NOT NULL DEFAULT false,
  last_event_created      bigint,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- At most one open subscription per user per mode (second-checkout guard, last line).
CREATE UNIQUE INDEX IF NOT EXISTS billing_subscriptions_one_open_per_user_mode
  ON public.billing_subscriptions (user_id, stripe_mode)
  WHERE status IN ('active', 'trialing', 'past_due', 'incomplete');
CREATE INDEX IF NOT EXISTS billing_subscriptions_user_id_idx ON public.billing_subscriptions (user_id);

ALTER TABLE public.billing_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_subscriptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.billing_subscriptions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.billing_subscriptions TO service_role;

DROP POLICY IF EXISTS billing_subscriptions_select_own ON public.billing_subscriptions;
CREATE POLICY billing_subscriptions_select_own ON public.billing_subscriptions
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP TRIGGER IF EXISTS guard_stripe_mode_is_test ON public.billing_subscriptions;
CREATE TRIGGER guard_stripe_mode_is_test
  BEFORE INSERT OR UPDATE OF stripe_mode, user_id, organization_id ON public.billing_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public._guard_stripe_mode_is_test();

-- ---------------------------------------------------------------------------
-- 7. billing_outbox — Stripe side effects to run later (idempotencyKey = id).
--    Service role only: RLS on, no policies, no client grants.
--    claimed_until is a lease: a FOR UPDATE SKIP LOCKED lock ends with the
--    claiming call's transaction, so the claim also stamps the row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_mode      text NOT NULL CONSTRAINT billing_outbox_stripe_mode_ck CHECK (stripe_mode IN ('test', 'live')),
  kind             text NOT NULL,
  user_id          uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id  uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  dedupe_key       text NOT NULL CONSTRAINT billing_outbox_dedupe_key_key UNIQUE,
  run_after        timestamptz NOT NULL DEFAULT now(),
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  claimed_until    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  CONSTRAINT billing_outbox_subject_ck CHECK (user_id IS NOT NULL OR organization_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS billing_outbox_pending_idx
  ON public.billing_outbox (stripe_mode, run_after)
  WHERE processed_at IS NULL;

ALTER TABLE public.billing_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_outbox FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.billing_outbox TO service_role;

DROP TRIGGER IF EXISTS guard_stripe_mode_is_test ON public.billing_outbox;
CREATE TRIGGER guard_stripe_mode_is_test
  BEFORE INSERT OR UPDATE OF stripe_mode, user_id, organization_id ON public.billing_outbox
  FOR EACH ROW EXECUTE FUNCTION public._guard_stripe_mode_is_test();

-- Claim up to p_limit due jobs of one mode. Each claimed row is leased for
-- five minutes and its attempts counter is incremented.
CREATE OR REPLACE FUNCTION public.billing_outbox_claim(p_mode text, p_limit integer)
RETURNS SETOF public.billing_outbox
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('test', 'live') THEN
    RAISE EXCEPTION 'billing_outbox_claim: invalid mode %', p_mode USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'billing_outbox_claim: limit must be 1..100, got %', p_limit USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH due AS (
    SELECT b.id
      FROM public.billing_outbox b
     WHERE b.stripe_mode = p_mode
       AND b.processed_at IS NULL
       AND b.run_after <= now()
       AND (b.claimed_until IS NULL OR b.claimed_until < now())
     ORDER BY b.run_after, b.created_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.billing_outbox o
     SET claimed_until = now() + interval '5 minutes',
         attempts      = o.attempts + 1
    FROM due
   WHERE o.id = due.id
  RETURNING o.*;
END
$fn$;
REVOKE EXECUTE ON FUNCTION public.billing_outbox_claim(text, integer) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Unlimited grant / revoke from an Agent subscription (service role only).
--    Writes the personal organization's unlimited_transactions override:
--      {"enabled": true, "paid_through": <timestamptz as JSON>, "source": "stripe"}
--    Raises (caller bug):  invalid mode, NULL paid_through, no personal org,
--                          no plan row, mode/is_test mismatch (42501).
--    Returns status 'refused' (business rule, caller logs and acknowledges):
--                          licence suspended, non-stripe override present.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.grant_unlimited_from_subscription(
  p_user_id uuid, p_paid_through timestamptz, p_mode text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_org_id   uuid;
  v_is_test  boolean;
  v_existing jsonb;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('test', 'live') THEN
    RAISE EXCEPTION 'grant_unlimited_from_subscription: invalid mode %', p_mode USING ERRCODE = '22023';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'grant_unlimited_from_subscription: user id required' USING ERRCODE = '22004';
  END IF;
  -- A NULL paid_through would be a permanent Unlimited.
  IF p_paid_through IS NULL THEN
    RAISE EXCEPTION 'grant_unlimited_from_subscription: paid_through required' USING ERRCODE = '22004';
  END IF;

  SELECT o.id, o.is_test INTO v_org_id, v_is_test
    FROM public.organizations o
   WHERE o.personal_owner_user_id = p_user_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'grant_unlimited_from_subscription: user has no personal organization' USING ERRCODE = '42501';
  END IF;
  IF p_mode = 'test' AND v_is_test IS NOT TRUE THEN
    RAISE EXCEPTION 'grant_unlimited_from_subscription: test mode requires an is_test personal organization' USING ERRCODE = '42501';
  END IF;
  IF p_mode = 'live' AND v_is_test IS NOT FALSE THEN
    RAISE EXCEPTION 'grant_unlimited_from_subscription: live mode refuses an is_test personal organization' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM public.licenses l WHERE l.user_id = p_user_id AND l.status = 'suspended') THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'licence_suspended', 'organization_id', v_org_id);
  END IF;

  SELECT op.feature_overrides -> 'unlimited_transactions' INTO v_existing
    FROM public.organization_plans op
   WHERE op.organization_id = v_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'grant_unlimited_from_subscription: personal organization has no plan row' USING ERRCODE = 'P0002';
  END IF;
  IF v_existing IS NOT NULL AND (v_existing ->> 'source') IS DISTINCT FROM 'stripe' THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'non_stripe_override', 'organization_id', v_org_id);
  END IF;

  UPDATE public.organization_plans op
     SET feature_overrides = COALESCE(op.feature_overrides, '{}'::jsonb)
           || jsonb_build_object('unlimited_transactions',
                jsonb_build_object('enabled', true,
                                   'paid_through', to_jsonb(p_paid_through),
                                   'source', 'stripe'))
   WHERE op.organization_id = v_org_id;

  RETURN jsonb_build_object('status', 'granted', 'organization_id', v_org_id,
                            'paid_through', to_jsonb(p_paid_through));
END
$fn$;
REVOKE EXECUTE ON FUNCTION public.grant_unlimited_from_subscription(uuid, timestamptz, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.revoke_unlimited_from_subscription(p_user_id uuid, p_mode text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_org_id   uuid;
  v_is_test  boolean;
  v_existing jsonb;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('test', 'live') THEN
    RAISE EXCEPTION 'revoke_unlimited_from_subscription: invalid mode %', p_mode USING ERRCODE = '22023';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'revoke_unlimited_from_subscription: user id required' USING ERRCODE = '22004';
  END IF;

  SELECT o.id, o.is_test INTO v_org_id, v_is_test
    FROM public.organizations o
   WHERE o.personal_owner_user_id = p_user_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'revoke_unlimited_from_subscription: user has no personal organization' USING ERRCODE = '42501';
  END IF;
  IF p_mode = 'test' AND v_is_test IS NOT TRUE THEN
    RAISE EXCEPTION 'revoke_unlimited_from_subscription: test mode requires an is_test personal organization' USING ERRCODE = '42501';
  END IF;
  IF p_mode = 'live' AND v_is_test IS NOT FALSE THEN
    RAISE EXCEPTION 'revoke_unlimited_from_subscription: live mode refuses an is_test personal organization' USING ERRCODE = '42501';
  END IF;

  SELECT op.feature_overrides -> 'unlimited_transactions' INTO v_existing
    FROM public.organization_plans op
   WHERE op.organization_id = v_org_id
   FOR UPDATE;
  IF v_existing IS NULL THEN
    RETURN jsonb_build_object('status', 'noop', 'reason', 'no_override', 'organization_id', v_org_id);
  END IF;
  -- Only a Stripe grant is removed; a support/manual override stays.
  IF (v_existing ->> 'source') IS DISTINCT FROM 'stripe' THEN
    RETURN jsonb_build_object('status', 'noop', 'reason', 'non_stripe_override', 'organization_id', v_org_id);
  END IF;

  UPDATE public.organization_plans op
     SET feature_overrides = op.feature_overrides - 'unlimited_transactions'
   WHERE op.organization_id = v_org_id;

  RETURN jsonb_build_object('status', 'revoked', 'organization_id', v_org_id);
END
$fn$;
REVOKE EXECUTE ON FUNCTION public.revoke_unlimited_from_subscription(uuid, text) FROM PUBLIC, anon, authenticated;

COMMIT;
