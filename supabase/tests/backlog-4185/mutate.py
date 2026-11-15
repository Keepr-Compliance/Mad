#!/usr/bin/env python3
"""BACKLOG-4185 PR A mutations. For each mode: exact-string replace on the migration FILE or on the
mutations.sql slot, each fragment required to match exactly the stated number of times (else exit),
print MUTATION APPLIED + the changed lines + `git diff --numstat`, run the controls (one keepr-test
transaction ending in RAISE, so nothing persists), print the reds, then restore with
`git checkout --` and assert the tree is clean. Commit BEFORE running this: the restore is a checkout.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
"""
import os, subprocess, sys, json
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
MIG = 'supabase/migrations/20261112150000_backlog_4185_device_hardware_profile.sql'
MU = 'supabase/tests/backlog-4185/mutations.sql'
RB = 'supabase/tests/backlog-4185/rollback-4185.sql'
SLOT = '-- MUTATION SLOT\n'
POL = 'ALTER POLICY "Users can update own devices" ON public.devices '
OWN = '(( SELECT auth.uid() AS uid) = user_id)'
SIZE = "octet_length(hardware_profile::text) <= 8192"
CHK_START = "DO $mig$\nBEGIN\n"
# mode -> list of (file, old, new, expected match count)
MUT = {
  # policy-state mutations (the DB the migration lands on)
  'P1_extra_open_update_policy': [(MU, SLOT, 'CREATE POLICY p4185_open_update ON public.devices FOR UPDATE TO authenticated USING (true);\n', 1)],
  'P1b_extra_open_all_policy': [(MU, SLOT, 'CREATE POLICY p4185_open_all ON public.devices FOR ALL TO authenticated USING (true) WITH CHECK (true);\n', 1)],
  'P2_widened_own_row_using': [(MU, SLOT, POL + "USING (" + OWN + " OR (( SELECT report_my_access('analytics'::text)) IS NOT NULL));\n", 1)],
  'P3_with_check_true': [(MU, SLOT, POL + 'WITH CHECK (true);\n', 1)],
  'P4_rls_disabled': [(MU, SLOT, 'ALTER TABLE public.devices DISABLE ROW LEVEL SECURITY;\n', 1)],
  'P5_definer_writer_rpc': [(MU, SLOT, "CREATE FUNCTION public.p4185_set_profile(p_user uuid, p jsonb) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS 'UPDATE public.devices SET hardware_profile = p WHERE user_id = p_user';\n", 1)],
  'P6_truncate_granted': [(MU, SLOT, 'GRANT TRUNCATE ON public.devices TO authenticated;\n', 1)],
  # migration-file mutations
  'M1_no_shape_check': [(MIG, "    ALTER TABLE public.devices\n      ADD CONSTRAINT devices_hardware_profile_shape CHECK (\n        hardware_profile IS NULL\n        OR (jsonb_typeof(hardware_profile) = 'object'\n            AND octet_length(hardware_profile::text) <= 8192)\n      );\n", "    NULL;\n", 1)],
  'M2_pg_column_size': [(MIG, SIZE, "pg_column_size(hardware_profile) <= 8192", 1)],
  'M3_strict_lt': [(MIG, SIZE, "octet_length(hardware_profile::text) < 8192", 1)],
  'M4_bound_off_by_one': [(MIG, SIZE, "octet_length(hardware_profile::text) <= 8193", 1)],
  'M5_arrays_allowed': [(MIG, "(jsonb_typeof(hardware_profile) = 'object'\n            AND ", "(", 1)],
  'M6_default_empty_object': [(MIG, "ADD COLUMN IF NOT EXISTS hardware_profile jsonb,", "ADD COLUMN IF NOT EXISTS hardware_profile jsonb DEFAULT '{}'::jsonb,", 1)],
  'M7_not_idempotent_constraint': [(MIG, "  IF NOT EXISTS (\n    SELECT 1 FROM pg_constraint\n    WHERE conrelid = 'public.devices'::regclass\n      AND conname = 'devices_hardware_profile_shape'\n  ) THEN\n", "  IF true THEN\n", 1)],
  'M8_no_profile_updated_at': [(MIG, ",\n  ADD COLUMN IF NOT EXISTS profile_updated_at timestamptz;", ";", 1)],
  'RB_misses_columns': [(RB, "ALTER TABLE public.devices DROP COLUMN IF EXISTS hardware_profile, DROP COLUMN IF EXISTS profile_updated_at;\n", "", 1)],
}

def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, cwd=root)

if sh('git', 'status', '--porcelain', '--', MIG, MU, RB).stdout.strip():
    sys.exit('migration/rollback have uncommitted changes; commit before mutating')

modes = list(MUT) if sys.argv[1] == 'all' else sys.argv[1].split(',')
for mode in modes:
    files = sorted({f for f, *_ in MUT[mode]})
    try:
        for fn, old, new, cnt in MUT[mode]:
            path = os.path.join(root, fn)
            body = open(path).read()
            n = body.count(old)
            if n != cnt:
                print('== %s\nMUTATION NOT APPLIED: fragment matched %d times (expected %d)' % (mode, n, cnt))
                raise SystemExit(2)
            open(path, 'w').write(body.replace(old, new))
        ns = sh('git', 'diff', '--numstat', '--', *files).stdout.strip()
        if not ns:
            print('== %s\nMUTATION NOT APPLIED: git diff empty' % mode)
            raise SystemExit(2)
        changed = [l for l in sh('git', 'diff', '-U0', '--', *files).stdout.splitlines()
                   if l[:1] in '+-' and not l.startswith(('+++', '---'))]
        print('== %s' % mode)
        print('MUTATION APPLIED numstat=%s' % ' '.join(x.split('\t')[0] + '/' + x.split('\t')[1] for x in ns.splitlines()))
        for l in changed:
            print('  %s %s' % (l[0], l[1:].strip()[:150]))
        out = subprocess.run([os.path.join(here, 'run.sh')], capture_output=True, text=True)
        o = out.stdout
        try:
            d = json.loads(o[o.index('{'):o.rindex('}') + 1])
            print('RESULT total=%s pass=%s fail=%s reds=%s' % (d['total'], d['pass'], d['fail'], ','.join(sorted(d['reds']))))
            if not d['total']:
                print('ZERO CONTROLS RAN')
        except Exception:
            print('NO RESULT ' + o[:400].replace('\n', ' ') + out.stderr[:200])
    finally:
        sh('git', 'checkout', '--', *files)
        st = sh('git', 'status', '--porcelain', '--', *files).stdout.strip()
        print('RESTORED clean=%s' % (st == ''))
        if st:
            sys.exit('restore failed')
