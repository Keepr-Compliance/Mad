\set ON_ERROR_STOP off
-- BACKLOG-3519 boundary sweep against the applied migration. Everything runs
-- inside one outer transaction that is rolled back at the end, so this probe
-- leaves no rows behind; each individual probe uses a SAVEPOINT so a rejection
-- doesn't abort the whole session.
--
-- HOW TO READ THE OUTPUT: a probe labelled "-- SHOULD HAVE FAILED" that
-- prints its PASS/FAIL row means the INSERT was wrongly ACCEPTED -- that is
-- the bug signal, investigate the CHECK/FK named in the probe. For that same
-- probe, a Postgres `ERROR: ... violates check constraint ...` (with no
-- PASS/FAIL row following it) means the constraint fired correctly. Probes
-- that should succeed print PASS directly with no preceding error. This
-- inversion (an ERROR in the log is the GOOD outcome for half these probes)
-- is why the sweep isn't scored by exit code -- read the per-probe result.
--
-- Found one real bug this way: the first draft of the split-sum CHECK let
-- (agent_pct=60, brokerage_pct=NULL) through, because `60 + NULL = 100`
-- evaluates to NULL and a CHECK only rejects an expression that is FALSE, not
-- NULL. Probe 10 below is what caught it; the migration's CHECK now spells
-- out `IS NOT NULL` on both columns explicitly rather than relying on the sum
-- alone. See the migration file's own comment on
-- transaction_submissions_split_sum_check.

BEGIN;

CREATE TEMP TABLE t3519_ctx (org uuid, agent uuid, broker uuid, agreement uuid);

DO $$
DECLARE
  v_org uuid;
  v_agent uuid;
  v_broker uuid;
  v_agreement uuid;
  v_has_office_fee boolean;
BEGIN
  INSERT INTO public.organizations (id, name) VALUES (gen_random_uuid(), 'Test Org') RETURNING id INTO v_org;
  INSERT INTO public.users (id, email) VALUES (gen_random_uuid(), 'agent@test.example') RETURNING id INTO v_agent;
  INSERT INTO public.users (id, email) VALUES (gen_random_uuid(), 'broker@test.example') RETURNING id INTO v_broker;
  INSERT INTO auth.users (id) VALUES (v_agent);
  INSERT INTO public.organization_members (organization_id, user_id, role, license_status)
    VALUES (v_org, v_agent, 'agent', 'active');

  -- BACKLOG-3503's own fee-trim PR (#2718, in flight, not yet merged as of
  -- this harness) removes office_fee_amount/office_fee_cadence from
  -- agent_split_agreements. This harness runs whatever 3503 file is CURRENTLY
  -- shipped, so it must not assume either shape -- it asks the catalog rather
  -- than hard-coding a column list, exactly so this probe keeps working
  -- unmodified after that PR merges.
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'agent_split_agreements'
       AND column_name = 'office_fee_amount'
  ) INTO v_has_office_fee;

  IF v_has_office_fee THEN
    INSERT INTO public.agent_split_agreements
      (organization_id, agent_user_id, agent_pct, brokerage_pct, office_fee_amount, office_fee_cadence, effective_from, set_by)
      VALUES (v_org, v_agent, 70.00, 30.00, 0, 'monthly', '2026-01-01', v_broker)
      RETURNING id INTO v_agreement;
  ELSE
    INSERT INTO public.agent_split_agreements
      (organization_id, agent_user_id, agent_pct, brokerage_pct, effective_from, set_by)
      VALUES (v_org, v_agent, 70.00, 30.00, '2026-01-01', v_broker)
      RETURNING id INTO v_agreement;
  END IF;

  INSERT INTO t3519_ctx VALUES (v_org, v_agent, v_broker, v_agreement);
END $$;

SELECT 'ctx' AS label, org, agent, agreement FROM t3519_ctx;

-- 1. Acceptance case: fully populated, legal row -- must succeed.
SAVEPOINT p1;
INSERT INTO public.transaction_submissions
  (organization_id, submitted_by, local_transaction_id, property_address, sale_price,
   commission_offered_rate, commission_actual_rate, commission_gross_amount, commission_adjustment_reason,
   split_agreement_id, split_agent_pct, split_brokerage_pct, split_effective_from, split_resolved_on)
SELECT org, agent, 'txn-accept', '123 Main St', 100000,
       2.500, 2.375, 2375.00, 'negotiated down 0.125 at closing',
       agreement, 70.00, 30.00, '2026-01-01', '2026-03-15'
FROM t3519_ctx;
SELECT 'P1 acceptance case' AS probe, 'PASS' AS result;
RELEASE p1;

