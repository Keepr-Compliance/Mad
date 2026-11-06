#!/usr/bin/env python3
"""Print the P4153_RESULT (or P3853_RESULT) JSON from a kt-sql output file."""
import json, re, sys
t = open(sys.argv[1]).read()
try:
    t = json.loads(t.split('\nkt-sql:')[0])['message']
except Exception:
    pass
m = re.search(r'(P\d+_RESULT) (\{.*\})\s*\nCONTEXT', t, re.S)
if not m:
    print(t[:4000]); sys.exit(1)
print(m.group(1)); print(json.dumps(json.loads(m.group(2)), indent=1))
