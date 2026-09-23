-- C25: what the INSERT policy's member-EXISTS does about the SUBJECT's status.
--
-- That clause is about the AGENT THE AGREEMENT IS WRITTEN FOR, and it carries
-- `AND m.license_status = 'active'` -- the founder's ruling of 2026-09-22,
-- recorded in pm_comments on BACKLOG-3503, which reversed what this migration
-- shipped first. A broker may write an agreement only FOR an ACTIVE member of
-- their organization. Both shapes of the loss refuse, by two different
-- mechanisms, and this control asserts each of them:
--   DEACTIVATED subject -- deactivateUser.ts leaves the organization_members row
--     in place at 'suspended', so the EXISTS finds a row and the STATUS TERM is
--     what refuses the write;
--   REMOVED subject     -- removeUser.ts DELETEs the row, so the EXISTS finds
--     nothing and the refusal needs no status term at all.
-- The two arms are therefore NOT redundant: each is refused by a different half
-- of the same clause, and a mutant can break one while leaving the other intact
-- (m36 does exactly that).
--
-- WHY THIS CONTROL EXISTS. SR measured (pm_comments 8efcd82e) that moving this
-- dimension -- then, ADDING the term -- reddened NONE of the 25 controls that
-- existed before this one: the dimension was invisible in both directions, on
-- the exact question the founder was being asked that week. Whichever way he
-- ruled, the change had to produce a red rather than silence. He ruled the term
-- IN; mutant m36 is now that term REMOVED, and this control is its red.
--
-- THE COST OF THE RULING, so a later reader meets it here and not in a support
-- ticket: an agent deactivated BEFORE any agreement was entered can no longer
-- have one entered, so their past closings resolve to zero rows (control C12 is
-- that shape). THERE IS NO WORKAROUND IN THE PRODUCT TODAY: for a member invited
-- through the broker portal and deactivated through it, the agreement is simply
-- UNRECORDABLE, and a route back to license_status 'active' for such a row is
-- MECHANISM UNTRACED. An earlier draft of this header named a reactivate,
-- record, deactivate route; it does not exist. The enumeration of the three
-- writers that can set an existing membership row to 'active', and why none
-- reaches such a row, is in this directory README under the subject section.
-- Taken knowingly: the founder was re-asked knowing the mitigation does not
-- exist, and the ruling stands.
--
-- BOTH DIRECTIONS ARE ASSERTED, over the same rows in the same transaction. Two
-- denials on their own cannot tell "the subject terms are doing work" from "this
-- broker cannot write at all" -- a write rule stuck at false satisfies both. The
-- active-subject arm is what separates those.
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
  -- 1. a DEACTIVATED subject: REFUSED by the status term -- 42501 specifically,
  --    because the refusal comes from the WITH CHECK. A silent zero-row no-op
  --    would raise nothing at all and "it raised" would pass. This is the
  --    assertion m36 reds.
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_commission_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, office_fee_amount, office_fee_cadence, effective_from) VALUES (%L,%L,55,45,110,%L,DATE ''2026-10-01'')',
    current_setting('t3503.o_a'), current_setting('t3503.u_agent_sus'), 'monthly'));
  PERFORM pg_temp.check(s = '42501',
    format('a broker CANNOT write an agreement for a DEACTIVATED agent, refused with 42501, got %s', s));

  -- 2. a REMOVED subject: refused too, by the EXISTS finding no row at all --
  --    the same 42501, reached without the status term being involved.
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_commission_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, office_fee_amount, office_fee_cadence, effective_from) VALUES (%L,%L,55,45,110,%L,DATE ''2026-10-02'')',
    current_setting('t3503.o_a'), current_setting('t3503.u_agent_gone'), 'monthly'));
  PERFORM pg_temp.check(s = '42501',
    format('a broker CANNOT write an agreement for a REMOVED agent, refused with 42501, got %s', s));

  -- 3. an ACTIVE subject: allowed. Without this arm the suite cannot tell
  --    working subject terms from a write rule that refuses everyone.
  s := pg_temp.sqlstate_of(format(
    'INSERT INTO public.agent_commission_agreements (organization_id, agent_user_id, agent_pct, brokerage_pct, office_fee_amount, office_fee_cadence, effective_from) VALUES (%L,%L,55,45,110,%L,DATE ''2026-10-03'')',
    current_setting('t3503.o_a'), current_setting('t3503.u_agent_a'), 'monthly'));
  PERFORM pg_temp.check(s = 'OK',
    format('...and CAN for an ACTIVE agent, got %s', s));

  -- and the rows landed, or did not, to match
  SELECT count(*) INTO n FROM public.agent_commission_agreements
   WHERE effective_from = DATE '2026-10-01';
  PERFORM pg_temp.check(n = 0, format('no row for the deactivated subject survives, got %s', n));
  SELECT count(*) INTO n FROM public.agent_commission_agreements
   WHERE effective_from = DATE '2026-10-02';
  PERFORM pg_temp.check(n = 0, format('no row for the removed subject survives, got %s', n));
  SELECT count(*) INTO n FROM public.agent_commission_agreements
   WHERE effective_from = DATE '2026-10-03'
     AND agent_user_id = current_setting('t3503.u_agent_a')::uuid;
  PERFORM pg_temp.check(n = 1, format('the row for the active subject landed, got %s', n));
END $$;
RESET ROLE;
