-- C3: an agent cannot insert an agreement, not even their own.
SELECT pg_temp.act_as(current_setting('t3503.u_agent_a')::uuid);
DO $$
DECLARE s text;
BEGIN
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_split_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, effective_from) VALUES (%L,%L,99,1,DATE ''2026-07-01'')',
    current_setting('t3503.o_a'), current_setting('t3503.u_agent_a')));
  PERFORM pg_temp.check(s = '42501', format('agent INSERT refused with 42501, got %s', s));
END $$;
RESET ROLE;
