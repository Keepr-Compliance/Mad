-- C1: a broker of org B sees none of org A's agreements or franchise fees.
SELECT pg_temp.act_as(current_setting('t3503.u_broker_b')::uuid);
DO $$ BEGIN
  PERFORM pg_temp.check((SELECT count(*) FROM public.agent_commission_agreements
                          WHERE organization_id = current_setting('t3503.o_a')::uuid) = 0,
                        'broker B sees 0 of org A agreements');
  PERFORM pg_temp.check((SELECT count(*) FROM public.organization_franchise_fees
                          WHERE organization_id = current_setting('t3503.o_a')::uuid) = 0,
                        'broker B sees 0 of org A franchise fees');
  PERFORM pg_temp.check((SELECT count(*) FROM public.agent_commission_agreements) = 1,
                        'broker B sees exactly his own org1s 1 agreement');
  PERFORM pg_temp.check((SELECT count(*) FROM public.organization_franchise_fees) = 1,
                        'broker B sees exactly his own org1s 1 franchise fee');
END $$;
RESET ROLE;
