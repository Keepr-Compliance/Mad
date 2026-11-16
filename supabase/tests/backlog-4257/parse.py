#!/usr/bin/env python3
"""Read kt-sql output on stdin; print one line per control: '<name> PASS' or '<name> FAIL [<SQLSTATE>]'.
keepr-test is shared, so nothing else from the database is printed: no detail, message text or row
data. A failing control's SQLSTATE is printed only when its result starts 'FAIL ERR <5 chars>'.
Then whitelisted harness info (md5 hex, ACL strings of the private functions, byte sizes) and the counts.
Exit 1 when there is no result or zero controls ran."""
import json, re, sys
SAFE = {
    'R1b_md5_4219': r'[0-9a-f]{32}', 'R1b_md5_after_migration': r'[0-9a-f]{32}',
    'R1b_md5_live_before_run': r'[0-9a-f]{32}|none',
    'R1b_acl_live_before_run': r'\{[a-z_]+=X/[a-z_]+(,[a-z_]+=X/[a-z_]+)*\}|none',
    'C9_max2_octet_length': r'\d+', 'C9_max2_compact': r'\d+', 'C9_max2_estimate': r'\d+',
    'C9_rep2_octet_length': r'\d+', 'S1_cases': r'\d+',
}


def out(line):
    print(line)


def main(t):
    try:
        msg = json.loads(t.split('\nkt-sql:')[0])['message']
    except Exception:
        msg = t
    m = re.search(r'P4219_RESULT (\{.*\})', msg)
    if not m:
        st = re.search(r'SQLSTATE[^0-9A-Z]*([0-9A-Z]{5})', msg)
        out('NO RESULT' + (' sqlstate=' + st.group(1) if st else '')); return 1
    try:
        d, _ = json.JSONDecoder().raw_decode(m.group(1))
    except Exception:
        out('NO RESULT (unparseable)'); return 1
    allc = d.get('all') or {}
    reds = d.get('reds') or {}
    for name in sorted(allc):
        if not re.fullmatch(r'[A-Za-z0-9_]+', name):
            out('CONTROL <unprintable name> ' + ('PASS' if allc[name] is True else 'FAIL')); continue
        if allc[name] is True:
            out('%s PASS' % name)
        else:
            st = re.match(r'FAIL ERR ([0-9A-Z]{5})\b', str(reds.get(name, '')))
            out('%s FAIL%s' % (name, ' ' + st.group(1) if st else ''))
    info = d.get('info') or {}
    for k, pat in SAFE.items():
        v = str(info.get(k, ''))
        if re.fullmatch(pat, v):
            out('INFO %s=%s' % (k, v))
    for fn, acl in sorted((info.get('S5_acls') or {}).items()):
        if re.fullmatch(r'_learn_pilot_[a-z_]+', fn) and re.fullmatch(SAFE['R1b_acl_live_before_run'] + '|NULL', str(acl)):
            out('INFO acl %s=%s' % (fn, acl))
    total, npass, nfail = (int(d.get(k) or 0) for k in ('total', 'pass', 'fail'))
    n57 = len([k for k in allc if k.startswith('4257_')])
    out('COUNTS total=%d pass=%d fail=%d | 4257 controls=%d 4219 controls=%d' % (total, npass, nfail, n57, len(allc) - n57))
    if not total or not info or len(allc) != total:
        out('ZERO CONTROLS RAN (or no 4257 info, or name list incomplete)'); return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.stdin.read()))
