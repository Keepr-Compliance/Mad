-- C24: a DEACTIVATED broker, and a DEACTIVATED admin, cannot INSERT into EITHER
-- table -- while the ACTIVE broker of the same organization can.
--
-- The write half of the same ruling C23 reads. Split into its own file rather
-- than appended to C23 for the reason C20 was split out of C19: under a mutant
-- that breaks both, whichever assertion runs first is the only one reported, and
-- a rule worth stating separately deserves its own red.
--
-- 42501 SPECIFICALLY, not "it raised". A grant without a policy makes a refused
-- write a silent zero-row no-op that raises nothing at all -- m21/m22/m25 are
-- that shape elsewhere in this suite and every one of their reds reads `got OK`.
-- Here the refusal comes from the WITH CHECK, which raises 42501; asserting the
-- code is what distinguishes a policy that refused from a table that quietly
-- swallowed the row.
--
-- The agreement INSERT names u_agent_a, an ACTIVE member of org A, on purpose:
-- the INSERT policy's other term -- the member-EXISTS about the agent the
-- agreement is FOR -- is then satisfied, so the only thing left to refuse is
-- can_write_commission_agreements. A suspended agent there would confound the
-- two terms and the control would pass for the wrong reason.

DO $$
DECLARE who text; s text; n int;
BEGIN
  FOREACH who IN ARRAY ARRAY['broker', 'admin'] LOOP
    -- The failure messages name the ROLE, never the fixture uuid: they land in
    -- mutant-run.txt, which is committed, and a bare uuid in a tracked file is a
    -- finding (scripts/ci/check-fixture-pii.mjs).
    PERFORM pg_temp.act_as(current_setting('t3503.u_' || who || '_sus')::uuid);

    s := pg_temp.sqlstate_of(format(
      'INSERT INTO public.agent_commission_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, office_fee_amount, office_fee_cadence, effective_from) VALUES (%L,%L,55,45,110,%L,DATE ''2026-08-01'')',
      current_setting('t3503.o_a'), current_setting('t3503.u_agent_a'), 'monthly'));
    PERFORM pg_temp.check(s = '42501',
      format('a deactivated %s INSERTing an agreement is refused with 42501, got %s', who, s));

    s := pg_temp.sqlstate_of(format(
      'INSERT INTO public.organization_franchise_fees (organization_id, amount, effective_from) VALUES (%L,3100,DATE ''2026-08-01'')',
      current_setting('t3503.o_a')));
    PERFORM pg_temp.check(s = '42501',
      format('a deactivated %s INSERTing a franchise fee is refused with 42501, got %s', who, s));

    RESET ROLE;
  END LOOP;
END $$;
RESET ROLE;

-- nothing landed
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.agent_commission_agreements
   WHERE effective_from = DATE '2026-08-01';
  PERFORM pg_temp.check(n = 0, format('no agreement row from a deactivated writer survives, got %s', n));
  SELECT count(*) INTO n FROM public.organization_franchise_fees
   WHERE effective_from = DATE '2026-08-01';
  PERFORM pg_temp.check(n = 0, format('no franchise fee row from a deactivated writer survives, got %s', n));
END $$;

-- the ACTIVE broker of the same organization writes both, in the same
-- transaction against the same tables. Without this arm the control cannot tell
-- a working status term from a rule that refuses everyone.
SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE s text;
BEGIN
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_commission_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, office_fee_amount, office_fee_cadence, effective_from) VALUES (%L,%L,55,45,110,%L,DATE ''2026-08-02'')',
    current_setting('t3503.o_a'), current_setting('t3503.u_agent_a'), 'monthly'));
  PERFORM pg_temp.check(s = 'OK', format('the active broker still writes an agreement, got %s', s));
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.organization_franchise_fees (organization_id, amount, effective_from) VALUES (%L,3100,DATE ''2026-08-02'')',
    current_setting('t3503.o_a')));
  PERFORM pg_temp.check(s = 'OK', format('...and still writes a franchise fee, got %s', s));
END $$;
RESET ROLE;
