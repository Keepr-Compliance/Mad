-- BACKLOG-3519 section 5 (commission lock) probes.
--
-- Runs AFTER the migration, INSIDE the caller's transaction, which the caller
-- rolls back (run-venue.sh does BEGIN ... ROLLBACK). Needs a Supabase-shaped
-- database: auth.role()/auth.uid(), the anon/authenticated/service_role roles,
-- public.users, organizations, organization_members, and the RLS policies on
-- transaction_submissions. The Docker stub in this directory has none of
-- those, so these probes do not run there.
--
-- Every probe records one of:
--   42501      the statement was refused by the lock
--   ok rows=N  the statement ran and touched N rows
--   <SQLSTATE> any other error
-- "ok rows=0" means RLS filtered the row and the trigger never fired. It is
-- NOT a refusal; a probe that claims to exercise the lock expects 42501 or
-- ok rows=1, never rows=0.
--
-- Output: one PASS/FAIL line per probe, then a summary. The final DO block
-- raises when any probe failed or when fewer probes ran than are listed, so
-- the psql exit code carries the verdict.

\set ON_ERROR_STOP 1

-- ---------------------------------------------------------------------------
-- Seed (ids generated per run; all rolled back with the caller's transaction)
-- ---------------------------------------------------------------------------
SELECT gen_random_uuid() AS agent_id, gen_random_uuid() AS broker_id, gen_random_uuid() AS org_id,
       gen_random_uuid() AS s1, gen_random_uuid() AS s2 \gset
SELECT json_build_object('role', 'authenticated', 'sub', :'agent_id')::text  AS agent,
       json_build_object('role', 'authenticated', 'sub', :'broker_id')::text AS broker \gset
INSERT INTO auth.users (id) VALUES (:'agent_id'), (:'broker_id');
INSERT INTO public.users (id, email, oauth_provider, oauth_id) VALUES
  (:'agent_id', 'agent-3519@example.invalid',  'email', 'agent-3519'),
  (:'broker_id', 'broker-3519@example.invalid', 'email', 'broker-3519');
INSERT INTO public.organizations (id, name, slug) VALUES
  (:'org_id', 'Lock Probe Org 3519', 'lock-probe-org-3519');
INSERT INTO public.organization_members (organization_id, user_id, role, license_status) VALUES
  (:'org_id', :'agent_id', 'agent',  'active'),
  (:'org_id', :'broker_id', 'broker', 'active');

-- S1: submitted. S2: still uploading (the row the finalize updates).
INSERT INTO public.transaction_submissions
  (id, organization_id, submitted_by, local_transaction_id, property_address, transaction_type, status,
   sale_price, commission_offered_rate, commission_actual_rate, commission_gross_amount, commission_adjustment_reason)
VALUES
  (:'s1', :'org_id', :'agent_id',
   'lock-probe-s1', '1 Probe St', 'sale', 'submitted', 100000, 3.000, 2.500, 2500.00, 'reduced at close'),
  (:'s2', :'org_id', :'agent_id',
   'lock-probe-s2', '2 Probe St', 'sale', 'uploading', 200000, 3.000, 3.000, 6000.00, NULL);

-- ---------------------------------------------------------------------------
-- Probe helper
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE lock_probe_results (seq serial, name text, expect text, got text) ON COMMIT DROP;

CREATE FUNCTION pg_temp.run_as(p_role text, p_claims jsonb, p_sql text)
RETURNS text LANGUAGE plpgsql AS $fn$
DECLARE
  n integer;
  v_state text;
  v_msg text;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims', COALESCE(p_claims::text, ''), true);
    PERFORM set_config('request.jwt.claim.role', '', true);
    IF p_role IS NOT NULL THEN
      PERFORM set_config('role', p_role, true);
    END IF;
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM set_config('role', 'none', true);
    PERFORM set_config('request.jwt.claims', '', true);
    RETURN 'ok rows=' || n;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    RAISE NOTICE '  % -> % %', left(p_sql, 60), v_state, v_msg;
    RETURN v_state;
  END;
END
$fn$;

CREATE FUNCTION pg_temp.probe(p_name text, p_role text, p_claims jsonb, p_sql text, p_expect text)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO lock_probe_results (name, expect, got)
  VALUES (p_name, p_expect, pg_temp.run_as(p_role, p_claims, p_sql));
END
$fn$;

-- A client UPDATE laundered through a SECURITY DEFINER function owned by the
-- migration role. Inside it current_user is the owner; auth.role() is still
-- the caller's claim. It reports both so the record shows the state a
-- current_user-keyed lock gets wrong.
CREATE FUNCTION public.lock_probe_3519_definer_update(p_id uuid, p_rate numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  RAISE NOTICE '  inside DEFINER: current_user=%, auth.role()=%', current_user, auth.role();
  UPDATE public.transaction_submissions SET commission_actual_rate = p_rate WHERE id = p_id;
END
$fn$;
GRANT EXECUTE ON FUNCTION public.lock_probe_3519_definer_update(uuid, numeric) TO authenticated, anon;

\set svc    '{"role":"service_role"}'
\set anonc  '{"role":"anon"}'

-- ---------------------------------------------------------------------------
-- B. Binding: the function exists AND a trigger binds it, with the right shape
-- ---------------------------------------------------------------------------
INSERT INTO lock_probe_results (name, expect, got)
SELECT 'B1 trigger bound: BEFORE UPDATE OF the four figures, enabled',
       'true',
       (count(*) = 1)::text
  FROM pg_trigger t
 WHERE t.tgrelid = 'public.transaction_submissions'::regclass
   AND t.tgname = 'commission_figures_locked'
   AND t.tgfoid = 'public.guard_commission_figures_locked()'::regprocedure
   AND t.tgenabled = 'O'
   AND pg_get_triggerdef(t.oid) LIKE
       'CREATE TRIGGER commission_figures_locked BEFORE UPDATE OF commission_offered_rate, commission_actual_rate, commission_gross_amount, commission_adjustment_reason ON public.transaction_submissions FOR EACH ROW EXECUTE FUNCTION %guard_commission_figures_locked()';

INSERT INTO lock_probe_results (name, expect, got)
SELECT 'B2 no trigger on the table lists closed_at', 'false',
       bool_or(pg_get_triggerdef(t.oid) LIKE '%closed_at%')::text
  FROM pg_trigger t
 WHERE t.tgrelid = 'public.transaction_submissions'::regclass AND NOT t.tgisinternal;

INSERT INTO lock_probe_results (name, expect, got)
SELECT 'B3 function is SECURITY INVOKER with search_path pinned', 'true',
       (NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=""'])::text
  FROM pg_proc p
 WHERE p.oid = 'public.guard_commission_figures_locked()'::regprocedure;

-- ---------------------------------------------------------------------------
-- R. Realistic: RLS on, the table's real policies
-- ---------------------------------------------------------------------------
SELECT pg_temp.probe('R01 agent (authenticated) changes a figure on own uploading row', 'authenticated', :'agent',
  $$UPDATE public.transaction_submissions SET commission_actual_rate = 1.001 WHERE id = '$$ || :'s2' || $$'$$, '42501');
SELECT pg_temp.probe('R02 broker changes commission_offered_rate on a submitted row', 'authenticated', :'broker',
  $$UPDATE public.transaction_submissions SET commission_offered_rate = 1.002 WHERE id = '$$ || :'s1' || $$'$$, '42501');
SELECT pg_temp.probe('R03 broker changes commission_actual_rate on a submitted row', 'authenticated', :'broker',
  $$UPDATE public.transaction_submissions SET commission_actual_rate = 1.003 WHERE id = '$$ || :'s1' || $$'$$, '42501');
SELECT pg_temp.probe('R04 broker changes commission_gross_amount on a submitted row', 'authenticated', :'broker',
  $$UPDATE public.transaction_submissions SET commission_gross_amount = 1.04 WHERE id = '$$ || :'s1' || $$'$$, '42501');
SELECT pg_temp.probe('R05 broker changes commission_adjustment_reason on a submitted row', 'authenticated', :'broker',
  $$UPDATE public.transaction_submissions SET commission_adjustment_reason = 'edited R05' WHERE id = '$$ || :'s1' || $$'$$, '42501');
SELECT pg_temp.probe('R06 broker clears a figure (value -> NULL) on a submitted row', 'authenticated', :'broker',
  $$UPDATE public.transaction_submissions SET commission_adjustment_reason = NULL WHERE id = '$$ || :'s1' || $$'$$, '42501');
SELECT pg_temp.probe('R07 agent via SECURITY DEFINER function (current_user = owner)', 'authenticated', :'agent',
  $$SELECT public.lock_probe_3519_definer_update('$$ || :'s1' || $$', 1.007)$$, '42501');
SELECT pg_temp.probe('R08 anon via SECURITY DEFINER function', 'anon', :'anonc',
  $$SELECT public.lock_probe_3519_definer_update('$$ || :'s1' || $$', 1.008)$$, '42501');
SELECT pg_temp.probe('R09 broker re-sends the stored value (no change)', 'authenticated', :'broker',
  $$UPDATE public.transaction_submissions SET commission_actual_rate = commission_actual_rate WHERE id = '$$ || :'s1' || $$'$$, 'ok rows=1');
SELECT pg_temp.probe('R10 broker edits closed_at (not locked)', 'authenticated', :'broker',
  $$UPDATE public.transaction_submissions SET closed_at = '2026-09-01T00:00:00Z' WHERE id = '$$ || :'s1' || $$'$$, 'ok rows=1');
SELECT pg_temp.probe('R11 broker sets status (unrelated column)', 'authenticated', :'broker',
  $$UPDATE public.transaction_submissions SET status = 'under_review' WHERE id = '$$ || :'s1' || $$'$$, 'ok rows=1');
SELECT pg_temp.probe('R12 agent finalize: .update({ status }) on own uploading row with figures', 'authenticated', :'agent',
  $$UPDATE public.transaction_submissions SET status = 'submitted' WHERE id = '$$ || :'s2' || $$'$$, 'ok rows=1');
SELECT pg_temp.probe('R13 agent INSERT with all four figures', 'authenticated', :'agent',
  $$INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address,
      transaction_type, status, sale_price, commission_offered_rate, commission_actual_rate, commission_gross_amount,
      commission_adjustment_reason)
    VALUES ('$$ || :'org_id' || $$', '$$ || :'agent_id' || $$', 'lock-probe-s3',
      '3 Probe St', 'sale', 'uploading', 300000, 3.000, 2.375, 7125.00, 'agreed reduction')$$, 'ok rows=1');
SELECT pg_temp.probe('R14 service_role changes a figure', 'service_role', :'svc',
  $$UPDATE public.transaction_submissions SET commission_actual_rate = 2.000 WHERE id = '$$ || :'s1' || $$'$$, 'ok rows=1');
SELECT pg_temp.probe('R15 migration role, no claims, changes a figure', NULL, NULL,
  $$UPDATE public.transaction_submissions SET commission_gross_amount = 2000.00 WHERE id = '$$ || :'s1' || $$'$$, 'ok rows=1');

-- Observed values, not just row counts.
INSERT INTO lock_probe_results (name, expect, got)
SELECT 'V1 S1 figures after R02-R15: offered 3.000, actual 2.000 (R14), gross 2000.00 (R15), reason intact',
       '3.000|2.000|2000.00|reduced at close',
       concat_ws('|', commission_offered_rate, commission_actual_rate, commission_gross_amount, commission_adjustment_reason)
  FROM public.transaction_submissions WHERE id = :'s1';
INSERT INTO lock_probe_results (name, expect, got)
SELECT 'V2 S2 after finalize: status submitted, figures unchanged', 'submitted|3.000|3.000|6000.00',
       concat_ws('|', status, commission_offered_rate, commission_actual_rate, commission_gross_amount)
  FROM public.transaction_submissions WHERE id = :'s2';
INSERT INTO lock_probe_results (name, expect, got)
SELECT 'V3 inserted row carries its figures', '3.000|2.375|7125.00|agreed reduction',
       concat_ws('|', commission_offered_rate, commission_actual_rate, commission_gross_amount, commission_adjustment_reason)
  FROM public.transaction_submissions WHERE local_transaction_id = 'lock-probe-s3';

-- ---------------------------------------------------------------------------
-- I. Role matrix with RLS disabled (rolled back), so every probe reaches the
--    trigger and only the lock decides.
-- ---------------------------------------------------------------------------
ALTER TABLE public.transaction_submissions DISABLE ROW LEVEL SECURITY;

SELECT pg_temp.probe('I01 authenticated role, no claims', 'authenticated', NULL,
  $$UPDATE public.transaction_submissions SET commission_actual_rate = 1.101 WHERE id = '$$ || :'s1' || $$'$$, '42501');
SELECT pg_temp.probe('I02 anon role, no claims', 'anon', NULL,
  $$UPDATE public.transaction_submissions SET commission_actual_rate = 1.102 WHERE id = '$$ || :'s1' || $$'$$, '42501');
SELECT pg_temp.probe('I03 anon role, anon claims', 'anon', :'anonc',
  $$UPDATE public.transaction_submissions SET commission_actual_rate = 1.103 WHERE id = '$$ || :'s1' || $$'$$, '42501');
SELECT pg_temp.probe('I04 authenticated role, authenticated claims', 'authenticated', :'agent',
  $$UPDATE public.transaction_submissions SET commission_actual_rate = 1.104 WHERE id = '$$ || :'s1' || $$'$$, '42501');
SELECT pg_temp.probe('I05 migration role with an unknown claim role (fails closed)', NULL, '{"role":"supabase_admin"}',
  $$UPDATE public.transaction_submissions SET commission_actual_rate = 1.105 WHERE id = '$$ || :'s1' || $$'$$, '42501');
SELECT pg_temp.probe('I06 service_role role, no claims', 'service_role', NULL,
  $$UPDATE public.transaction_submissions SET commission_actual_rate = 1.106 WHERE id = '$$ || :'s1' || $$'$$, 'ok rows=1');
SELECT pg_temp.probe('I07 authenticated role with service_role claims', 'authenticated', :'svc',
  $$UPDATE public.transaction_submissions SET commission_actual_rate = 1.107 WHERE id = '$$ || :'s1' || $$'$$, 'ok rows=1');

ALTER TABLE public.transaction_submissions ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Verdict
-- ---------------------------------------------------------------------------
SELECT CASE WHEN got = expect THEN 'PASS' ELSE 'FAIL' END || '  ' || name ||
       CASE WHEN got = expect THEN '' ELSE '  (expected ' || expect || ', got ' || COALESCE(got, 'NULL') || ')' END
  FROM lock_probe_results ORDER BY seq;

SELECT 'PROBES ' || count(*) || '  FAIL ' || count(*) FILTER (WHERE got IS DISTINCT FROM expect)
  FROM lock_probe_results;

DO $$
DECLARE
  v_total integer;
  v_fail integer;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE got IS DISTINCT FROM expect) INTO v_total, v_fail FROM lock_probe_results;
  IF v_total <> 28 THEN
    RAISE EXCEPTION 'lock-probes: expected 28 probes, ran %', v_total;
  END IF;
  IF v_fail > 0 THEN
    RAISE EXCEPTION 'lock-probes: % of % probes failed', v_fail, v_total;
  END IF;
END
$$;
