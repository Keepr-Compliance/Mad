-- C25: what the INSERT policy's member-EXISTS does about the SUBJECT.
--
-- The founder's rule, refined 2026-09-23 (pm_comments on BACKLOG-3503): a broker
-- may record an agreement for an agent who has left, as long as its effective
-- date falls inside the period that agent was active. Nothing new may be dated
-- after they left. This control asserts all four shapes the clause distinguishes,
-- over the same rows in the same transaction:
--
--   DEACTIVATED subject, dated INSIDE the active period -> ALLOWED. This is the
--     case the refinement added, and the founder's own driving example: an agent
--     closes in March, leaves in April, the broker records the agreement in May.
--   DEACTIVATED subject, dated AFTER the deactivation   -> REFUSED by the date
--     comparison. This is what survives from the earlier ruling.
--   REMOVED subject -> REFUSED because removeUser.ts DELETEs the membership row,
--     so the EXISTS finds nothing at all and no term is involved.
--   ACTIVE subject  -> ALLOWED, with no date test applied to them whatsoever.
--
-- FOUR ARMS, NOT TWO, AND NONE OF THEM IS REDUNDANT. Refusals alone cannot tell
-- "the subject clause works" from "this broker cannot write at all" -- a write
-- rule stuck at false satisfies every refusal. The two ALLOWED arms are what
-- separate those. And the two deactivated arms differ only in their date, which
-- is what makes this control see the refinement at all.
--
-- MEASURED, BEFORE THIS CONTROL WAS REWRITTEN: the previous version of C25 used
-- a single future date (2026-10-01) for its deactivated subject. Against the new
-- policy it stayed GREEN -- the row was refused by the date arm instead of by
-- the old status term, and the behavioural reversal was invisible. All 26
-- controls stayed green. That is why the dates below are expressed as OFFSETS
-- from the recorded deactivation date and never as literals.
--
-- The dates come from t3503.d_sus, which fixtures.sql reads back OUT of
-- organization_members.deactivated_at after the trigger wrote it. Nothing here
-- assumes a value the producer did not generate.
--
-- The failure messages name the SHAPE, never a fixture uuid: they land in
-- mutant-run.txt, which is committed (scripts/ci/check-fixture-pii.mjs).

-- precondition, read as postgres: the three subjects are in the three states,
-- and the deactivated one carries a date the trigger put there.
DO $$
DECLARE st text; n int; d timestamptz;
BEGIN
  SELECT license_status, deactivated_at INTO st, d FROM public.organization_members
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_sus')::uuid;
  PERFORM pg_temp.check(st = 'suspended',
    format('precondition: the deactivated subject still has an org-A row, at suspended, got %s', coalesce(st, 'NO MEMBERSHIP ROW')));
  PERFORM pg_temp.check(d IS NOT NULL,
    'precondition: the deactivated subject carries a deactivation date written by the trigger');
  PERFORM pg_temp.check((d AT TIME ZONE 'UTC')::date = current_setting('t3503.d_sus')::date,
    'precondition: the published deactivation date is the one on the row');

  SELECT count(*) INTO n FROM public.organization_members
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_gone')::uuid;
  PERFORM pg_temp.check(n = 0,
    format('precondition: the removed subject has no org-A row at all, got %s', n));

  SELECT license_status INTO st FROM public.organization_members
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_a')::uuid;
  PERFORM pg_temp.check(st = 'active',
    format('precondition: the control subject is an active org-A member, got %s', coalesce(st, 'NO MEMBERSHIP ROW')));
END $$;

-- the ACTIVE broker of that organization writes for all four shapes
SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE s text; n int; d_in date; d_out date;
BEGIN
  d_in  := current_setting('t3503.d_sus')::date - 30;  -- the March deal
  d_out := current_setting('t3503.d_sus')::date + 30;  -- dated after they left

  -- 1. a DEACTIVATED subject, dated INSIDE the active period: ALLOWED. This is
  --    the assertion m36 and m41 and m42 push against from three directions.
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_split_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, effective_from) VALUES (%L,%L,55,45,%L::date)',
    current_setting('t3503.o_a'), current_setting('t3503.u_agent_sus'), d_in));
  PERFORM pg_temp.check(s = 'OK',
    format('a broker CAN record an agreement for a DEACTIVATED agent dated INSIDE their active period, got %s', s));

  -- 2. the same subject, dated AFTER the deactivation: REFUSED -- 42501
  --    specifically, because the refusal comes from the WITH CHECK. A silent
  --    zero-row no-op would raise nothing and "it raised" would pass.
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_split_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, effective_from) VALUES (%L,%L,55,45,%L::date)',
    current_setting('t3503.o_a'), current_setting('t3503.u_agent_sus'), d_out));
  PERFORM pg_temp.check(s = '42501',
    format('...and CANNOT date one AFTER they left, refused with 42501, got %s', s));

  -- 3. a REMOVED subject: refused whatever the date, by the EXISTS finding no
  --    row at all. Dated INSIDE the period on purpose -- if it were dated after,
  --    this arm could not tell "no membership row" from "date too late".
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_split_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, effective_from) VALUES (%L,%L,55,45,%L::date)',
    current_setting('t3503.o_a'), current_setting('t3503.u_agent_gone'), d_in));
  PERFORM pg_temp.check(s = '42501',
    format('a broker CANNOT write for a REMOVED agent even inside the period, refused with 42501, got %s', s));

  -- 4. an ACTIVE subject: allowed, and the date is not tested for them --
  --    d_out is after the OTHER subject's deactivation and must not matter here.
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_split_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, effective_from) VALUES (%L,%L,55,45,%L::date)',
    current_setting('t3503.o_a'), current_setting('t3503.u_agent_a'), d_out));
  PERFORM pg_temp.check(s = 'OK',
    format('...and CAN for an ACTIVE agent at any date, got %s', s));

  -- and the rows landed, or did not, to match
  SELECT count(*) INTO n FROM public.agent_split_agreements
   WHERE effective_from = d_in
     AND agent_user_id = current_setting('t3503.u_agent_sus')::uuid;
  PERFORM pg_temp.check(n = 1, format('the in-period row for the deactivated subject landed, got %s', n));
  SELECT count(*) INTO n FROM public.agent_split_agreements
   WHERE effective_from = d_out
     AND agent_user_id = current_setting('t3503.u_agent_sus')::uuid;
  PERFORM pg_temp.check(n = 0, format('no out-of-period row for the deactivated subject survives, got %s', n));
  SELECT count(*) INTO n FROM public.agent_split_agreements
   WHERE agent_user_id = current_setting('t3503.u_agent_gone')::uuid
     AND effective_from = d_in;
  PERFORM pg_temp.check(n = 0, format('no row for the removed subject survives, got %s', n));
  SELECT count(*) INTO n FROM public.agent_split_agreements
   WHERE effective_from = d_out
     AND agent_user_id = current_setting('t3503.u_agent_a')::uuid;
  PERFORM pg_temp.check(n = 1, format('the row for the active subject landed, got %s', n));
END $$;
RESET ROLE;
