#!/usr/bin/env python3
"""BACKLOG-4179: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> <mode> [--mig-only]
  base               migration + controls.sql. Ends in RAISE: nothing persists.
  M_active_only      G1 mutant: the guard counts only active rows (the most likely wrong build).
  M_insert_only      G2 mutant: trigger on INSERT only.
  M_org_exclusion    G4 mutant: the other-row test excludes by organization instead of by row.
  M_no_lock          G3/G5 mutant (concurrency.sh): the advisory lock is dropped.
  M_no_retire        G6 mutant: retire_personal_membership disabled in the transaction.
  G7                 a seeded duplicate (two brokerage rows) BEFORE the migration: the pre-check raises.
  live               controls.sql only, against the venue as it is (after the committed apply).
  --mig-only         just the (mutated) migration, no controls, no final RAISE (concurrency.sh).
A mutation is an exact, once-only replacement; it must change the text, else the script exits 2.
Function/trigger mutants drop the migration's POSTCHECK block (it would refuse the mutant).
"""
import difflib, os, re, sys

here = os.path.dirname(os.path.abspath(__file__))
MIG = os.path.join(here, '..', '..', 'migrations', '20261112121000_backlog_4179_one_brokerage_guard.sql')
STATS = "SET LOCAL pg_stat_statements.track = 'none';\n"

MUTANTS = {
    'M_active_only': [('       AND m.id <> NEW.id\n',
                       "       AND m.id <> NEW.id\n       AND m.license_status = 'active'\n")],
    'M_insert_only': [('  BEFORE INSERT OR UPDATE OF user_id, organization_id ON public.organization_members\n',
                       '  BEFORE INSERT ON public.organization_members\n')],
    'M_org_exclusion': [('       AND m.id <> NEW.id\n', '       AND m.organization_id <> NEW.organization_id\n')],
    'M_no_lock': [('  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text, 3364));\n', '')],
}
MODE_SQL = {
    'M_no_retire': 'ALTER TABLE public.organization_members DISABLE TRIGGER retire_personal_membership;\n',
}
SEED_G7 = """
INSERT INTO auth.users (id, email, instance_id, aud, role)
  VALUES (md5('bl4179:g7')::uuid, 'g7@k-4179.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
INSERT INTO public.organizations (id, name, slug, is_test, max_seats) VALUES
  (md5('bl4179:A_g7')::uuid, 'Brokerage A_g7 4179', 'b4179-a-g7', true, 10),
  (md5('bl4179:B_g7')::uuid, 'Brokerage B_g7 4179', 'b4179-b-g7', true, 10);
INSERT INTO public.organization_members (organization_id, user_id, role, license_status) VALUES
  (md5('bl4179:A_g7')::uuid, md5('bl4179:g7')::uuid, 'agent', 'active'),
  (md5('bl4179:B_g7')::uuid, md5('bl4179:g7')::uuid, 'agent', 'suspended');
"""


def strip_postcheck(t):
    a = t.index('-- POSTCHECK BEGIN\n') + len('-- POSTCHECK BEGIN\n')
    b = t.index('-- POSTCHECK END')
    return t[:a] + t[b:]


def mutate(mig, mode):
    m = mig
    for old, new in MUTANTS[mode]:
        n = m.count(old)
        if n != 1:
            print(f'MUTATION NOT APPLIED: {mode}: pattern found {n} times', file=sys.stderr)
            sys.exit(2)
        m = m.replace(old, new)
    m = strip_postcheck(m)
    if m == strip_postcheck(mig):
        print(f'MUTATION NOT APPLIED: {mode}: text unchanged', file=sys.stderr)
        sys.exit(2)
    diff = [l for l in difflib.unified_diff(strip_postcheck(mig).splitlines(), m.splitlines(), lineterm='', n=0)
            if l[:1] in '+-' and not l.startswith(('+++', '---'))]
    print(f'MUTATION APPLIED {mode}: ' + ' | '.join(diff)[:400])
    return m


out, mode = sys.argv[1], sys.argv[2]
mig_only = '--mig-only' in sys.argv[3:]
mig = open(MIG).read()
ctl = open(os.path.join(here, 'controls.sql')).read()

if mode in MUTANTS:
    mig = mutate(mig, mode)
elif mode in MODE_SQL:
    marker = '-- __MODE__\n'
    if ctl.count(marker) != 1:
        print(f'MUTATION NOT APPLIED: {mode}: marker found {ctl.count(marker)} times', file=sys.stderr)
        sys.exit(2)
    ctl = ctl.replace(marker, marker + MODE_SQL[mode])
    print(f'MUTATION APPLIED {mode}: + {MODE_SQL[mode].strip()}')
elif mode not in ('base', 'G7', 'live'):
    print(f'unknown mode {mode}', file=sys.stderr)
    sys.exit(2)

head = STATS + f"SELECT set_config('p4179.mode', '{mode}', true);\n"
if mig_only:
    text = head + mig
elif mode == 'live':
    text = head + ctl
elif mode == 'G7':
    text = head + SEED_G7 + mig
else:
    text = head + mig + '\n' + ctl
if not mig_only:
    text += "\nDO $end$ BEGIN RAISE EXCEPTION 'P4179_END_NO_RESULT'; END $end$;\n"
assert not re.search(r'^\s*COMMIT\b', text, re.I | re.M), 'COMMIT statement in composed text'
open(out, 'w').write(text)
