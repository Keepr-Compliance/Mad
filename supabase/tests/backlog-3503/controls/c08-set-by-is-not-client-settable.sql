-- C8/C8b: a client cannot name the setter (set_by is outside the INSERT grant),
-- and a plain broker INSERT lands set_by = auth.uid() and set_at = now().
SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE s text; got uuid; ts timestamptz;
BEGIN
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_split_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, effective_from, set_by) VALUES (%L,%L,65,35,DATE ''2026-07-01'',%L)',
    current_setting('t3503.o_a'), current_setting('t3503.u_agent_a'), current_setting('t3503.u_admin_a')));
  PERFORM pg_temp.check(s = '42501', format('naming set_by is refused with 42501, got %s', s));

  INSERT INTO public.agent_split_agreements
    (organization_id, agent_user_id, agent_pct, brokerage_pct, effective_from)
  VALUES (current_setting('t3503.o_a')::uuid, current_setting('t3503.u_agent_a')::uuid,
          65, 35, DATE '2026-07-01')
  RETURNING set_by, set_at INTO got, ts;
  PERFORM pg_temp.check(got = current_setting('t3503.u_broker_a')::uuid,
                        format('set_by defaulted to the caller, got %s', got));
  PERFORM pg_temp.check(ts > now() - interval '1 minute', 'set_at defaulted to now()');
END $$;
RESET ROLE;
