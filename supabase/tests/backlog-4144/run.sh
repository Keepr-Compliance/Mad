#!/bin/bash
# usage: run.sh [--with-migration]  -> prints the P4144_RESULT json
# keepr-test ONLY (kt-sql refuses the production ref). One call = one transaction ending in RAISE.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -t p4144).sql"
python3 "$here/compose.py" "$tmp" ${1:-} >/dev/null
~/.claude/bin/kt-sql "$tmp" 2>&1 | python3 "$here/parse.py"
rm -f "$tmp"
