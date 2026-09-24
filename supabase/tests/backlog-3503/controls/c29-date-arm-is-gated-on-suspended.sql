-- C29: the date arm's status gate. A member who was deactivated and then
-- EXPIRED keeps their deactivation date, and must NOT be writable for.
--
-- WHY THIS SHAPE EXISTS AT ALL. Section 2b's trigger stamps the column on the
-- move into 'suspended' and clears it on the move back to 'active'. It
-- deliberately leaves it ALONE on a move to 'pending' or 'expired' -- the date
-- already recorded is still true. So a row can sit at 'expired' carrying a
-- deactivation date, and the second arm of the INSERT policy would admit it if
-- the arm did not also require `m.license_status = 'suspended'`.
--
-- The gate looks redundant, because only a suspension writes that column. It is
-- not: it is the same fail-closed choice the rest of this migration makes by
-- spelling `= 'active'` rather than `NOT IN (...)`. organization_members'
-- license_status CHECK admits four values today and a fifth can be added by any
-- later migration; an ungated arm would admit that fifth state silently.
--
-- MEASURED BEFORE THIS CONTROL WAS WRITTEN: mutant m42 -- the gate deleted --
-- reddened NONE of the 26 controls that existed then.
--
-- u_agent_exp is the subject, produced in fixtures.sql by the real transitions:
-- active -> suspended (trigger stamps) -> expired (trigger leaves it).

DO $$
DECLARE st text; d timestamptz;
BEGIN
  SELECT license_status, deactivated_at INTO st, d FROM public.organization_members
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_exp')::uuid;
  PERFORM pg_temp.check(st = 'expired',
    format('precondition: the subject is at expired, got %s', coalesce(st, 'NO MEMBERSHIP ROW')));
  PERFORM pg_temp.check(d IS NOT NULL,
    'precondition: and still carries the deactivation date the trigger recorded');
END $$;

SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE s text; n int; d_in date;
BEGIN
  -- dated INSIDE the recorded period on purpose. If it were dated outside, the
  -- date comparison would refuse it and this control could not tell the status
  -- gate from the comparison.
  d_in := (SELECT (deactivated_at AT TIME ZONE 'UTC')::date - 10
             FROM public.organization_members
            WHERE organization_id = current_setting('t3503.o_a')::uuid
              AND user_id = current_setting('t3503.u_agent_exp')::uuid);

  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_commission_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, office_fee_amount, office_fee_cadence, effective_from) VALUES (%L,%L,50,50,100,%L,%L::date)',
    current_setting('t3503.o_a'), current_setting('t3503.u_agent_exp'), 'monthly', d_in));
  PERFORM pg_temp.check(s = '42501',
    format('a subject at EXPIRED is refused even inside their recorded period, got %s', s));

  SELECT count(*) INTO n FROM public.agent_commission_agreements
   WHERE agent_user_id = current_setting('t3503.u_agent_exp')::uuid;
  PERFORM pg_temp.check(n = 0, format('and no row for them survives, got %s', n));

  -- the separating arm: the SAME date, for a SUSPENDED subject, is allowed. Two
  -- refusals cannot tell a working gate from a write rule stuck at false.
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_commission_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, office_fee_amount, office_fee_cadence, effective_from) VALUES (%L,%L,50,50,100,%L,%L::date)',
    current_setting('t3503.o_a'), current_setting('t3503.u_agent_sus'), 'monthly',
    current_setting('t3503.d_sus')::date - 10));
  PERFORM pg_temp.check(s = 'OK',
    format('...while a SUSPENDED subject at the same offset is allowed, got %s', s));
END $$;
RESET ROLE;
