#!/usr/bin/env bash
# BACKLOG-4179: run one or more composed modes on keepr-test and print each P4179 result line.
#   bash run.sh base M_active_only M_insert_only M_org_exclusion M_no_retire G7
# Every composed text ends in RAISE (nothing persists). Resets pg_stat_statements afterwards.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KT=~/.claude/bin/kt-sql
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
for MODE in "$@"; do
  python3 "$HERE/compose.py" "$TMP/$MODE.sql" "$MODE" || { echo "$MODE: compose failed"; continue; }
  OUT="$($KT "$TMP/$MODE.sql" 2>&1)"
  LINE="$(python3 -c 'import sys,json
t=sys.stdin.read()
try: m=json.loads(t.split("\nkt-sql:")[0])["message"]
except Exception: m=t
i=m.find("P4179_"); j=m.find("BACKLOG-4179 pre-check")
print(m[i:].split("\n")[0] if i>=0 else (m[j:].split("\n")[0] if j>=0 else "NO RESULT: "+m[:300]))' <<<"$OUT")"
  echo "$MODE: $LINE"
done
$KT -c "select extensions.pg_stat_statements_reset()" >/dev/null 2>&1 || echo "pg_stat_statements_reset failed"
