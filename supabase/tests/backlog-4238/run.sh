#!/bin/bash
# usage: run.sh [controls file]  -> prints the P4238_RESULT json and the wall time
# Venue: a test project through ~/.claude/bin/kt-sql. One call = one transaction ending in RAISE.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
umask 077
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT INT TERM
tmp="$dir/composed.sql"
python3 "$here/compose.py" "$tmp" "${1:-controls.sql}" >/dev/null
t0=$(date +%s)
~/.claude/bin/kt-sql "$tmp" 2>&1 | python3 "$here/parse.py"
echo "wall_s=$(( $(date +%s) - t0 ))"
