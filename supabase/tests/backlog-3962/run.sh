#!/usr/bin/env bash
# BACKLOG-3962 PR1: run modes on keepr-test and print one result line per mode.
#   bash run.sh [mode ...]     default: base, every mutant, rollback
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
modes=("$@")
if [ ${#modes[@]} -eq 0 ]; then
  modes=(base $(python3 -c "import runpy,sys; sys.argv=['x','/dev/null','base']; g=runpy.run_path('$HERE/compose.py'); print(' '.join(g['MUTANTS']))") rollback)
fi
for m in "${modes[@]}"; do
  python3 "$HERE/compose.py" "$TMP/$m.sql" "$m" || { echo "INVALID|$m"; continue; }
  out="$(~/.claude/bin/kt-sql "$TMP/$m.sql" 2>&1 || true)"
  echo "$out" | python3 -c 'import sys,re; t=sys.stdin.read(); m=re.search(r"(P3962_RESULT .*?|P3962_END_NO_RESULT|ERROR: .*?)(\\n|\"|$)", t); print(m.group(1) if m else "NO OUTPUT: "+t[:300])'
done
