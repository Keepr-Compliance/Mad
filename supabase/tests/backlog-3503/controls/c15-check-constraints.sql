-- C15: the constraints that encode the fee model. A split divides what remains
-- after the franchise fee, two ways, so it sums to 100. Cadence is a constrained
-- value, not free text. No fee can be negative.
SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE s text;
  function_body text := 'INSERT INTO public.agent_split_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, office_fee_amount, office_fee_cadence, effective_from) VALUES (%L,%L,%s,%s,%s,%L,DATE ''2026-07-01'')';
BEGIN
  s := pg_temp.sqlstate_of(format(function_body, current_setting('t3503.o_a'), current_setting('t3503.u_agent_a'), 70, 20, 0, 'monthly'));
  PERFORM pg_temp.check(s = '23514', format('70/20 is refused by the sum check, got %s', s));
  s := pg_temp.sqlstate_of(format(function_body, current_setting('t3503.o_a'), current_setting('t3503.u_agent_a'), 80, 20, 0, 'weekly'));
  PERFORM pg_temp.check(s = '23514', format('cadence weekly is refused, got %s', s));
  s := pg_temp.sqlstate_of(format(function_body, current_setting('t3503.o_a'), current_setting('t3503.u_agent_a'), 80, 20, -1, 'monthly'));
  PERFORM pg_temp.check(s = '23514', format('a negative office fee is refused, got %s', s));
  s := pg_temp.sqlstate_of(format(function_body, current_setting('t3503.o_a'), current_setting('t3503.u_agent_a'), 80, 20, 0, 'annual'));
  PERFORM pg_temp.check(s = 'OK', format('80/20 annual is accepted, got %s', s));
  s := pg_temp.sqlstate_of(format('INSERT INTO public.organization_franchise_fees (organization_id, amount, effective_from) VALUES (%L,-1,DATE ''2026-07-01'')', current_setting('t3503.o_a')));
  PERFORM pg_temp.check(s = '23514', format('a negative franchise fee is refused, got %s', s));
END $$;
RESET ROLE;
