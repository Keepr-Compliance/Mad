#!/bin/bash
# usage: run.sh <modes> [--with-migration]  -> prints the P4084_RESULT json, one mode per line
# keepr-test ONLY (kt-sql refuses the production ref). One call = one transaction ending in RAISE.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -t p4084).sql"
python3 "$here/compose.py" "$tmp" "$1" ${2:-} >/dev/null
~/.claude/bin/kt-sql "$tmp" 2>&1 | python3 "$here/parse.py"
rm -f "$tmp"
