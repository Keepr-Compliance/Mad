-- C14: the franchise fee is effective-dated the same way, and in M1 an AGENT
-- cannot read it (the single new access decision in PLAN v2 -- default off).
SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE amt numeric;
BEGIN
  SELECT amount INTO amt FROM public.franchise_fee_in_force(current_setting('t3503.o_a')::uuid, DATE '2026-03-01');
  PERFORM pg_temp.check(amt = 2000.00, format('on 2026-03-01 the fee is 2000, got %s', amt));
  SELECT amount INTO amt FROM public.franchise_fee_in_force(current_setting('t3503.o_a')::uuid, DATE '2026-09-01');
  PERFORM pg_temp.check(amt = 2500.00, format('on 2026-09-01 the fee is 2500, got %s', amt));
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
