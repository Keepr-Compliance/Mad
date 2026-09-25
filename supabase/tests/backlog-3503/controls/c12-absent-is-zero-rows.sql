-- C12: absent is ZERO ROWS, never a row of zeros -- so 3504 can tell "not set up"
-- from a real 0/100 agreement.
SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.split_agreement_in_force(
    current_setting('t3503.o_a')::uuid, current_setting('t3503.u_nomember')::uuid);
  PERFORM pg_temp.check(n = 0, format('a user with no agreement returns 0 rows, got %s', n));
END $$;
RESET ROLE;
