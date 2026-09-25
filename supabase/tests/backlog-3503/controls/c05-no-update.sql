-- C5: a broker cannot UPDATE the table. Asserts the SPECIFIC outcome: with no
-- grant it is 42501; a grant without a policy would instead be a silent 0-row no-op,
-- so the row count is asserted unchanged too.
SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE s text; before numeric; after numeric;
BEGIN
  SELECT agent_pct INTO before FROM public.agent_split_agreements
    WHERE agent_user_id = current_setting('t3503.u_agent_a')::uuid AND effective_from = DATE '2026-01-01';
  s := pg_temp.sqlstate_of('UPDATE public.agent_split_agreements SET agent_pct = 1');
  PERFORM pg_temp.check(s = '42501', format('agreement UPDATE refused with 42501, got %s', s));
  SELECT agent_pct INTO after FROM public.agent_split_agreements
    WHERE agent_user_id = current_setting('t3503.u_agent_a')::uuid AND effective_from = DATE '2026-01-01';
  PERFORM pg_temp.check(before = after AND after = 60.00, format('the row is unchanged at 60, got %s', after));
END $$;
RESET ROLE;
