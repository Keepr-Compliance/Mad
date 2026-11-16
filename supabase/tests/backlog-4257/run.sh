#!/bin/bash
# usage: run.sh   -> prints the P4219_RESULT json (4219 controls + 4257 controls, SR R2 composition)
# keepr-test ONLY (kt-sql refuses the production ref). One call = one transaction ending in RAISE.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
python3 "$here/static.py" >/dev/null || { echo "STATIC FAIL"; python3 "$here/static.py"; }
tmp="$(mktemp -t p4257).sql"
python3 "$here/compose.py" "$tmp" >/dev/null
~/.claude/bin/kt-sql -c "$(cat "$tmp")" 2>&1 | python3 "$here/parse.py"
rm -f "$tmp"
