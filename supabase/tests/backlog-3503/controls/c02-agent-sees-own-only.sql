-- C2: an agent sees their own agreement rows and no colleague's.
SELECT pg_temp.act_as(current_setting('t3503.u_agent_a')::uuid);
DO $$ BEGIN
  PERFORM pg_temp.check((SELECT count(*) FROM public.agent_split_agreements) = 4,
                        'agent A sees exactly their own 4 rows');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.agent_split_agreements
                                     WHERE agent_user_id = current_setting('t3503.u_agent_a2')::uuid),
                        'agent A sees none of the colleague1s rows');
END $$;
RESET ROLE;
