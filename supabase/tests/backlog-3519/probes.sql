\set ON_ERROR_STOP off
-- BACKLOG-3519 boundary sweep against the applied migration (figures only).
-- One outer transaction, rolled back at the end; each probe in a SAVEPOINT.
--
-- HOW TO READ THE OUTPUT: a probe labelled "SHOULD FAIL" that prints its row
-- means the INSERT was wrongly ACCEPTED (bug). A Postgres `ERROR: ... violates
-- check constraint ...` with no row after it means the constraint fired
-- correctly. Probes that should succeed print their row directly.

BEGIN;
CREATE TEMP TABLE t3519_ctx (org uuid, agent uuid);
DO $$
DECLARE v_org uuid; v_agent uuid;
BEGIN
  INSERT INTO public.organizations (name) VALUES ('Test Org') RETURNING id INTO v_org;
  INSERT INTO auth.users (id) VALUES (gen_random_uuid()) RETURNING id INTO v_agent;
  INSERT INTO t3519_ctx VALUES (v_org, v_agent);
END $$;

\echo '== columns: types'
SELECT column_name, data_type, numeric_precision, numeric_scale
  FROM information_schema.columns
 WHERE table_name = 'transaction_submissions' AND column_name LIKE 'commission%'
 ORDER BY column_name;
\echo '== no split_* column exists'
SELECT count(*) AS split_columns_should_be_0 FROM information_schema.columns
 WHERE table_name = 'transaction_submissions' AND column_name LIKE 'split%';

-- helper: try an insert with the given figures, report acceptance
CREATE FUNCTION pg_temp.try(p_label text, p_off numeric, p_act numeric, p_gross numeric, p_reason text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.transaction_submissions
    (organization_id, submitted_by, local_transaction_id, property_address,
     commission_offered_rate, commission_actual_rate, commission_gross_amount, commission_adjustment_reason)
  SELECT org, agent, gen_random_uuid()::text, '1 Main St', p_off, p_act, p_gross, p_reason FROM t3519_ctx;
  RAISE NOTICE 'ACCEPTED: %', p_label;
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'REJECTED: %', p_label;
END $$;

SELECT pg_temp.try('all null (SHOULD ACCEPT)', NULL, NULL, NULL, NULL);
SELECT pg_temp.try('2.375 / 2.375 / 9796.88 / reason (SHOULD ACCEPT)', 2.375, 2.375, 9796.88, 'Reduced');
SELECT pg_temp.try('rate 0 (SHOULD ACCEPT)', 0, 0, 0, NULL);
SELECT pg_temp.try('rate 100 (SHOULD ACCEPT)', 100, 100, 1, NULL);
SELECT pg_temp.try('rate 100.001 (SHOULD REJECT)', 100.001, NULL, NULL, NULL);
SELECT pg_temp.try('actual -0.001 (SHOULD REJECT)', NULL, -0.001, NULL, NULL);
SELECT pg_temp.try('gross -0.01 (SHOULD REJECT)', NULL, NULL, -0.01, NULL);
SELECT pg_temp.try('blank reason (SHOULD REJECT)', NULL, NULL, NULL, '   ');
SELECT pg_temp.try('2000-char reason (SHOULD ACCEPT)', NULL, NULL, NULL, repeat('x', 2000));
SELECT pg_temp.try('2001-char reason (SHOULD REJECT)', NULL, NULL, NULL, repeat('x', 2001));

\echo '== stored rate keeps 3 decimals (2.375 must read back 2.375, not 2.38)'
INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address, commission_actual_rate)
  SELECT org, agent, 'rt', '1 Main St', 2.375 FROM t3519_ctx;
SELECT commission_actual_rate FROM public.transaction_submissions WHERE local_transaction_id = 'rt';

ROLLBACK;
