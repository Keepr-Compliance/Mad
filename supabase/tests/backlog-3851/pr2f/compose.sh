#!/usr/bin/env bash
# BACKLOG-3851 PR-2f: concatenate SQL files into one text for a single execute_sql call on
# keepr-test (the call is one transaction; the last file ends in RAISE, so it rolls back).
# Usage: compose.sh <out.sql> <file>...   e.g. compose.sh /tmp/q.sql M4a.sql M4.sql controls.sql
set -euo pipefail
out="$1"; shift
: > "$out"
for f in "$@"; do cat "$f" >> "$out"; printf '\n' >> "$out"; done
wc -c "$out"
