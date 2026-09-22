-- C10: the helper answers "in force ON DATE D", not "in force today", and never
-- returns a row dated after D.
SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE p numeric; n int;
BEGIN
  SELECT agent_pct INTO p FROM public.commission_agreement_in_force(
    current_setting('t3503.o_a')::uuid, current_setting('t3503.u_agent_a')::uuid, DATE '2026-03-01');
  PERFORM pg_temp.check(p = 60.00, format('on 2026-03-01 the January row is in force (60), got %s', p));
  SELECT agent_pct INTO p FROM public.commission_agreement_in_force(
    current_setting('t3503.o_a')::uuid, current_setting('t3503.u_agent_a')::uuid, DATE '2026-09-01');
  PERFORM pg_temp.check(p = 80.00, format('on 2026-09-01 the June correction is in force (80), got %s', p));
  SELECT count(*) INTO n FROM public.commission_agreement_in_force(
    current_setting('t3503.o_a')::uuid, current_setting('t3503.u_agent_a')::uuid, DATE '2025-12-31');
  PERFORM pg_temp.check(n = 0, format('before the first agreement there is nothing in force, got %s rows', n));
  SELECT count(*) INTO n FROM public.commission_agreement_in_force(
    current_setting('t3503.o_a')::uuid, current_setting('t3503.u_agent_a')::uuid, DATE '2026-09-01');
  PERFORM pg_temp.check(n = 1, 'exactly one row is in force');
END $$;
RESET ROLE;
