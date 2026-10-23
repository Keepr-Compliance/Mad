#!/bin/bash
# usage: run.sh <modes> [--with-migration]  -> prints the P4036_RESULT json, one mode per line
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -t p4036).sql"
python3 "$here/compose.py" "$tmp" "$1" ${2:-} >/dev/null
~/.claude/bin/kt-sql "$tmp" 2>&1 | python3 "$here/parse.py"
rm -f "$tmp"
