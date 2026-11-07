-- BACKLOG-4153 rollback: restores the 3853 body of unlock_transaction (md5(prosrc) c044fab7e359a66ab472d61d69037f87).
-- Pre-check: md5(prosrc) must be be681af740257942945997c0e3113e44 (the 4153 body) or c044fab7e359a66ab472d61d69037f87 (already rolled back: no-op).
-- ACL left as is (CREATE OR REPLACE keeps it); the post-check asserts it is unchanged.
-- Run as one transaction. Also remove the ledger row 20261106120000 by hand if the venue keeps one.
-- Run this before backlog-3853/rollback-3853-m1.sql, which refuses over the 4153 body (BACKLOG-4177).

DO $pre$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.unlock_transaction(text)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('be681af740257942945997c0e3113e44', 'c044fab7e359a66ab472d61d69037f87') THEN
    RAISE EXCEPTION '4153 rollback refused: public.unlock_transaction(text) md5(prosrc) % is neither the 4153 nor the 3853 body', v_md5;
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.unlock_transaction(p_local_transaction_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

  -- BACKLOG-3853: no unlock while the deciding brokerage is suspended.
  IF public.org_billing_suspended(public.billing_deciding_org(v_uid)) THEN
    RAISE EXCEPTION 'account_suspended'
      USING ERRCODE = 'P0001', HINT = 'This brokerage account is suspended. Contact your broker.';
  END IF;

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

  -- CR1: grant net-capacity includes ALL adjustment rows (negatives reduce it), clamped at 0.
  WITH src AS (
    SELECT
      COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'adjustment'), 0) AS adj_sum,
      COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'purchase'), 0)   AS pur_sum
    FROM public.credit_ledger l
    WHERE l.user_id = v_uid
  ),
  drawn AS (
    SELECT
      count(*) FILTER (WHERE f.entry_type = 'adjustment') AS adj_debits,
      count(*) FILTER (WHERE f.entry_type = 'purchase')   AS pur_debits
    FROM public.credit_ledger d
    JOIN public.credit_ledger f ON f.id = d.funded_by
    WHERE d.user_id = v_uid AND d.entry_type = 'debit'
  )
  SELECT GREATEST(src.adj_sum - drawn.adj_debits, 0),
         (src.pur_sum - drawn.pur_debits)
  INTO v_grant_remaining, v_purchase_remaining
  FROM src, drawn;

  IF v_grant_remaining > 0 THEN
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
    RAISE EXCEPTION 'Insufficient credits';
  END IF;

  IF v_funded_by IS NULL THEN
    RAISE EXCEPTION 'Insufficient credits';
  END IF;

  IF v_funding_source = 'purchase' THEN
    SELECT q.unit_price_cents, q.pricing_tier_id INTO v_price_cents, v_tier_id
    FROM public.get_next_unlock_quote(v_uid) q;
  END IF;

  INSERT INTO public.credit_ledger
    (user_id, entry_type, amount, unit_price_cents, pricing_tier_id, funded_by, funding_source, created_by)
  VALUES
    (v_uid, 'debit', -1, v_price_cents, v_tier_id, v_funded_by, v_funding_source, v_uid)
  RETURNING id INTO v_debit_id;

  INSERT INTO public.transaction_unlocks
    (user_id, local_transaction_id, ledger_entry_id, funding_source, counts_toward_tier)
  VALUES
    (v_uid, p_local_transaction_id, v_debit_id, v_funding_source, (v_funding_source = 'purchase'))
  RETURNING id INTO v_unlock_id;

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
$function$;

DO $post$
DECLARE v_md5 text; v_acl text;
BEGIN
  SELECT md5(prosrc), proacl::text INTO v_md5, v_acl FROM pg_proc WHERE oid = to_regprocedure('public.unlock_transaction(text)');
  IF v_md5 IS DISTINCT FROM 'c044fab7e359a66ab472d61d69037f87' THEN
    RAISE EXCEPTION '4153 rollback post-check: md5(prosrc) is %, expected c044fab7e359a66ab472d61d69037f87', v_md5;
  END IF;
  IF v_acl IS DISTINCT FROM '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION '4153 rollback post-check: ACL changed to %', v_acl;
  END IF;
END $post$;
