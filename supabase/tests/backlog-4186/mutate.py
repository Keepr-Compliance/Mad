#!/usr/bin/env python3
"""BACKLOG-4186 PR A mutations. For each mode: exact-string replace on the migration FILE, each
fragment required to match exactly the stated number of times (else exit), print MUTATION APPLIED
+ the changed lines + `git diff --numstat`, run the controls (one keepr-test transaction ending in
RAISE, so nothing persists), print the reds, then restore the file with `git checkout --` and
assert it is clean. Commit the migration BEFORE running this: the restore is a checkout.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
"""
import os, subprocess, sys, json
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
MIG = 'supabase/migrations/20261109210000_backlog_4186_sender_rule_set_reads.sql'
RB = 'supabase/tests/backlog-4186/rollback-4186.sql'

COND = "v_uid IS NULL OR public.report_my_access('sender-rules') IS NULL"
# mode -> list of (file, old, new, expected match count)
MUT = {
  'R1_owner_only_read': [(MIG, COND, "v_uid IS NULL OR public.report_my_access('sender-rules') IS DISTINCT FROM 'owner'", 2)],
  'R1b_not_in': [(MIG, COND, "v_uid IS NULL OR public.report_my_access('sender-rules') NOT IN ('viewer', 'editor', 'owner')", 2)],
  'R1b_ne_owner': [(MIG, COND, "v_uid IS NULL OR public.report_my_access('sender-rules') <> 'owner'", 2)],
  'R1b_not_positive': [(MIG, COND, "NOT (v_uid IS NOT NULL AND public.report_my_access('sender-rules') IN ('viewer', 'editor', 'owner'))", 2)],
  'R1b_state_only_not_in': [(MIG, COND + " THEN\n    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';\n  END IF;\n\n  RETURN jsonb_build_object(",
      "v_uid IS NULL OR public.report_my_access('sender-rules') NOT IN ('viewer', 'editor', 'owner') THEN\n    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';\n  END IF;\n\n  RETURN jsonb_build_object(", 1)],
  'R2_revokes_dropped': [(MIG, "REVOKE EXECUTE ON FUNCTION public.sender_rule_set_admin_state() FROM PUBLIC, anon;\n", "", 1),
                         (MIG, "REVOKE EXECUTE ON FUNCTION public.sender_rule_set_admin_content(BIGINT) FROM PUBLIC, anon;\n", "", 1)],
  'R2_content_revoke_dropped': [(MIG, "REVOKE EXECUTE ON FUNCTION public.sender_rule_set_admin_content(BIGINT) FROM PUBLIC, anon;\n", "", 1)],
  'R2_anon_only_revoke': [(MIG, "REVOKE EXECUTE ON FUNCTION public.sender_rule_set_admin_state() FROM PUBLIC, anon;", "REVOKE EXECUTE ON FUNCTION public.sender_rule_set_admin_state() FROM anon;", 1)],
  'R3_published_by': [(MIG, "'published_at', x.published_at)", "'published_at', x.published_at, 'published_by', x.published_by)", 1),
                      (MIG, "o.name AS canary_org_name, s.published_at\n", "o.name AS canary_org_name, s.published_at, s.published_by\n", 1)],
  'R3_pinned_by': [(MIG, "'pinned_at', p.pinned_at)", "'pinned_at', p.pinned_at, 'pinned_by', p.pinned_by)", 1)],
  'R4_pins_from_canary_org': [(MIG, "       FROM public.sender_rule_set_pins p\n",
      "       FROM (SELECT k.canary_org AS org_id, k.version, k.published_at AS pinned_at FROM public.sender_rule_sets k WHERE NOT k.released) p\n", 1)],
  'R5_released_is_max': [(MIG, "(SELECT max(r.version) FROM public.sender_rule_sets r WHERE r.released)", "(SELECT max(r.version) FROM public.sender_rule_sets r)", 1)],
  'R6_inner_join_org': [(MIG, "         LEFT JOIN public.organizations o ON o.id = s.canary_org\n", "         JOIN public.organizations o ON o.id = s.canary_org\n", 1)],
  'R6_pin_inner_join': [(MIG, "       LEFT JOIN public.organizations po ON po.id = p.org_id)", "       JOIN public.organizations po ON po.id = p.org_id)", 1)],
  'R7_no_limit': [(MIG, "         LIMIT 200\n", "", 1)],
  'R7_truncated_ge': [(MIG, "(SELECT count(*) FROM public.sender_rule_sets t) > 200", "(SELECT count(*) FROM public.sender_rule_sets t) >= 200", 1)],
  'R7_truncated_false': [(MIG, "(SELECT count(*) FROM public.sender_rule_sets t) > 200", "false", 1)],
  'R7_oldest_first': [(MIG, "         ORDER BY s.version DESC\n         LIMIT 200\n", "         ORDER BY s.version ASC\n         LIMIT 200\n", 1)],
  'C1_content_ignores_version': [(MIG, "WHERE c.version = p_version", "WHERE c.released ORDER BY c.version DESC LIMIT 1", 1)],
  'RB_misses_content': [(RB, "DROP FUNCTION IF EXISTS public.sender_rule_set_admin_content(BIGINT);\n", "", 1)],
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
