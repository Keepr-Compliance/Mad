#!/usr/bin/env bash
# BACKLOG-3675 harness. Each control runs in ONE transaction that ends with
# ROLLBACK: harness helpers, fixtures, the 3675 migration (or a mutant of it),
# then the control. Nothing is ever committed.
#
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh controls [fragment]
#   SSH_HOST=... PG_CONTAINER=... bash run.sh mutants  [fragment]
#
# Control header tags:
#   -- harness: baseline     the migration is NOT applied
#   -- harness: apply-twice  the migration runs twice
#   -- harness: rollback     rollback-3675.sql runs after the migration
#   -- harness: reapply      ...and then the migration runs again
# Output: PASS|label|detail or FAIL|label|detail; exit 1 on any FAIL or on a
# control that produced no checks.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="${MIG_OVERRIDE:-$REPO/supabase/migrations/20261003140000_backlog_3675_unlimited_transactions_feature.sql}"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
psql_in() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -"; }

build() { # $1 control file, $2 migration file, $3 optional extra SQL file run after the migration
  local ctl="$1" mig="$2" extra="${3:-}"
  echo "BEGIN;"
  cat "$HERE/lib/harness.sql" "$HERE/lib/fixtures.sql"
  if ! grep -q -- '-- harness: baseline' "$ctl"; then
    cat "$mig"
    grep -q -- '-- harness: apply-twice' "$ctl" && cat "$mig"
    if grep -q -- '-- harness: rollback' "$ctl"; then
      # rollback-3675.sql carries its own BEGIN/COMMIT for production use; strip them here.
      grep -viE '^\s*(begin|commit);\s*$' "$HERE/rollback-3675.sql"
      grep -q -- '-- harness: reapply' "$ctl" && cat "$mig"
    fi
  fi
  [ -n "$extra" ] && cat "$extra"
  cat "$ctl"
  echo "SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '|' || label || '|' || coalesce(detail, '') FROM t3675_r ORDER BY seq;"
  echo "SELECT 'CHECKS|' || count(*) FROM t3675_r;"
  echo "ROLLBACK;"
}

run_one() { # $1 control, $2 migration, $3 optional extra SQL; prints results, returns 1 on failure
  local out
  out="$(build "$1" "$2" "${3:-}" | psql_in 2>&1)" || { echo "$out"; echo "ERROR|$(basename "$1")|psql failed"; return 1; }
  echo "$out" | grep -E '^(PASS|FAIL)\|' || true
  local n; n="$(echo "$out" | sed -n 's/^CHECKS|//p')"
  if [ -z "$n" ] || [ "$n" = "0" ]; then echo "ERROR|$(basename "$1")|0 checks"; return 1; fi
  ! echo "$out" | grep -q '^FAIL|'
}

mode="${1:-controls}"; frag="${2:-}"
case "$mode" in
  controls)
    rc=0
    for c in "$HERE"/controls/*${frag}*.sql; do
      echo "== $(basename "$c")"; run_one "$c" "$MIG" || rc=1
    done
    exit $rc ;;
  mutants)
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    python3 "$HERE/lib/mutants.py" list | while IFS='|' read -r name targets; do
      [ -n "$frag" ] && [[ "$name" != *"$frag"* ]] && continue
      # raises unless the pattern occurs exactly once, so an unapplied mutant never counts
      python3 "$HERE/lib/mutants.py" apply "$name" "$MIG" "$tmp/m.sql" "$tmp/extra.sql"
      echo "== $name  MUTATION APPLIED: $( (diff "$MIG" "$tmp/m.sql" | grep '^>' | head -1; head -1 "$tmp/extra.sql") | grep -v '^$' | head -1 | cut -c1-140)"
      red=0
      for t in $targets; do
        if run_one "$HERE/controls/$t.sql" "$tmp/m.sql" "$tmp/extra.sql" >"$tmp/out" 2>&1; then :; else red=1; grep -E '^(FAIL|ERROR)\|' "$tmp/out" | head -3; fi
      done
      if [ $red = 1 ]; then echo "KILLED|$name"; else echo "SURVIVED|$name"; fi
    done ;;
  *) echo "usage: run.sh controls|mutants [fragment]"; exit 2 ;;
esac
