#!/usr/bin/env bash
# BACKLOG-3856 harness. Each control runs in ONE transaction ending in ROLLBACK:
#   helpers, fixtures (+ preconditions), the 3856 migration (or a mutant), the control.
# Nothing is ever committed.
#
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh controls [fragment]
#   SSH_HOST=... PG_CONTAINER=... bash run.sh mutants [fragment]
#
# Header tags: "-- harness: apply-twice" (migration runs twice; a raise on the
# second apply is a FAIL), "-- harness: rollback" (rollback-3856.sql runs after
# the migration, its BEGIN/COMMIT stripped).
# controls: exit 0 only when every control PASSes. mutants: baseline first, then
# KILLED / SURVIVED / INVALID per mutant; exit 0 only when every mutant is KILLED.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="${MIG_OVERRIDE:-$REPO/supabase/migrations/20261010145724_backlog_3856_suspended_user_licence.sql}"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
psql_in() {
  if [ "$SSH_HOST" = local ]; then docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -
  else ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -"; fi
}

build() { # $1 control, $2 migration
  local ctl="$1" mig="$2"
  echo "BEGIN;"
  cat "$HERE/lib/harness.sql" "$HERE/lib/fixtures.sql" "$mig"
  if grep -q -- '-- harness: apply-twice' "$ctl"; then
    echo 'DO $apply2$ BEGIN'
    echo "EXECUTE \$m3856\$"; cat "$mig"; echo "\$m3856\$;"
    echo "EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.check('apply-twice: second apply raised', false, SQLSTATE || ' ' || SQLERRM);"
    echo 'END $apply2$;'
  fi
  if grep -q -- '-- harness: rollback' "$ctl"; then
    grep -viE '^\s*(begin|commit);\s*$' "$HERE/rollback-3856.sql"
  fi
  cat "$ctl"
  echo "SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '|' || label || '|' || coalesce(detail, '') FROM t3856_r ORDER BY seq;"
  echo "SELECT 'CHECKS|' || count(*) FROM t3856_r;"
  echo "ROLLBACK;"
}

run_one() { # prints status lines; returns 0 PASS, 1 FAIL, 2 ERROR
  local out
  if ! out="$(build "$1" "$2" | psql_in 2>&1)"; then
    echo "$out" | tail -3; echo "ERROR|$(basename "$1")|psql failed"; return 2
  fi
  echo "$out" | grep -E '^(PASS|FAIL)\|' || true
  local n; n="$(echo "$out" | sed -n 's/^CHECKS|//p')"
  if [ -z "$n" ] || [ "$n" = "0" ]; then echo "ERROR|$(basename "$1")|0 checks"; return 2; fi
  if echo "$out" | grep -q '^FAIL|'; then return 1; fi
  return 0
}

ctl_path() { ls "$HERE"/controls/"$1"*.sql | head -1; }

run_controls() {
  local pass=0 fail=0 err=0 rc c
  for c in "$HERE"/controls/*.sql; do
    [[ "$(basename "$c")" == *"$1"* ]] || continue
    echo "== $(basename "$c" .sql)"
    rc=0; run_one "$c" "$MIG" || rc=$?
    case $rc in 0) pass=$((pass+1));; 1) fail=$((fail+1));; *) err=$((err+1));; esac
  done
  echo "CONTROLS: pass=$pass fail=$fail error=$err"
  [ "$fail" = 0 ] && [ "$err" = 0 ] && [ "$pass" -gt 0 ]
}

grep -q 'm3856\$' "$MIG" && { echo "ERROR|migration contains the \$m3856\$ tag"; exit 2; }

mode="${1:-controls}"; frag="${2:-}"
case "$mode" in
  controls) run_controls "$frag" || exit 1 ;;
  mutants)
    echo "-- baseline: every control against the unmutated migration"
    run_controls "" || { echo "MUTANTS: aborted - baseline not all PASS"; exit 1; }
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    killed=0; survived=0; invalid=0
    while IFS='|' read -r name targets; do
      [ -n "$frag" ] && [[ "$name" != *"$frag"* ]] && continue
      python3 "$HERE/lib/mutants.py" apply "$name" "$MIG" "$tmp/m.sql"
      changed="$(diff "$MIG" "$tmp/m.sql" | grep '^>' | head -2 | tr '\n' ' ' | cut -c1-200 || true)"
      if [ -z "$changed" ]; then echo "INVALID|$name|mutant changed nothing"; invalid=$((invalid+1)); continue; fi
      echo "== $name  MUTATION APPLIED: $changed"
      : >"$tmp/status"
      for t in $targets; do
        run_one "$(ctl_path "$t")" "$tmp/m.sql" >"$tmp/out" 2>&1 || true
        grep -E '^(PASS|FAIL|ERROR)\|' "$tmp/out" >>"$tmp/status" || true
        grep -E '^(FAIL|ERROR)\|' "$tmp/out" | sed "s/^/  [$t] /" | head -4 || true
      done
      verdict="$(python3 "$HERE/lib/mutants.py" classify <"$tmp/status")"
      echo "$verdict|$name"
      case "$verdict" in KILLED) killed=$((killed+1));; SURVIVED) survived=$((survived+1));; *) invalid=$((invalid+1));; esac
    done < <(python3 "$HERE/lib/mutants.py" list)
    echo "MUTANTS: killed=$killed survived=$survived invalid=$invalid"
    [ "$survived" = 0 ] && [ "$invalid" = 0 ] && [ "$killed" -gt 0 ] ;;
  *) echo "usage: run.sh controls|mutants [fragment]"; exit 2 ;;
esac
