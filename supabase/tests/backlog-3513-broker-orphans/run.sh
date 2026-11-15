#!/bin/bash
# usage: run.sh [--regression]  -> prints the result json
# keepr-test ONLY (kt-sql refuses the production ref). One call = one transaction ending in RAISE.
# Retries a network failure up to 3 times; a SQL result is never retried.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -t p3513o).sql"
python3 "$here/compose.py" "$tmp" "$@" >/dev/null
for i in 1 2 3; do
  out="$(~/.claude/bin/kt-sql "$tmp" 2>&1 || true)"
  case "$out" in *"Failed to connect"*|*"Could not resolve"*|*"timed out"*) sleep 5; continue;; esac
  break
done
rm -f "$tmp"
printf '%s' "$out" | python3 "$here/../backlog-3513-broker/parse.py"
