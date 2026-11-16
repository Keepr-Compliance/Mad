#!/usr/bin/env python3
"""BACKLOG-4257 PR A mutations. For each mode: exact-string replace on the migration (or rollback)
FILE, each fragment required to match exactly the stated number of times (else exit), print
MUTATION APPLIED + the changed lines + `git diff --numstat`, run run.sh (the SR R2 composition: one
keepr-test transaction ending in RAISE, so nothing persists), print the reds, then restore the file
with `git checkout --` and assert it is clean.
Commit the migration and rollback BEFORE running this: the restore is a checkout.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
"""
import json, os, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
MIG = 'supabase/migrations/20261117120000_backlog_4257_learn_pilot_signals.sql'
RB = 'supabase/tests/backlog-4257/rollback-4257.sql'

BRANCH = "  IF p->'schema' = '2'::jsonb THEN\n"
MUT = {
  # S1: the signals block's own key list is a superset check, not exact
  'S1_signals_keys_superset': [(MIG, "    IF NOT public._sender_rule_set_keys_exact(s, ARRAY['signals_version', 'terms_version',",
                                "    IF NOT (s ?& ARRAY['signals_version', 'terms_version',", 1)],
  # S2: a schema 2 whose signals pass is accepted without the schema-1 checks
  'S2_base_unchecked': [(MIG, "    RETURN public._learn_pilot_report_invalid((p - 'signals') || '{\"schema\": 1}'::jsonb);\n",
                         "    RETURN NULL;\n", 1)],
  # S3: 'signals' stripped from every report before the schema-1 checks
  'S3_strip_signals_always': [(MIG, "  IF octet_length(p::text) > 32768 THEN\n",
                               "  p := p - 'signals';\n  IF octet_length(p::text) > 32768 THEN\n", 1)],
  # S4: an unknown signals_version is accepted
  'S4_unknown_version_accepted': [(MIG, "  ELSE\n    RETURN 'signals_version';\n", "  ELSE\n    RETURN NULL;\n", 1)],
  # S5: the new validator keeps the default grants
  'S5_signals_revoke_dropped': [(MIG, "REVOKE EXECUTE ON FUNCTION public._learn_pilot_signals_invalid(JSONB) FROM PUBLIC, anon, authenticated;\n", "", 1)],
  # C3b: 'signals' required in every schema (schema 1 included)
  'C3b_signals_required_always': [(MIG, BRANCH, "  IF NOT p ? 'signals' THEN\n    RETURN 'signals';\n  END IF;\n" + BRANCH, 1)],
  # C9: the schema-2 cap is the schema-1 cap
  'C9_schema2_cap_32768': [(MIG, "    IF octet_length(p::text) > 65536 THEN\n", "    IF octet_length(p::text) > 32768 THEN\n", 1)],
}


def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, cwd=root)


if sh('git', 'status', '--porcelain', '--', MIG, RB).stdout.strip():
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
        st = subprocess.run([sys.executable, os.path.join(here, 'static.py')], capture_output=True, text=True)
        print('STATIC ' + ((st.stdout.strip().splitlines() or ['(crashed: ' + st.stderr.strip().splitlines()[-1] + ')'])[-1]))
        out = subprocess.run([os.path.join(here, 'run.sh')], capture_output=True, text=True)
        o = out.stdout
        try:
            d = json.loads(o[o.index('{'):o.rindex('}') + 1])
            print('RESULT total=%s pass=%s fail=%s reds=%s' % (d['total'], d['pass'], d['fail'], ','.join(sorted(d['reds']))))
            for k in sorted(d['reds']):
                print('   %s: %s' % (k, d['reds'][k][:160]))
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