-- 2. Nullable snapshot: no split resolved at all -- must succeed (never blocks).
SAVEPOINT p2;
INSERT INTO public.transaction_submissions
  (organization_id, submitted_by, local_transaction_id, property_address)
SELECT org, agent, 'txn-nullable', '124 Main St'
FROM t3519_ctx;
SELECT 'P2 nullable snapshot' AS probe, 'PASS' AS result;
RELEASE p2;

-- 3. Rate boundary: exactly 0 and exactly 100 -- must succeed.
SAVEPOINT p3;
INSERT INTO public.transaction_submissions
  (organization_id, submitted_by, local_transaction_id, property_address, commission_offered_rate, commission_actual_rate)
SELECT org, agent, 'txn-rate-0-100', '125 Main St', 0, 100
FROM t3519_ctx;
SELECT 'P3 rate boundary 0/100' AS probe, 'PASS' AS result;
RELEASE p3;

-- 4. Rate boundary: 100.001 -- must FAIL (over 100).
SAVEPOINT p4;
INSERT INTO public.transaction_submissions
  (organization_id, submitted_by, local_transaction_id, property_address, commission_actual_rate)
SELECT org, agent, 'txn-rate-over', '126 Main St', 100.001
FROM t3519_ctx;
SELECT 'P4 rate over 100 -- SHOULD HAVE FAILED' AS probe, 'FAIL (no error raised)' AS result;
ROLLBACK TO p4;

-- 5. Rate boundary: -0.001 -- must FAIL (under 0).
SAVEPOINT p5;
INSERT INTO public.transaction_submissions
  (organization_id, submitted_by, local_transaction_id, property_address, commission_offered_rate)
SELECT org, agent, 'txn-rate-under', '127 Main St', -0.001
FROM t3519_ctx;
SELECT 'P5 rate under 0 -- SHOULD HAVE FAILED' AS probe, 'FAIL (no error raised)' AS result;
ROLLBACK TO p5;

-- 6. 3-decimal rate (2.375) -- must succeed and round-trip exactly.
SAVEPOINT p6;
INSERT INTO public.transaction_submissions
  (organization_id, submitted_by, local_transaction_id, property_address, commission_actual_rate)
SELECT org, agent, 'txn-rate-3dp', '128 Main St', 2.375
FROM t3519_ctx;
SELECT '2.375 stored as: ' || commission_actual_rate AS probe_p6 FROM public.transaction_submissions WHERE local_transaction_id = 'txn-rate-3dp';
RELEASE p6;

-- 7. Split sum exactly 100 (60/40) -- must succeed.
SAVEPOINT p7;
INSERT INTO public.transaction_submissions
  (organization_id, submitted_by, local_transaction_id, property_address, split_agent_pct, split_brokerage_pct)
SELECT org, agent, 'txn-sum-100', '129 Main St', 60.00, 40.00
FROM t3519_ctx;
SELECT 'P7 split sum 100' AS probe, 'PASS' AS result;
RELEASE p7;

-- 8. Split sum 99.99 -- must FAIL.
SAVEPOINT p8;
INSERT INTO public.transaction_submissions
  (organization_id, submitted_by, local_transaction_id, property_address, split_agent_pct, split_brokerage_pct)
SELECT org, agent, 'txn-sum-9999', '130 Main St', 59.99, 40.00
FROM t3519_ctx;
SELECT 'P8 split sum 99.99 -- SHOULD HAVE FAILED' AS probe, 'FAIL (no error raised)' AS result;
ROLLBACK TO p8;

-- 9. Split sum 100.01 -- must FAIL.
SAVEPOINT p9;
INSERT INTO public.transaction_submissions
  (organization_id, submitted_by, local_transaction_id, property_address, split_agent_pct, split_brokerage_pct)
SELECT org, agent, 'txn-sum-10001', '131 Main St', 60.01, 40.00
FROM t3519_ctx;
SELECT 'P9 split sum 100.01 -- SHOULD HAVE FAILED' AS probe, 'FAIL (no error raised)' AS result;
ROLLBACK TO p9;

-- 10. Asymmetric split: agent set, brokerage NULL -- must FAIL (both-or-neither).
SAVEPOINT p10;
INSERT INTO public.transaction_submissions
  (organization_id, submitted_by, local_transaction_id, property_address, split_agent_pct)
SELECT org, agent, 'txn-asym', '132 Main St', 60.00
FROM t3519_ctx;
SELECT 'P10 asymmetric split -- SHOULD HAVE FAILED' AS probe, 'FAIL (no error raised)' AS result;
ROLLBACK TO p10;

