-- C21: a DEACTIVATED agent reads none of their own agreement rows, and the
-- broker of that organization still reads every one of them.
--
-- Deactivation is a soft delete: broker-portal/lib/actions/deactivateUser.ts
-- leaves the organization_members row in place and moves license_status to
-- 'suspended'. So the membership row is present and the agent_user_id still
-- matches -- which is exactly why a bare `agent_user_id = auth.uid()` policy
-- would keep serving them. Mutant m32 is that bare predicate; mutant m33 is the
-- narrower miss, a membership term with no license_status filter.
--
-- The fixture state is asserted first. A zero that comes from a typo'd uuid or a
-- missing row proves nothing, and would look identical from here.

-- precondition, read as postgres: the agent is suspended and holds one row
DO $$
DECLARE st text; n int;
BEGIN
  SELECT license_status INTO st FROM public.organization_members
   WHERE organization_id = current_setting('t3503.o_a')::uuid
     AND user_id = current_setting('t3503.u_agent_sus')::uuid;
  PERFORM pg_temp.check(st = 'suspended',
    format('precondition: the deactivated agent is suspended, got %s', coalesce(st, 'NO MEMBERSHIP ROW')));
  SELECT count(*) INTO n FROM public.agent_commission_agreements
   WHERE agent_user_id = current_setting('t3503.u_agent_sus')::uuid;
  PERFORM pg_temp.check(n = 1, format('precondition: they hold exactly 1 agreement row, got %s', n));
END $$;

-- the agent themselves
SELECT pg_temp.act_as(current_setting('t3503.u_agent_sus')::uuid);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.agent_commission_agreements;
  -- unqualified on purpose: the claim is that they read NOTHING, not merely that
  -- they cannot read their own row. The message says "anywhere" because the row
  -- a mutant lets through is not always theirs -- under m17r it is another org's.
  PERFORM pg_temp.check(n = 0, format('a deactivated agent reads 0 agreement rows anywhere, got %s', n));
  -- and through the read path BACKLOG-3504 uses
  SELECT count(*) INTO n FROM public.commission_agreement_in_force(
    current_setting('t3503.o_a')::uuid, current_setting('t3503.u_agent_sus')::uuid, DATE '2026-09-01');
  PERFORM pg_temp.check(n = 0, format('...and 0 through commission_agreement_in_force, got %s', n));
END $$;
RESET ROLE;

-- the broker of that organization is unaffected
SELECT pg_temp.act_as(current_setting('t3503.u_broker_a')::uuid);
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.agent_commission_agreements
   WHERE agent_user_id = current_setting('t3503.u_agent_sus')::uuid;
  PERFORM pg_temp.check(n = 1, format('the broker still reads the deactivated agent1s row, got %s', n));
  SELECT count(*) INTO n FROM public.commission_agreement_in_force(
    current_setting('t3503.o_a')::uuid, current_setting('t3503.u_agent_sus')::uuid, DATE '2026-09-01');
  PERFORM pg_temp.check(n = 1, format('...and 1 through commission_agreement_in_force, got %s', n));
END $$;
RESET ROLE;
