#!/bin/bash
# usage: run.sh [--applied]  -> prints the P4170_RESULT json
# keepr-test ONLY (kt-sql refuses the production ref). One call = one transaction ending in RAISE.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -t p4170p1).sql"
python3 "$here/compose.py" "$tmp" "$@" >/dev/null
~/.claude/bin/kt-sql "$tmp" 2>&1 | python3 "$here/parse.py"
rm -f "$tmp"
