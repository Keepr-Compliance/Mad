-- C13: the read helpers are SECURITY INVOKER. An agent asking for a colleague, and
-- a broker of B asking about org A, both get the correct non-answer: zero rows.
-- This is the control that catches a helper marked SECURITY DEFINER.
DO $$
DECLARE n int;
BEGIN
  PERFORM pg_temp.act_as(current_setting('t3503.u_agent_a')::uuid);
  SELECT count(*) INTO n FROM public.split_agreement_in_force(
    current_setting('t3503.o_a')::uuid, current_setting('t3503.u_agent_a2')::uuid, DATE '2026-09-01');
  PERFORM pg_temp.check(n = 0, format('an agent asking about a colleague gets 0 rows, got %s', n));
  SELECT count(*) INTO n FROM public.split_agreement_in_force(
    current_setting('t3503.o_a')::uuid, current_setting('t3503.u_agent_a')::uuid, DATE '2026-09-01');
  PERFORM pg_temp.check(n = 1, 'the same agent asking about themselves gets their row');
  RESET ROLE;
  PERFORM pg_temp.act_as(current_setting('t3503.u_broker_b')::uuid);
  SELECT count(*) INTO n FROM public.split_agreement_in_force(
    current_setting('t3503.o_a')::uuid, current_setting('t3503.u_agent_a')::uuid, DATE '2026-09-01');
  PERFORM pg_temp.check(n = 0, format('a broker of another org gets 0 rows, got %s', n));
  SELECT count(*) INTO n FROM public.franchise_fee_in_force(current_setting('t3503.o_a')::uuid, DATE '2026-09-01');
  PERFORM pg_temp.check(n = 0, format('...and 0 franchise-fee rows, got %s', n));
  RESET ROLE;
END $$;
RESET ROLE;
