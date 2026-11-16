#!/bin/bash
# usage: run.sh <mode>   (see compose.py). keepr-test ONLY; one call, one transaction, always rolled back.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -t p3986).sql"
python3 "$here/compose.py" "$tmp" "$1"
~/.claude/bin/kt-sql "$tmp" 2>&1 | python3 "$here/parse.py"
rm -f "$tmp"
