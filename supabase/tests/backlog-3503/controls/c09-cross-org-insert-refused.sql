-- C9: a broker of A cannot write into org B -- on EITHER table. The franchise-fee
-- half is load-bearing on its own: that policy has no member-EXISTS clause, so the
-- org check in can_write_split_agreements is the only thing stopping it.
SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE s text;
BEGIN
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_split_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, office_fee_amount, office_fee_cadence, effective_from) VALUES (%L,%L,99,1,0,%L,DATE ''2026-07-01'')',
    current_setting('t3503.o_b'), current_setting('t3503.u_agent_b'), 'monthly'));
  PERFORM pg_temp.check(s = '42501', format('broker A writing org B agreement refused, got %s', s));
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.organization_franchise_fees (organization_id, amount, effective_from) VALUES (%L,1,DATE ''2026-07-01'')',
    current_setting('t3503.o_b')));
  PERFORM pg_temp.check(s = '42501', format('broker A writing org B franchise fee refused, got %s', s));
  -- and a broker cannot set a split for someone who is not a member of his org
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_split_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, office_fee_amount, office_fee_cadence, effective_from) VALUES (%L,%L,99,1,0,%L,DATE ''2026-07-01'')',
    current_setting('t3503.o_a'), current_setting('t3503.u_nomember'), 'monthly'));
  PERFORM pg_temp.check(s = '42501', format('a non-member subject is refused, got %s', s));
  -- The case that distinguishes a QUALIFIED organization_id in the EXISTS clause
  -- from an unqualified one: agent_b IS a member -- of org B. An unqualified
  -- column binds to m.organization_id, making the clause "is a member of ANY org",
  -- which would let this through. u_nomember alone cannot detect that.
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_split_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, office_fee_amount, office_fee_cadence, effective_from) VALUES (%L,%L,99,1,0,%L,DATE ''2026-07-01'')',
    current_setting('t3503.o_a'), current_setting('t3503.u_agent_b'), 'monthly'));
  PERFORM pg_temp.check(s = '42501', format('a subject who is a member of ANOTHER org is refused, got %s', s));
END $$;
RESET ROLE;
