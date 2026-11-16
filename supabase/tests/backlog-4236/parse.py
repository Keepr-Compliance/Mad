#!/usr/bin/env python3
"""Read kt-sql output on stdin; print the P4236_RESULT json. Exit 1 when no result, zero controls ran,
or the deliberate red (Z0) is missing. Z0 is subtracted from the counts printed as real_fail."""
import json, re, sys
t = sys.stdin.read()
try:
    msg = json.loads(t.split('\nkt-sql:')[0])['message']
except Exception:
    msg = t
m = re.search(r'P4236_RESULT (\{.*\})', msg, re.S)
if not m:
    print('NO RESULT: ' + msg[:3000]); sys.exit(1)
d, _ = json.JSONDecoder().raw_decode(m.group(1))
z0 = 'Z0_parser_counts_a_fail' in d.get('reds', {})
d['real_fail'] = d.get('fail', 0) - (1 if z0 else 0)
d['real_reds'] = sorted(k for k in d.get('reds', {}) if k != 'Z0_parser_counts_a_fail')
print(json.dumps(d, indent=1, sort_keys=True))
if not d.get('total'):
    print('ZERO CONTROLS RAN'); sys.exit(1)
if not z0:
    print('DELIBERATE RED MISSING: the result is not trustworthy'); sys.exit(1)
