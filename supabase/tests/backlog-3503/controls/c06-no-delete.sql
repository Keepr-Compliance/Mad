-- C6: a broker cannot DELETE from either table, and nothing disappears.
SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE s text; n int;
BEGIN
  s := pg_temp.sqlstate_of('DELETE FROM public.agent_commission_agreements');
  PERFORM pg_temp.check(s = '42501', format('agreement DELETE refused with 42501, got %s', s));
  s := pg_temp.sqlstate_of('DELETE FROM public.organization_franchise_fees');
  PERFORM pg_temp.check(s = '42501', format('franchise DELETE refused with 42501, got %s', s));
  SELECT count(*) INTO n FROM public.agent_commission_agreements;
  PERFORM pg_temp.check(n = 7, format('broker A still sees all 7 org-A agreements, got %s', n));
END $$;
RESET ROLE;
