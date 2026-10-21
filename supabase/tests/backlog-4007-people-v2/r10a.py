#!/usr/bin/env python3
"""BACKLOG-4007 People v2 R10a control: an unlinkable LIVE billing contact of a NON-test
brokerage stops the migration. Usage: r10a.py <out.sql> [--mutant]

Runs against keepr-test AS APPLIED (20261020200000 in the ledger). The fixture needs the
pre-migration org_contacts shape (full_name / email columns, which the migration removes), so the
composed text is: rollback.py's text (back to the PR-4 state) -> fixture -> the migration ->
a trailing RAISE. It is ONE kt-sql call and every statement ends in a RAISE, so nothing persists
(the rollback included).
Fixture: one organization (is_test false) with a live billing contact whose email is no member's.
Expected: the migration raises '4007 People v2: live billing contact'. With --mutant the is_test
term is replaced by false (exact-once, MUTATION APPLIED printed); expected: the trailing
'R10A_NO_RAISE' is reached."""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
import rollback  # noqa: E402
mig = open(os.path.join(here, '..', '..', 'migrations', '20261020200000_backlog_4007_people_v2.sql')).read()
if '--mutant' in sys.argv:
    old = "IF c.role = 'billing' AND c.removed_at IS NULL AND NOT coalesce(c.is_test, false) THEN"
    assert mig.count(old) == 1
    mig = mig.replace(old, "IF c.role = 'billing' AND c.removed_at IS NULL AND false THEN")
    print('MUTATION APPLIED r10a: is_test term -> false')
fx = """DO $fx$ DECLARE o uuid := gen_random_uuid(); BEGIN
  INSERT INTO public.organizations (id, name, slug, max_seats, is_test) VALUES (o, 'P4007V R10a', 'p4007v-r10a-' || left(o::text, 8), 5, false);
  INSERT INTO public.org_contacts (organization_id, role, full_name, email) VALUES (o, 'billing', 'P4007V Nobody', 'p4007v-nobody@example.test');
END $fx$;
"""
open(sys.argv[1], 'w').write(rollback.compose() + '\n' + fx + mig + "\nDO $$ BEGIN RAISE EXCEPTION 'R10A_NO_RAISE'; END $$;\n")
print(sys.argv[1])
