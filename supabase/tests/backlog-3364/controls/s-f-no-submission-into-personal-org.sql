-- S-f: row-level security on transaction_submissions INSERT, exercised as the
-- signed-in user (role authenticated, auth.uid() from the request claim).
--   personal agent -> own personal organization   : DENIED
--   brokerage agent -> own brokerage              : ALLOWED (1 row)
-- The allowed case is what makes the denied case mean something: it proves the
-- same statement shape passes the policy when the organization is a brokerage.

DO $setup$
DECLARE
  v jsonb;
BEGIN
  v := public._ensure_personal_organization_for(current_setting('t3364.u_personal_f')::uuid);
  PERFORM pg_temp.check(v->>'status' = 'created', format('personal organization created, got %s', v));
  PERFORM set_config('t3364.pf_org', v->>'organization_id', true);
END
$setup$;

-- As the personal agent.
SELECT pg_temp.act_as(current_setting('t3364.u_personal_f')::uuid);
DO $as_personal$
BEGIN
  BEGIN
    INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address)
    VALUES (current_setting('t3364.pf_org')::uuid, auth.uid(), 'fixture-3364-txn-personal', 'fixture-3364 address');
    PERFORM set_config('t3364.sf_personal', 'allowed', true);
  EXCEPTION WHEN insufficient_privilege THEN
    PERFORM set_config('t3364.sf_personal', 'denied:' || SQLERRM, true);
  END;
END
$as_personal$;
RESET ROLE;

-- As the brokerage agent.
SELECT pg_temp.act_as(current_setting('t3364.u_broker_agent')::uuid);
DO $as_broker$
DECLARE
  n integer;
BEGIN
  BEGIN
    INSERT INTO public.transaction_submissions (organization_id, submitted_by, local_transaction_id, property_address)
    VALUES (current_setting('t3364.o_brk_a')::uuid, auth.uid(), 'fixture-3364-txn-brokerage', 'fixture-3364 address');
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM set_config('t3364.sf_broker', 'allowed:' || n, true);
  EXCEPTION WHEN insufficient_privilege THEN
    PERFORM set_config('t3364.sf_broker', 'denied:' || SQLERRM, true);
  END;
END
$as_broker$;
RESET ROLE;

DO $assert$
BEGIN
  PERFORM pg_temp.check(current_setting('t3364.sf_personal') LIKE 'denied:%row-level security%',
                        format('personal agent submission into own personal organization is denied by RLS, got %s', current_setting('t3364.sf_personal')));
  PERFORM pg_temp.check(current_setting('t3364.sf_broker') = 'allowed:1',
                        format('brokerage agent submission into own brokerage is allowed, got %s', current_setting('t3364.sf_broker')));
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.transaction_submissions WHERE local_transaction_id = 'fixture-3364-txn-personal'),
                        'no submission row stored under the personal organization');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM public.transaction_submissions WHERE local_transaction_id = 'fixture-3364-txn-brokerage'),
                        'brokerage submission row stored');
END
$assert$;
