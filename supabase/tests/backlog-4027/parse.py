#!/usr/bin/env python3
"""Read kt-sql output on stdin; print the P4027_RESULT json, one mode per line."""
import json, re, sys
t = sys.stdin.read()
m = re.search(r'P4027_RESULT (\{.*?\})\\n', t)
if not m:
    print('NO RESULT: ' + t[:1500]); sys.exit(1)
d = json.loads(m.group(1).replace('\\"', '"'))
for k, v in d.items():
    print(k, json.dumps(v))
