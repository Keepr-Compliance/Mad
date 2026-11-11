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
# retried, at most twice: transport failures (curl errors before any result) and a deadlock
# with another session (40P01; the migration's foreign keys lock auth.users)
for attempt in 1 2 3; do
  out="$(~/.claude/bin/kt-sql "$tmp" 2>&1 || true)"
  case "$out" in curl:*|*40P01*) [ "$attempt" -lt 3 ] && { echo "retry $attempt: ${out%%$'\n'*}" >&2; sleep 2; continue; } ;; esac
  break
done
printf '%s\n' "$out" | python3 "$here/parse.py"
echo "wall_s=$(( $(date +%s) - t0 ))"
