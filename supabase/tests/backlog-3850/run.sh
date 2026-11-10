#!/usr/bin/env bash
# BACKLOG-3850: run every mode on keepr-test and print one P3850_RESULT line per mode.
#   bash run.sh [mode ...]     default: base M1 M3 M4 M5 M2c rollback
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
modes=("$@"); [ ${#modes[@]} -gt 0 ] || modes=(base M1 M3 M4 M5 M2c rollback)
for m in "${modes[@]}"; do
  python3 "$HERE/compose.py" "$TMP/$m.sql" "$m" || { echo "INVALID|$m"; continue; }
  out="$(~/.claude/bin/kt-sql "$TMP/$m.sql" 2>&1 || true)"
  echo "$out" | python3 -c 'import sys,re; t=sys.stdin.read(); m=re.search(r"(P3850_RESULT .*?|P3850_END_NO_RESULT|ERROR: .*?)\\n", t); print(m.group(1) if m else "NO OUTPUT: "+t[:300])'
done
