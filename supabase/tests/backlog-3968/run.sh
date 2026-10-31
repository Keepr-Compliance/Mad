#!/usr/bin/env bash
# BACKLOG-3968 PR-5: run probe.sql on keepr-test (kt-sql targets keepr-test only).
#   bash run.sh                 probe against the project as it is
#   bash run.sh <migration.sql> the migration (or a mutant) runs inside the
#                               probe's transaction first; rolled back after
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
if [ -n "${1:-}" ]; then
  /usr/bin/python3 -I - "$HERE/probe.sql" "$1" "$TMP" <<'PY'
import sys
probe, mig, out = sys.argv[1:4]
p = open(probe).read(); m = open(mig).read()
assert p.count('--@@MIGRATION@@') == 1
open(out, 'w').write(p.replace('--@@MIGRATION@@', m))
PY
else
  cp "$HERE/probe.sql" "$TMP"
fi
"${KT_SQL:-$HOME/.claude/bin/kt-sql}" "$TMP"
