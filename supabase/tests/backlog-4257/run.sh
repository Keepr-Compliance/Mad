#!/bin/bash
# usage: run.sh   -> prints the P4219_RESULT json (4219 controls + 4257 controls, SR R2 composition)
# keepr-test ONLY (kt-sql refuses the production ref). One call = one transaction ending in RAISE.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
# static checks are informational here (a mutation can fail them on purpose); the DB run always follows
python3 "$here/static.py" >/dev/null 2>&1 || echo "STATIC FAIL (see static.py)"
tmp="$(mktemp -t p4257).sql"
python3 "$here/compose.py" "$tmp" >/dev/null
~/.claude/bin/kt-sql -c "$(cat "$tmp")" 2>&1 | python3 "$here/parse.py"
rm -f "$tmp"
