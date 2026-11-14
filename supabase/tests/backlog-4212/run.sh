#!/bin/bash
# usage: run.sh   -> prints the mutation report and the P4212_RESULT json
# keepr-test ONLY (kt-sql refuses the production ref). One call = one transaction ending in RAISE,
# so nothing persists. Reset pg_stat_statements afterwards:
#   ~/.claude/bin/kt-sql -c "select extensions.pg_stat_statements_reset();"
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -t p4212).sql"
python3 "$here/compose.py" "$tmp"
out="$(~/.claude/bin/kt-sql "$tmp" 2>&1 || true)"
rm -f "$tmp"
python3 -c '
import json, re, sys
t = sys.stdin.read()
try:
    msg = json.loads(t.split("\nkt-sql:")[0])["message"]
except Exception:
    msg = t
m = re.search(r"P4212_RESULT (\{.*\})", msg, re.S)
if not m:
    print("NO RESULT: " + msg[:3000]); sys.exit(1)
d, _ = json.JSONDecoder().raw_decode(m.group(1))
for k in sorted(d): print("%-28s %s" % (k, d[k]))
' <<<"$out"
