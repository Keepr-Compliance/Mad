#!/usr/bin/env python3
"""BACKLOG-4238 two-session mutants: one function each, for run-concurrency.sh on a committed apply.

Usage: mutants.py list
       mutants.py emit <outdir>      writes, per mode, <mode>.mutant.sql and <mode>.pristine.sql, plus
                                     md5.sql (catalog md5(prosrc) and ACL of every target function)
                                     and expected.json (pristine and mutant md5 per mode)

Each fragment is an exact string that must match the migration at HEAD exactly once AND the target
function exactly once, else the script exits non-zero. Each emitted file is one CREATE OR REPLACE of
the one function (with its REVOKE/GRANT lines from the migration) followed by a check that raises
unless the catalog md5(prosrc) equals the expected value, so a wrong text is rolled back in the same
call. The mutant observed values below are PREDICTED from the code; none has been run.
"""
import hashlib, json, os, re, subprocess, sys

here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
MIG = 'supabase/migrations/20261112170000_backlog_4238_mcp_oauth_server.sql'


def head_text(path):
    return subprocess.check_output(['git', '-C', root, 'show', 'HEAD:' + path], text=True)


def span(text, start, end):
    """The exact substring from `start` through `end` (each must occur once)."""
    assert text.count(start) == 1 and text.count(end) == 1, (start, end)
    i = text.index(start)
    j = text.index(end, i) + len(end)
    return text[i:j]


T = head_text(MIG)
M18_OLD = "     AND k.used_at IS NULL\n     AND k.expires_at > now()\n  RETURNING k.* INTO v_code;"

# mode: (case, function name, [(old, new)], correct observed, predicted mutant observed)
MODES = {
  'M18_code_reusable': ('D7c', 'mcp_exchange_code', [(M18_OLD, M18_OLD.replace("     AND k.used_at IS NULL\n", ''))],
    'responses invalid_grant,ok; events {code_replay:1, reconnect_replaced:1}; connections null -> PASS',
    'second redemption re-reads the code, activation finds the connection active -> invalid_grant without a delete; '
    'events {reconnect_replaced:1}; connections {active:1} -> FAIL'),
  'S_D13b_bump_no_lock_timeout': ('D13b', '_mcp_bump', [("  PERFORM set_config('lock_timeout', '1000ms', true);\n", '')],
    'response busy; elapsed < 3000 ms; outcomes {busy:1} -> PASS',
    'the call waits for the holder (about 5 s; session lock_timeout is 0) and counts: response ok; elapsed >= 4000 ms; outcomes {ok:1} -> FAIL'),
  'S_D14_bump_limit_plus_10': ('D14', '_mcp_bump', [('  IF v_n <= p_limit THEN\n', '  IF v_n <= p_limit + 10 THEN\n')],
    'ok <= 30; ok + rate_limited + busy = 40; 40 call rows -> PASS',
    'up to 40 ok: ok = 40 - busy, > 30 whenever busy < 10 -> FAIL; not distinguishable when busy >= 10'),
}

def function_unit(text, name):
    """(full CREATE ... $tag$; text plus its REVOKE/GRANT lines, prosrc, signature for regprocedure)."""
    start_pat = 'CREATE OR REPLACE FUNCTION public.%s(' % name
    assert text.count(start_pat) == 1, (name, text.count(start_pat))
    i = text.index(start_pat)
    m = re.compile(r'AS (\$[a-z0-9_]*\$)').search(text, i)
    tag = m.group(1)
    b0 = m.end()
    b1 = text.index(tag, b0)
    end = b1 + len(tag) + 1
    assert text[end - 1] == ';', name
    unit = text[i:end] + '\n'
    rest = text[end:].lstrip('\n').split('\n')
    acl = []
    for line in rest:
        if re.match(r'(REVOKE|GRANT) .* ON FUNCTION public\.%s\(' % re.escape(name), line):
            acl.append(line)
        else:
            break
    assert acl, name
    sig = re.search(r'ON FUNCTION (public\.%s\([^)]*\))' % re.escape(name), acl[0]).group(1)
    return unit + '\n'.join(acl) + '\n', text[b0:b1], sig


def md5(s):
    return hashlib.md5(s.encode('utf-8')).hexdigest()


def sql_file(mode, kind, unit, prosrc, sig):
    h = md5(prosrc)
    return ('-- BACKLOG-4238 %s: %s %s (one function, one call; the check rolls the call back on a mismatch)\n'
            '%s'
            'DO $chk4238$ BEGIN\n'
            "  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = '%s'::regprocedure) IS DISTINCT FROM '%s' THEN\n"
            "    RAISE EXCEPTION 'P4238_CATALOG_MISMATCH %s %s';\n"
            '  END IF;\nEND $chk4238$;\n'
            "SELECT '%s' AS fn, '%s' AS state, md5(prosrc) AS md5 FROM pg_catalog.pg_proc WHERE oid = '%s'::regprocedure;\n"
            ) % (kind.upper(), mode, sig, unit, sig, h, mode, kind, sig, kind, sig)


def build():
    out = {}
    for mode, (case, fn, edits, good, bad) in MODES.items():
        unit, prosrc, sig = function_unit(T, fn)
        mut_unit, mut_src = unit, prosrc
        for old, new in edits:
            n_file, n_fn = T.count(old), unit.count(old)
            if n_file != 1 or n_fn != 1:
                sys.exit('%s: fragment matched migration %d times, function %d times (want 1, 1): %r' % (mode, n_file, n_fn, old[:80]))
            mut_unit = mut_unit.replace(old, new)
            mut_src = mut_src.replace(old, new)
        assert mut_src != prosrc and mut_unit.count('CREATE OR REPLACE FUNCTION') == 1
        out[mode] = dict(case=case, fn=fn, sig=sig, unit=unit, prosrc=prosrc, mut_unit=mut_unit, mut_src=mut_src, good=good, bad=bad)
    return out


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'list'
    b = build()
    if cmd == 'list':
        for mode, d in b.items():
            print('%s  %s  %s\n  correct: %s\n  mutant (predicted, not run): %s' % (d['case'], mode, d['sig'], d['good'], d['bad']))
        return
    if cmd != 'emit' or len(sys.argv) < 3:
        sys.exit(__doc__)
    od = sys.argv[2]
    os.makedirs(od, exist_ok=True)
    exp = {}
    for mode, d in b.items():
        open(os.path.join(od, mode + '.mutant.sql'), 'w').write(sql_file(mode, 'mutant', d['mut_unit'], d['mut_src'], d['sig']))
        open(os.path.join(od, mode + '.pristine.sql'), 'w').write(sql_file(mode, 'pristine', d['unit'], d['prosrc'], d['sig']))
        exp[mode] = dict(case=d['case'], sig=d['sig'], pristine_md5=md5(d['prosrc']), mutant_md5=md5(d['mut_src']))
    sigs = sorted({d['sig'] for d in b.values()})
    open(os.path.join(od, 'md5.sql'), 'w').write(
        '-- BACKLOG-4238 target functions: catalog md5(prosrc) and ACL (read-only)\n'
        'SELECT p.oid::regprocedure::text AS fn, md5(p.prosrc) AS md5, p.proacl::text AS acl FROM pg_catalog.pg_proc p\n'
        ' WHERE p.oid IN (%s) ORDER BY 1;\n' % ', '.join("to_regprocedure('%s')" % s for s in sigs))
    json.dump(exp, open(os.path.join(od, 'expected.json'), 'w'), indent=1, sort_keys=True)
    print(json.dumps(exp, indent=1, sort_keys=True))


main()
