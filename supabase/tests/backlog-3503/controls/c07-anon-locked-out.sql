-- C7: signed out, nothing is reachable -- not the tables, not the helpers.
SELECT pg_temp.act_as(NULL, 'anon');
DO $$
DECLARE s text;
BEGIN
  s := pg_temp.sqlstate_of('SELECT 1 FROM public.agent_commission_agreements');
  PERFORM pg_temp.check(s = '42501', format('anon SELECT on agreements refused, got %s', s));
  s := pg_temp.sqlstate_of('SELECT 1 FROM public.organization_franchise_fees');
  PERFORM pg_temp.check(s = '42501', format('anon SELECT on franchise fees refused, got %s', s));
  s := pg_temp.sqlstate_of(format('SELECT 1 FROM public.commission_agreement_in_force(%L,%L)',
        current_setting('t3503.o_a'), current_setting('t3503.u_agent_a')));
  PERFORM pg_temp.check(s = '42501', format('anon EXECUTE on the agreement helper refused, got %s', s));
  s := pg_temp.sqlstate_of(format('SELECT 1 FROM public.franchise_fee_in_force(%L)', current_setting('t3503.o_a')));
  PERFORM pg_temp.check(s = '42501', format('anon EXECUTE on the franchise helper refused, got %s', s));
END $$;
RESET ROLE;
