-- C20: the five foreign keys exist and every one is ON DELETE NO ACTION, read
-- off the catalog rather than inferred from a refusal.
--
-- Why it is a separate file from C19. It started life as C19's last assertion.
-- Measured: under every FK mutant it fired FIRST and C19's named assertions --
-- the reason C19 exists -- never ran. Splitting it gives both controls their own
-- red, which is the only way either is specified.
--
-- What it adds over C19, stated honestly: not much, and it cannot be given an
-- ISOLATED red. Postgres has no way to change an existing key's delete action in
-- place; every mutation must DROP and re-ADD the constraint, and that also moves
-- the constraint's referential-integrity trigger to the end of the firing order,
-- which C19's named assertions see. So every FK mutant reddens both controls.
-- It is kept because it states the rule directly -- a reader wanting to know the
-- delete action does not have to derive it from which error a delete raises --
-- and because it names the two keys C19 exercises only indirectly.
--
-- confdeltype: 'a' NO ACTION, 'r' RESTRICT, 'c' CASCADE, 'n' SET NULL,
-- 'd' SET DEFAULT.
DO $$
DECLARE k text; d char;
BEGIN
  FOREACH k IN ARRAY ARRAY['agent_commission_agreements_org_fkey',
                           'agent_commission_agreements_agent_fkey',
                           'agent_commission_agreements_set_by_fkey',
                           'organization_franchise_fees_org_fkey',
                           'organization_franchise_fees_set_by_fkey'] LOOP
    SELECT confdeltype INTO d FROM pg_constraint WHERE conname = k AND contype = 'f';
    PERFORM pg_temp.check(d = 'a',
      format('%s is a foreign key ON DELETE NO ACTION, got %s', k, coalesce(d::text, 'no such constraint')));
  END LOOP;
  -- and nothing else in this migration carries a delete action at all
  PERFORM pg_temp.check(
    (SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname IN ('agent_commission_agreements','organization_franchise_fees')
        AND c.contype = 'f') = 5,
    'the two tables carry exactly five foreign keys between them');
END $$;
