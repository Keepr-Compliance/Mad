#!/bin/bash
# usage: run.sh baseline|controls [--with-migration] [--want OPEN|CLOSED]  -> prints the P4168_RESULT json
# keepr-test ONLY (kt-sql refuses the production ref). One call = one transaction ending in RAISE.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -t p4168).sql"
python3 "$here/compose.py" "$tmp" "$@" >/dev/null
~/.claude/bin/kt-sql "$tmp" 2>&1 | python3 "$here/parse.py"
rm -f "$tmp"
