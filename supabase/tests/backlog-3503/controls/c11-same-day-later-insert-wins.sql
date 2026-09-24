-- C11: two rows share effective_from. The one the broker wrote LAST wins -- even
-- though its set_at is EARLIER, which is the shape a long transaction produces
-- (now() is transaction-start time; seq is allocated at INSERT execution).
-- This is the control that rejects `effective_from DESC, set_at DESC, seq DESC`.
SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE p numeric; a timestamptz; b timestamptz;
BEGIN
  SELECT set_at INTO a FROM public.agent_commission_agreements
    WHERE effective_from = DATE '2026-06-01' AND agent_pct = 50.00;
  SELECT set_at INTO b FROM public.agent_commission_agreements
    WHERE effective_from = DATE '2026-06-01' AND agent_pct = 80.00;
  -- Read this first if it is the line that failed: a NULL here is a DENIED
  -- READ, not a broken fixture. The fixture's shape is asserted below it.
  PERFORM pg_temp.check(a IS NOT NULL AND b IS NOT NULL,
    'the broker can read both same-day rows at all (0 rows here means the SELECT was refused, not that the fixture is wrong)');
  PERFORM pg_temp.check(b < a, 'the fixture gives the later-inserted row an EARLIER set_at');
  PERFORM pg_temp.check((SELECT seq FROM public.agent_commission_agreements WHERE effective_from = DATE '2026-06-01' AND agent_pct = 80.00)
                      > (SELECT seq FROM public.agent_commission_agreements WHERE effective_from = DATE '2026-06-01' AND agent_pct = 50.00),
                        'and a LATER seq');
  SELECT agent_pct INTO p FROM public.commission_agreement_in_force(
    current_setting('t3503.o_a')::uuid, current_setting('t3503.u_agent_a')::uuid, DATE '2026-06-15');
  PERFORM pg_temp.check(p = 80.00, format('the correction wins the same-day tie, got %s', p));
END $$;
RESET ROLE;
