-- C25: what the INSERT policy's member-EXISTS does about the SUBJECT's status.
--
-- That clause is about the AGENT THE AGREEMENT IS WRITTEN FOR, and it carries no
-- license_status term. The founder's ruling took the READ away from a
-- deactivated or removed agent; it said nothing about writing FOR one. So the
-- shipped behaviour splits by the shape of the loss, and the split is an
-- accident of which clause happens to notice:
--   DEACTIVATED subject -- the organization_members row survives at 'suspended',
--     so the EXISTS finds it and the broker CAN write the agreement;
--   REMOVED subject     -- removeUser.ts DELETEs the row, so the EXISTS finds
--     nothing and the write is REFUSED, without any status term being involved.
--
-- WHY THIS CONTROL EXISTS. SR measured (pm_comments 8efcd82e) that adding
-- `AND m.license_status = 'active'` to that EXISTS reddened NONE of the 24
-- controls that existed before this one: the dimension was invisible in both
-- directions, on the exact question the founder is being asked this week.
-- Whichever way he rules, the change must now produce a red rather than silence.
-- Mutant m36 is that change -- SR's `msr01` probe, promoted into the suite.
--
-- BOTH DIRECTIONS ARE ASSERTED, over the same rows in the same transaction. A
-- denial on its own cannot tell "the subject term is doing work" from "this
-- broker cannot write at all" -- a write rule stuck at false satisfies it. The
-- two OK arms are what separate those.
--
-- The failure messages name the SHAPE, never a fixture uuid: they land in
-- mutant-run.txt, which is committed (scripts/ci/check-fixture-pii.mjs).

-- precondition, read as postgres: the three subjects are in the three states
DO $$
DECLARE st text; n int;
BEGIN
  SELECT license_status INTO st FROM public.organization_members
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_sus')::uuid;
  PERFORM pg_temp.check(st = 'suspended',
    format('precondition: the deactivated subject still has an org-A row, at suspended, got %s', coalesce(st, 'NO MEMBERSHIP ROW')));

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

-- the ACTIVE broker of that organization writes for all three subjects
SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE s text; n int;
BEGIN
  -- 1. a DEACTIVATED subject: allowed today. This is the assertion m36 reds.
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_commission_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, office_fee_amount, office_fee_cadence, effective_from) VALUES (%L,%L,55,45,110,%L,DATE ''2026-10-01'')',
    current_setting('t3503.o_a'), current_setting('t3503.u_agent_sus'), 'monthly'));
  PERFORM pg_temp.check(s = 'OK',
    format('a broker CAN write an agreement for a DEACTIVATED agent, got %s', s));

  -- 2. a REMOVED subject: refused, by the EXISTS finding no row -- 42501
  --    specifically, because the refusal comes from the WITH CHECK. A silent
  --    zero-row no-op would raise nothing at all and "it raised" would pass.
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_commission_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, office_fee_amount, office_fee_cadence, effective_from) VALUES (%L,%L,55,45,110,%L,DATE ''2026-10-02'')',
    current_setting('t3503.o_a'), current_setting('t3503.u_agent_gone'), 'monthly'));
  PERFORM pg_temp.check(s = '42501',
    format('a broker CANNOT write an agreement for a REMOVED agent, refused with 42501, got %s', s));

  -- 3. an ACTIVE subject: allowed. Without this arm the suite cannot tell a
  --    working subject term from a write rule that refuses everyone.
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_commission_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, office_fee_amount, office_fee_cadence, effective_from) VALUES (%L,%L,55,45,110,%L,DATE ''2026-10-03'')',
    current_setting('t3503.o_a'), current_setting('t3503.u_agent_a'), 'monthly'));
  PERFORM pg_temp.check(s = 'OK',
    format('...and for an ACTIVE agent, got %s', s));

  -- and the rows landed, or did not, to match
  SELECT count(*) INTO n FROM public.agent_commission_agreements
   WHERE effective_from = DATE '2026-10-01'
     AND agent_user_id = current_setting('t3503.u_agent_sus')::uuid;
  PERFORM pg_temp.check(n = 1, format('the deactivated subject1s row landed, got %s', n));
  SELECT count(*) INTO n FROM public.agent_commission_agreements
   WHERE effective_from = DATE '2026-10-02';
  PERFORM pg_temp.check(n = 0, format('no row for the removed subject survives, got %s', n));
  SELECT count(*) INTO n FROM public.agent_commission_agreements
   WHERE effective_from = DATE '2026-10-03'
     AND agent_user_id = current_setting('t3503.u_agent_a')::uuid;
  PERFORM pg_temp.check(n = 1, format('the active subject1s row landed, got %s', n));
END $$;
RESET ROLE;
