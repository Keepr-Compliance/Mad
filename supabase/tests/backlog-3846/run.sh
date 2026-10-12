#!/usr/bin/env bash
# BACKLOG-3846 harness. Each control runs in ONE transaction ending in ROLLBACK:
#   3845 helpers + fixtures, the 3845 migration (the venue may predate it) and its
#   post-apply data step, production bodies of the functions the controls call
#   (lib/prod-bodies.sql, md5-checked), 3846 fixtures, then the 3846 migration
#   (or a mutant), optionally a second apply / the rollback, then the control.
#   Nothing is committed.
#
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh controls [fragment]
#   SSH_HOST=... PG_CONTAINER=... bash run.sh mutants  [fragment]
#
# Header tags in a control file:
#   -- harness: apply-twice              apply the 3846 migration a second time
#   -- harness: rollback                 run rollback-3846.sql after the migration
#   -- harness: pre-apply: <SQL line>    run just before the 3846 migration
#   -- harness: expect-raise             do not add the "migration applied" check
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
L3845="$REPO/supabase/tests/backlog-3845/lib"
MIG3845="$REPO/supabase/migrations/20261011230913_backlog_3845_billing_foundation.sql"
MIG="${MIG_OVERRIDE:-$REPO/supabase/migrations/20261012100000_backlog_3846_unsuspend_regrant_and_audit_actor.sql}"
RB="$HERE/rollback-3846.sql"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
psql_in() {
  if [ "$SSH_HOST" = local ]; then docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -
  else ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -"; fi
}

step() { # $1 step name, $2 file (BEGIN/COMMIT lines stripped)
  echo "SELECT pg_temp.run_step('$1', \$h3846\$"
  grep -viE '^\s*(begin|commit);\s*$' "$2"
  echo "\$h3846\$);"
}

build() { # $1 control, $2 migration
  local ctl="$1" mig="$2"
  echo "BEGIN;"
  echo "SET LOCAL TimeZone = 'UTC';"
  cat "$L3845/harness.sql"
  cat "$L3845/fixtures.sql"
  step apply3845 "$MIG3845"   # idempotent (3845 control k15) when the venue already has it
  echo "SELECT pg_temp.check('venue: 3845 migration present', pg_temp.step_ok('apply3845'), pg_temp.step_err('apply3845'));"
  cat "$L3845/post-apply.sql"
  cat "$HERE/lib/prod-bodies.sql"
  cat "$HERE/lib/fixtures-3846.sql"
  sed -n 's/^-- harness: pre-apply: //p' "$ctl"
  step apply1 "$mig"
  if grep -q -- '-- harness: apply-twice' "$ctl"; then step apply2 "$mig"; fi
  if grep -q -- '-- harness: rollback' "$ctl"; then step rollback "$RB"; fi
  if ! grep -q -- '-- harness: expect-raise' "$ctl"; then
    echo "SELECT pg_temp.check('migration applied', pg_temp.step_ok('apply1'), pg_temp.step_err('apply1'));"
  fi
  cat "$ctl"
  echo "SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '|' || label || '|' || coalesce(detail, '') FROM t3845_r ORDER BY seq;"
  echo "SELECT 'CHECKS|' || count(*) FROM t3845_r;"
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

ctl_path() { ls "$HERE"/controls/"$1"-*.sql | head -1; }

run_controls() { # $1 fragment, $2 migration
  local pass=0 fail=0 err=0 rc c
  for c in "$HERE"/controls/*.sql; do
    [[ "$(basename "$c")" == *"$1"* ]] || continue
    echo "== $(basename "$c" .sql)"
    rc=0; run_one "$c" "$2" || rc=$?
    case $rc in 0) pass=$((pass+1));; 1) fail=$((fail+1));; *) err=$((err+1));; esac
  done
  echo "CONTROLS: pass=$pass fail=$fail error=$err"
  [ "$fail" = 0 ] && [ "$err" = 0 ] && [ "$pass" -gt 0 ]
}

for f in "$MIG" "$MIG3845" "$RB"; do grep -q 'h3846\$' "$f" && { echo "ERROR|$f contains the \$h3846\$ tag"; exit 2; }; done

mode="${1:-controls}"; frag="${2:-}"
case "$mode" in
  controls) run_controls "$frag" "$MIG" || exit 1 ;;
  mutants)
    echo "-- baseline: every control against the unmutated migration"
    run_controls "" "$MIG" || { echo "MUTANTS: aborted - baseline not all PASS"; exit 1; }
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    killed=0; survived=0; invalid=0
    while IFS='|' read -r name targets; do
      [ -n "$frag" ] && [[ "$name" != *"$frag"* ]] && continue
      if ! python3 "$HERE/lib/mutants.py" apply "$name" "$MIG" "$tmp/m.sql"; then
        echo "INVALID|$name|mutant did not apply"; invalid=$((invalid+1)); continue
      fi
      changed="$(diff "$MIG" "$tmp/m.sql" | grep '^[<>]' | head -3 | tr '\n' ' ' | cut -c1-240 || true)"
      if [ -z "$changed" ]; then echo "INVALID|$name|mutant changed nothing"; invalid=$((invalid+1)); continue; fi
      echo "== $name  MUTATION APPLIED: $changed"
      : >"$tmp/status"
      for t in $targets; do
        run_one "$(ctl_path "$t")" "$tmp/m.sql" >"$tmp/out" 2>&1 || true
        grep -E '^(PASS|FAIL|ERROR)\|' "$tmp/out" | sed "s/^\([A-Z]*\)|/\1|[$t] /" >>"$tmp/status" || true
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
