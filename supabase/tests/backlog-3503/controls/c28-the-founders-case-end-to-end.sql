-- C28: the founder's own case, end to end, in the order it happens.
--
--   "An agent closes a deal in March, leaves in April, and the broker goes to
--    record their commission agreement in May."
--
-- Ruled 2026-09-23 (pm_comments on BACKLOG-3503). The earlier ruling refused
-- this; the refinement allows it. This control is the narrative one -- C25 and
-- C27 test the clause, this tests that the clause adds up to the outcome he
-- asked for, INCLUDING that the recorded agreement is then readable and resolves
-- as the agreement in force on the day of the closing.
--
-- A refusal arm alone would not have caught the real risk here. The row landing
-- is not the point; the point is that BACKLOG-3504 can compute the split for
-- that March closing afterwards. Before the refinement that query returned zero
-- rows -- control C12's shape -- and the agent's past could not be computed at
-- all.
--
-- Dates are offsets from the recorded deactivation, for the reason C25 gives.

SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE s text; closed date; left_on date; rec record; n int;
BEGIN
  left_on := current_setting('t3503.d_sus')::date;   -- "April": the day they left
  closed  := left_on - 45;                            -- "March": the day they closed

  -- The broker records the agreement AFTER the agent has gone. Nothing about
  -- the write says "May"; what makes it May is that the subject is already
  -- deactivated when it runs, which fixtures.sql arranged.
  PERFORM pg_temp.check(
    (SELECT license_status = 'suspended' FROM public.organization_members
      WHERE organization_id = current_setting('t3503.o_a')::uuid
        AND user_id = current_setting('t3503.u_agent_sus')::uuid),
    'precondition: the agent has already left when the broker records this');

  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_commission_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, office_fee_amount, office_fee_cadence, effective_from, note) VALUES (%L,%L,70,30,125,%L,%L::date,%L)',
    current_setting('t3503.o_a'), current_setting('t3503.u_agent_sus'), 'monthly', closed,
    'recorded after the agent left, effective from the closing'));
  PERFORM pg_temp.check(s = 'OK',
    format('the broker records a departed agent''s agreement, dated to the closing, got %s', s));

  -- ...and it is the agreement IN FORCE on the day of the closing. This is the
  -- half that matters to BACKLOG-3504 and the half C12's zero-row shape used to
  -- return instead.
  SELECT count(*) INTO n FROM public.commission_agreement_in_force(
    current_setting('t3503.o_a')::uuid, current_setting('t3503.u_agent_sus')::uuid, closed);
  PERFORM pg_temp.check(n = 1,
    format('the agreement resolves on the day of the closing instead of zero rows, got %s', n));

  SELECT * INTO rec FROM public.commission_agreement_in_force(
    current_setting('t3503.o_a')::uuid, current_setting('t3503.u_agent_sus')::uuid, closed);
  PERFORM pg_temp.check(rec.agent_pct = 70.00 AND rec.brokerage_pct = 30.00,
    format('and it is the agreement just recorded, got %s/%s', rec.agent_pct, rec.brokerage_pct));
  PERFORM pg_temp.check(rec.effective_from = closed,
    format('effective from the closing date, got %s', rec.effective_from));

  -- The refusal that still stands, asserted in the same breath so this control
  -- cannot be satisfied by a policy that simply permits everything: nothing NEW
  -- may be dated after they left.
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_commission_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, office_fee_amount, office_fee_cadence, effective_from) VALUES (%L,%L,70,30,125,%L,%L::date)',
    current_setting('t3503.o_a'), current_setting('t3503.u_agent_sus'), 'monthly', left_on + 1));
  PERFORM pg_temp.check(s = '42501',
    format('but a new agreement dated after they left is still refused, got %s', s));
END $$;
RESET ROLE;
