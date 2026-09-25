-- C7: signed out, nothing is reachable -- not the table, not the helper.
SELECT pg_temp.act_as(NULL, 'anon');
DO $$
DECLARE s text;
BEGIN
  s := pg_temp.sqlstate_of('SELECT 1 FROM public.agent_split_agreements');
  PERFORM pg_temp.check(s = '42501', format('anon SELECT on agreements refused, got %s', s));
  s := pg_temp.sqlstate_of(format('SELECT 1 FROM public.split_agreement_in_force(%L,%L)',
        current_setting('t3503.o_a'), current_setting('t3503.u_agent_a')));
  PERFORM pg_temp.check(s = '42501', format('anon EXECUTE on the agreement helper refused, got %s', s));
END $$;
RESET ROLE;
