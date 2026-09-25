-- C19: the founder's rule -- a user who holds split agreements cannot be
-- deleted, and neither can their organization. Plus the half nobody asked for
-- and everybody gets: the BROKER WHO SET the agreement is named by set_by, so
-- they are undeletable for as long as any row they wrote survives.
--
-- IT ASSERTS THE CONSTRAINT NAME, NOT THE SQLSTATE, and it clears
-- organization_members first. Both matter, and the second is why the first is
-- possible: every fixture subject also has a membership row, and
-- organization_members carries its own foreign keys to users(id) and
-- organizations(id). A control asserting only 23503 would have gone green off
-- THOSE keys forever -- and would have stayed green if this migration's own key
-- were later written ON DELETE CASCADE. (Measured: with memberships in place,
-- 23503 is raised either way; the constraint name is what tells them apart.)
--
-- The catalog half is C20, in its own file. It was moved out after being
-- measured: inside this control it fired FIRST under every FK mutant and the
-- named assertions -- the point of the control -- never ran.
--
-- Runs as postgres throughout: this is about referential integrity, which no
-- role can talk its way past, not about policy.
DO $$
DECLARE c text; o_a uuid := current_setting('t3503.o_a')::uuid;
BEGIN
  -- remove every membership so only this migration's own keys can fire
  DELETE FROM public.organization_members;

  c := pg_temp.constraint_of(format('DELETE FROM public.users WHERE id = %L', current_setting('t3503.u_agent_a')));
  PERFORM pg_temp.check(c = 'agent_split_agreements_agent_fkey',
    format('deleting the agent is blocked by the agent key, got %s', c));

  c := pg_temp.constraint_of(format('DELETE FROM public.users WHERE id = %L', current_setting('t3503.u_agent_a2')));
  PERFORM pg_temp.check(c = 'agent_split_agreements_agent_fkey',
    format('the colleague, who holds one agreement and no membership, is blocked too, got %s', c));

  c := pg_temp.constraint_of(format('DELETE FROM public.users WHERE id = %L', current_setting('t3503.u_broker_a')));
  PERFORM pg_temp.check(c = 'agent_split_agreements_set_by_fkey',
    format('deleting the BROKER WHO WROTE the agreements is blocked by set_by, got %s', c));

  c := pg_temp.constraint_of(format('DELETE FROM public.organizations WHERE id = %L', o_a));
  PERFORM pg_temp.check(c = 'agent_split_agreements_org_fkey',
    format('deleting the organization is blocked by the org key, got %s', c));

  -- a user holding nothing is deletable: the rule is about holdings, not a
  -- blanket refusal. Without this arm the control cannot tell a working key
  -- from a database that refuses every delete.
  c := pg_temp.constraint_of(format('DELETE FROM public.users WHERE id = %L', current_setting('t3503.u_itadmin_a')));
  PERFORM pg_temp.check(c = 'OK',
    format('a user holding no agreement and no membership IS deletable, got %s', c));

  -- now take the agreements away and the franchise table's own two keys surface
  DELETE FROM public.agent_split_agreements;

  c := pg_temp.constraint_of(format('DELETE FROM public.users WHERE id = %L', current_setting('t3503.u_broker_a')));
  PERFORM pg_temp.check(c = 'organization_franchise_fees_set_by_fkey',
    format('the broker is still held by the franchise fees he set, got %s', c));

  c := pg_temp.constraint_of(format('DELETE FROM public.organizations WHERE id = %L', o_a));
  PERFORM pg_temp.check(c = 'organization_franchise_fees_org_fkey',
    format('the organization is still held by its franchise fees, got %s', c));

END $$;
