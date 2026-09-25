-- C14: the franchise fee is effective-dated the same way, it resolves a same-day
-- tie the same way, and in M1 an AGENT cannot read it (the single new access
-- decision in PLAN v2 -- default off).
--
-- THE SAME-DAY HALF IS WHY THIS CONTROL WAS EXTENDED. The ordering contract --
-- `effective_from DESC, seq DESC`, never `set_at DESC` -- is stated for BOTH
-- read helpers, but until F2/F3 existed only the agreement table had a pair that
-- could tell the two orderings apart: m03 mutates split_agreement_in_force
-- alone, and ordering franchise_fee_in_force by set_at reddened NOTHING.
-- Mutant m37 is that mistake on this table, and these assertions are its red.
SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE amt numeric; a timestamptz; b timestamptz;
BEGIN
  SELECT amount INTO amt FROM public.franchise_fee_in_force(current_setting('t3503.o_a')::uuid, DATE '2026-03-01');
  PERFORM pg_temp.check(amt = 2000.00, format('on 2026-03-01 the fee is 2000, got %s', amt));

  -- the fixture's shape first. A NULL here is a DENIED READ, not a broken
  -- fixture -- the same reading C11 asks for on the agreement table.
  SELECT set_at INTO a FROM public.organization_franchise_fees
    WHERE organization_id = current_setting('t3503.o_a')::uuid
      AND effective_from = DATE '2026-06-01' AND amount = 2750.00;
  SELECT set_at INTO b FROM public.organization_franchise_fees
    WHERE organization_id = current_setting('t3503.o_a')::uuid
      AND effective_from = DATE '2026-06-01' AND amount = 2500.00;
  PERFORM pg_temp.check(a IS NOT NULL AND b IS NOT NULL,
    'the broker can read both same-day fee rows at all (0 rows here means the SELECT was refused, not that the fixture is wrong)');
  PERFORM pg_temp.check(b < a, 'the fixture gives the later-inserted fee row an EARLIER set_at');
  PERFORM pg_temp.check((SELECT seq FROM public.organization_franchise_fees
                          WHERE organization_id = current_setting('t3503.o_a')::uuid
                            AND effective_from = DATE '2026-06-01' AND amount = 2500.00)
                      > (SELECT seq FROM public.organization_franchise_fees
                          WHERE organization_id = current_setting('t3503.o_a')::uuid
                            AND effective_from = DATE '2026-06-01' AND amount = 2750.00),
                        'and a LATER seq');

  -- the behavioural half: the correction wins, not the row with the later set_at
  SELECT amount INTO amt FROM public.franchise_fee_in_force(current_setting('t3503.o_a')::uuid, DATE '2026-09-01');
  PERFORM pg_temp.check(amt = 2500.00,
    format('the same-day fee correction wins on 2026-09-01 (2500, not the 2750 with the later set_at), got %s', amt));
END $$;
RESET ROLE;
SELECT pg_temp.act_as(current_setting('t3503.u_agent_a')::uuid);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.organization_franchise_fees;
  PERFORM pg_temp.check(n = 0, format('an agent reads 0 franchise fees in M1, got %s', n));
END $$;
RESET ROLE;
