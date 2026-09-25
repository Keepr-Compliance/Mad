-- C15: the constraint that encodes the split model. A split divides the
-- commission two ways, so it sums to 100.
SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE s text;
  function_body text := 'INSERT INTO public.agent_split_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, effective_from) VALUES (%L,%L,%s,%s,DATE ''2026-07-01'')';
BEGIN
  s := pg_temp.sqlstate_of(format(function_body, current_setting('t3503.o_a'), current_setting('t3503.u_agent_a'), 70, 20));
  PERFORM pg_temp.check(s = '23514', format('70/20 is refused by the sum check, got %s', s));
  s := pg_temp.sqlstate_of(format(function_body, current_setting('t3503.o_a'), current_setting('t3503.u_agent_a'), 80, 20));
  PERFORM pg_temp.check(s = 'OK', format('80/20 is accepted, got %s', s));
END $$;
RESET ROLE;
