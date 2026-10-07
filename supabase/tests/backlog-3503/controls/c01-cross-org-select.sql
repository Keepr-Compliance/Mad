-- C1: a broker of org B sees none of org A's agreements.
SELECT pg_temp.act_as(current_setting('t3503.u_broker_b')::uuid);
DO $$ BEGIN
  PERFORM pg_temp.check((SELECT count(*) FROM public.agent_split_agreements
                          WHERE organization_id = current_setting('t3503.o_a')::uuid) = 0,
                        'broker B sees 0 of org A agreements');
  PERFORM pg_temp.check((SELECT count(*) FROM public.agent_split_agreements) = 1,
                        'broker B sees exactly his own org1s 1 agreement');
END $$;
RESET ROLE;
