#!/usr/bin/env python3
"""Read kt-sql output on stdin; print the P4219_RESULT json (4219 + 4257 controls, plus 4257 info),
then the per-set counts. Exit 1 when there is no result or a set ran zero controls."""
import json, re, sys
t = sys.stdin.read()
try:
    msg = json.loads(t.split('\nkt-sql:')[0])['message']
except Exception:
    msg = t
m = re.search(r'P4219_RESULT (\{.*\})', msg)
if not m:
    print('NO RESULT: ' + msg[:3000]); sys.exit(1)
d, _ = json.JSONDecoder().raw_decode(m.group(1))
print(json.dumps(d, indent=1))
reds = d.get('reds', {})
n57 = len([k for k in reds if k.startswith('4257_')])
print('COUNTS total=%s pass=%s fail=%s | 4257 reds=%d 4219 reds=%d' % (d.get('total'), d.get('pass'), d.get('fail'),
      n57, len(reds) - n57))
if not d.get('total') or not d.get('info'):
    print('ZERO CONTROLS RAN (or no 4257 info)'); sys.exit(1)
