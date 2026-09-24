-- C16: the founder's worked example, computed from the records the helpers return,
-- on a close date of 2026-09-01.
--   price 100,000 x rate 10%  -> commission 10,000
--   minus the franchise fee in force (2,500) -> remainder 7,500
--   split 20 brokerage / 80 agent -> brokerage 1,500, agent 6,000
SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE price numeric := 100000; rate numeric := 10;
        commission numeric; fee numeric; remainder numeric;
        a_pct numeric; b_pct numeric; agent_amt numeric; brok_amt numeric;
BEGIN
  SELECT amount INTO fee FROM public.franchise_fee_in_force(current_setting('t3503.o_a')::uuid, DATE '2026-09-01');
  SELECT agent_pct, brokerage_pct INTO a_pct, b_pct FROM public.commission_agreement_in_force(
    current_setting('t3503.o_a')::uuid, current_setting('t3503.u_agent_a')::uuid, DATE '2026-09-01');
  commission := price * rate / 100;
  remainder  := commission - fee;
  brok_amt   := round(remainder * b_pct / 100, 2);
  agent_amt  := remainder - brok_amt;   -- the residual takes the rounding
  PERFORM pg_temp.check(commission = 10000, format('commission 10000, got %s', commission));
  PERFORM pg_temp.check(fee = 2500,         format('franchise fee 2500, got %s', fee));
  PERFORM pg_temp.check(remainder = 7500,   format('remainder 7500, got %s', remainder));
  PERFORM pg_temp.check(b_pct = 20 AND a_pct = 80, format('split 20/80, got %s/%s', b_pct, a_pct));
  PERFORM pg_temp.check(brok_amt = 1500,    format('brokerage 1500, got %s', brok_amt));
  PERFORM pg_temp.check(agent_amt = 6000,   format('agent 6000, got %s', agent_amt));
  PERFORM pg_temp.check(agent_amt + brok_amt = remainder, 'the two halves sum to the remainder');
END $$;
RESET ROLE;