-- 11. Reason at 1 char -- must succeed.
SAVEPOINT p11;
INSERT INTO public.transaction_submissions
  (organization_id, submitted_by, local_transaction_id, property_address, commission_adjustment_reason)
SELECT org, agent, 'txn-reason-1', '133 Main St', 'x'
FROM t3519_ctx;
SELECT 'P11 reason 1 char' AS probe, 'PASS' AS result;
RELEASE p11;

-- 12. Reason at 2000 chars -- must succeed.
SAVEPOINT p12;
INSERT INTO public.transaction_submissions
  (organization_id, submitted_by, local_transaction_id, property_address, commission_adjustment_reason)
SELECT org, agent, 'txn-reason-2000', '134 Main St', repeat('x', 2000)
FROM t3519_ctx;
SELECT 'P12 reason 2000 chars' AS probe, 'PASS' AS result;
RELEASE p12;

-- 13. Reason at 2001 chars -- must FAIL.
SAVEPOINT p13;
INSERT INTO public.transaction_submissions
  (organization_id, submitted_by, local_transaction_id, property_address, commission_adjustment_reason)
SELECT org, agent, 'txn-reason-2001', '135 Main St', repeat('x', 2001)
FROM t3519_ctx;
SELECT 'P13 reason 2001 chars -- SHOULD HAVE FAILED' AS probe, 'FAIL (no error raised)' AS result;
ROLLBACK TO p13;

-- 14. Reason as empty string -- must FAIL (char_length(btrim('')) = 0, below BETWEEN 1).
SAVEPOINT p14;
INSERT INTO public.transaction_submissions
  (organization_id, submitted_by, local_transaction_id, property_address, commission_adjustment_reason)
SELECT org, agent, 'txn-reason-empty', '136 Main St', ''
FROM t3519_ctx;
SELECT 'P14 empty-string reason -- SHOULD HAVE FAILED' AS probe, 'FAIL (no error raised)' AS result;
ROLLBACK TO p14;

-- 15. Negative gross amount -- must FAIL.
SAVEPOINT p15;
INSERT INTO public.transaction_submissions
  (organization_id, submitted_by, local_transaction_id, property_address, commission_gross_amount)
SELECT org, agent, 'txn-neg-gross', '137 Main St', -0.01
FROM t3519_ctx;
SELECT 'P15 negative gross -- SHOULD HAVE FAILED' AS probe, 'FAIL (no error raised)' AS result;
ROLLBACK TO p15;

-- 16. FK: bogus split_agreement_id -- must FAIL.
SAVEPOINT p16;
INSERT INTO public.transaction_submissions
  (organization_id, submitted_by, local_transaction_id, property_address, split_agreement_id)
SELECT org, agent, 'txn-bogus-fk', '138 Main St', gen_random_uuid()
FROM t3519_ctx;
SELECT 'P16 bogus FK -- SHOULD HAVE FAILED' AS probe, 'FAIL (no error raised)' AS result;
ROLLBACK TO p16;

-- 17. FK: real split_agreement_id -- must succeed.
SAVEPOINT p17;
INSERT INTO public.transaction_submissions
  (organization_id, submitted_by, local_transaction_id, property_address, split_agreement_id)
SELECT org, agent, 'txn-real-fk', '139 Main St', agreement
FROM t3519_ctx;
SELECT 'P17 real FK' AS probe, 'PASS' AS result;
RELEASE p17;

-- 18. Index exists on the FK column.
SELECT 'P18 index present: ' || (EXISTS (
  SELECT 1 FROM pg_indexes WHERE tablename = 'transaction_submissions'
    AND indexname = 'idx_transaction_submissions_split_agreement_id'
))::text AS probe_p18;

-- 19. FK delete action, read from the catalog rather than inferred from a
-- refusal -- SR review addendum A4 on BACKLOG-3519 (pm_comments 9d652b50):
-- probes 16-17 only proved a bogus id is rejected and a real one accepted,
-- never that the delete BEHAVIOUR is what the design intends (a compliance
-- snapshot must not silently un-freeze when its source agreement is
-- deleted). 3503's own c20 control is the pattern.
-- confdeltype: 'a' NO ACTION, 'r' RESTRICT, 'c' CASCADE, 'n' SET NULL,
-- 'd' SET DEFAULT.
SELECT 'P19 split_agreement_id FK delete action: ' || confdeltype::text
       || CASE WHEN confdeltype = 'a' THEN ' (NO ACTION, correct)' ELSE ' -- WRONG, expected a' END
       AS probe_p19
FROM pg_constraint
WHERE conname = 'transaction_submissions_split_agreement_fkey' AND contype = 'f';

ROLLBACK;
