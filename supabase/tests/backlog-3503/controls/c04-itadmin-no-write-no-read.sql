-- C4: it_admin can neither write nor read either table. (Founder ruling 2026-09-22.)
SELECT pg_temp.act_as(current_setting('t3503.u_itadmin_a')::uuid);
DO $$
DECLARE s text;
BEGIN
  PERFORM pg_temp.check((SELECT count(*) FROM public.agent_split_agreements) = 0,
                        'it_admin reads 0 agreements');
  PERFORM pg_temp.check((SELECT count(*) FROM public.organization_franchise_fees) = 0,
                        'it_admin reads 0 franchise fees');
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_split_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, office_fee_amount, office_fee_cadence, effective_from) VALUES (%L,%L,99,1,0,%L,DATE ''2026-07-01'')',
    current_setting('t3503.o_a'), current_setting('t3503.u_agent_a'), 'monthly'));
  PERFORM pg_temp.check(s = '42501', format('it_admin agreement INSERT refused, got %s', s));
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.organization_franchise_fees (organization_id, amount, effective_from) VALUES (%L,1,DATE ''2026-07-01'')',
    current_setting('t3503.o_a')));
  PERFORM pg_temp.check(s = '42501', format('it_admin franchise INSERT refused, got %s', s));
END $$;
RESET ROLE;
