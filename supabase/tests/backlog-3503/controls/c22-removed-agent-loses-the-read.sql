-- C22: a REMOVED agent reads none of their own agreement rows, and the broker of
-- that organization still reads every one of them.
--
-- Removal is a hard delete of the membership row:
-- broker-portal/lib/actions/removeUser.ts DELETEs from organization_members. The
-- user account survives, so agent_user_id still matches a live public.users row
-- and the agreement is untouched -- a bare `agent_user_id = auth.uid()` policy
-- would keep serving them (mutant m32).
--
-- u_agent_gone is still an ACTIVE member of org B. That is what makes this
-- control able to see mutant m34, a read rule that asks "is the caller an active
-- member of some organization" instead of "of THIS organization": under m34 the
-- org-B membership answers yes and the org-A row leaks.

-- precondition, read as postgres
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.organization_members
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_gone')::uuid;
  PERFORM pg_temp.check(n = 0, format('precondition: no org-A membership row survives, got %s', n));
  SELECT count(*) INTO n FROM public.organization_members
   WHERE organization_id = current_setting('t3503.o_b')::uuid
     AND user_id = current_setting('t3503.u_agent_gone')::uuid
     AND license_status = 'active';
  PERFORM pg_temp.check(n = 1, format('precondition: they are still an active member of org B, got %s', n));
  SELECT count(*) INTO n FROM public.agent_commission_agreements
   WHERE agent_user_id = current_setting('t3503.u_agent_gone')::uuid;
  PERFORM pg_temp.check(n = 1, format('precondition: their org-A agreement survives removal, got %s', n));
END $$;

-- the removed agent themselves
SELECT pg_temp.act_as(current_setting('t3503.u_agent_gone')::uuid);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.agent_commission_agreements;
  -- unqualified on purpose; see C21. u_agent_gone is an active member of org B,
  -- so a mutant that makes 'agent' a writer role leaks org B's row through here,
  -- not their own -- hence "anywhere" rather than a claim about their row.
  PERFORM pg_temp.check(n = 0, format('a removed agent reads 0 agreement rows anywhere, got %s', n));
  SELECT count(*) INTO n FROM public.commission_agreement_in_force(
    current_setting('t3503.o_a')::uuid, current_setting('t3503.u_agent_gone')::uuid, DATE '2026-09-01');
  PERFORM pg_temp.check(n = 0, format('...and 0 through commission_agreement_in_force, got %s', n));
END $$;
RESET ROLE;

-- the broker of that organization is unaffected
SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.agent_commission_agreements
   WHERE agent_user_id = current_setting('t3503.u_agent_gone')::uuid;
  PERFORM pg_temp.check(n = 1, format('the broker still reads the removed agent1s row, got %s', n));
  SELECT count(*) INTO n FROM public.commission_agreement_in_force(
    current_setting('t3503.o_a')::uuid, current_setting('t3503.u_agent_gone')::uuid, DATE '2026-09-01');
  PERFORM pg_temp.check(n = 1, format('...and 1 through commission_agreement_in_force, got %s', n));
END $$;
RESET ROLE;
