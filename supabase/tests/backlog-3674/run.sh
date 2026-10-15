#!/usr/bin/env bash
# BACKLOG-3674 harness. Each control runs in ONE transaction that ends with
# ROLLBACK: harness helpers, fixtures, the 3673 and 3714 migrations from the
# repo (unchanged; production has both, the test database may not), the 3674
# migration (or a mutant of it), then the control. Nothing is ever committed.
#
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh controls [fragment]
#   SSH_HOST=... PG_CONTAINER=... bash run.sh mutants  [fragment]
#
# Control header tags:
#   -- harness: baseline     the 3674 migration is NOT applied (3673 + 3714 still are)
#   -- harness: apply-twice  the migration runs twice
#   -- harness: rollback     rollback-3674.sql runs after the migration
#   -- harness: reapply      ...and then the migration runs again
# Output: PASS|label|detail, FAIL|label|detail, or ERROR|control|reason (psql
# failed, or the control produced no checks).
#
# controls: runs every control, ends with
#   CONTROLS: pass=X fail=Y error=Z      (counted per control file)
#   exit 0 only when every control PASSes.
# mutants:  first runs every control against the unmutated migration and stops
#   (exit 1, no mutant runs) unless every control PASSes. Then each mutant is
#   KILLED   at least one target control reports an assertion FAIL, none ERROR
#   SURVIVED every target control PASSes
#   INVALID  any target control ERRORs: the run proved nothing (mutants.py classify)
#   and the run ends with
#   MUTANTS: killed=X survived=Y invalid=Z
#   exit 0 only when every mutant is KILLED.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="${MIG_OVERRIDE:-$REPO/supabase/migrations/20261008130000_backlog_3674_tour_dismissed.sql}"
# Layered before 3674 on every control, baseline included: production state
# before 3674 = 3673 then 3714 applied.
PRE_MIGS=(
  "$REPO/supabase/migrations/20261003160000_backlog_3673_onboarding_completed_backfill.sql"
  "$REPO/supabase/migrations/20261007200000_backlog_3714_users_column_update_grants.sql"
)
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
psql_in() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -"; }

build() { # $1 control file, $2 migration file, $3 optional extra SQL file run after the migration
  local ctl="$1" mig="$2" extra="${3:-}"
  echo "BEGIN;"
  cat "$HERE/lib/harness.sql" "$HERE/lib/fixtures.sql" "${PRE_MIGS[@]}"
  if ! grep -q -- '-- harness: baseline' "$ctl"; then
    cat "$mig"
    if grep -q -- '-- harness: apply-twice' "$ctl"; then
      # The second apply runs inside a block so that a raise is recorded as a
      # FAIL check rather than aborting the run (which would read as ERROR).
      echo 'DO $apply2$ BEGIN'
      cat "$mig"
      echo "EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.check('apply-twice: second apply raised', false, SQLSTATE || ' ' || SQLERRM);"
      echo 'END $apply2$;'
    fi
    if grep -q -- '-- harness: rollback' "$ctl"; then
      # rollback-3674.sql carries its own BEGIN/COMMIT for production use; strip them here.
      grep -viE '^\s*(begin|commit);\s*$' "$HERE/rollback-3674.sql"
      grep -q -- '-- harness: reapply' "$ctl" && cat "$mig"
    fi
  fi
  [ -n "$extra" ] && cat "$extra"
  cat "$ctl"
  echo "SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '|' || label || '|' || coalesce(detail, '') FROM t3674_r ORDER BY seq;"
  echo "SELECT 'CHECKS|' || count(*) FROM t3674_r;"
  echo "ROLLBACK;"
}

run_one() { # $1 control, $2 migration, $3 optional extra SQL
  # prints status lines; returns 0 PASS, 1 FAIL, 2 ERROR
  local out
  if ! out="$(build "$1" "$2" "${3:-}" | psql_in 2>&1)"; then
    echo "$out" | tail -3; echo "ERROR|$(basename "$1")|psql failed"; return 2
  fi
  echo "$out" | grep -E '^(PASS|FAIL)\|' || true
  local n; n="$(echo "$out" | sed -n 's/^CHECKS|//p')"
  if [ -z "$n" ] || [ "$n" = "0" ]; then echo "ERROR|$(basename "$1")|0 checks"; return 2; fi
  if echo "$out" | grep -q '^FAIL|'; then return 1; fi
  return 0
}

# Runs every control (optionally filtered) against the unmutated migration;
# prints the CONTROLS tally; returns 0 only when every control PASSes.
run_controls() { # $1 fragment
  local pass=0 fail=0 err=0 rc c
  for c in "$HERE"/controls/*${1}*.sql; do
    [ -e "$c" ] || continue
    echo "== $(basename "$c")"
    rc=0; run_one "$c" "$MIG" || rc=$?
    case $rc in 0) pass=$((pass+1));; 1) fail=$((fail+1));; *) err=$((err+1));; esac
  done
  echo "CONTROLS: pass=$pass fail=$fail error=$err"
  [ "$fail" = 0 ] && [ "$err" = 0 ] && [ "$pass" -gt 0 ]
}

grep -q 'apply2\$' "$MIG" && { echo "ERROR|migration contains the \$apply2\$ tag build() uses"; exit 2; }

mode="${1:-controls}"; frag="${2:-}"
case "$mode" in
  controls)
    run_controls "$frag" || exit 1 ;;
  mutants)
    echo "-- baseline: every control against the unmutated migration"
    if ! run_controls ""; then
      echo "MUTANTS: aborted - baseline controls did not all PASS; no mutant was run"
      exit 1
    fi
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    killed=0; survived=0; invalid=0
    while IFS='|' read -r name targets; do
      [ -n "$frag" ] && [[ "$name" != *"$frag"* ]] && continue
      # raises unless the pattern occurs exactly once, so an unapplied mutant never counts
      python3 "$HERE/lib/mutants.py" apply "$name" "$MIG" "$tmp/m.sql" "$tmp/extra.sql"
      # '<' too: a mutant that only deletes a line shows no '>' line
      changed="$( (diff "$MIG" "$tmp/m.sql" | grep -E '^[<>]' | head -1; head -1 "$tmp/extra.sql") | grep -v '^$' | head -1 | cut -c1-140 || true)"
      if [ -z "$changed" ]; then echo "INVALID|$name|mutant changed nothing"; invalid=$((invalid+1)); continue; fi
      echo "== $name  MUTATION APPLIED: $changed"
      : >"$tmp/status"
      for t in $targets; do
        run_one "$HERE/controls/$t.sql" "$tmp/m.sql" "$tmp/extra.sql" >"$tmp/out" 2>&1 || true
        grep -E '^(PASS|FAIL|ERROR)\|' "$tmp/out" >>"$tmp/status" || true
        grep -E '^(FAIL|ERROR)\|' "$tmp/out" | head -3 || true
      done
      verdict="$(python3 "$HERE/lib/mutants.py" classify <"$tmp/status")"
      echo "$verdict|$name"
      case "$verdict" in KILLED) killed=$((killed+1));; SURVIVED) survived=$((survived+1));; *) invalid=$((invalid+1));; esac
    done < <(python3 "$HERE/lib/mutants.py" list)
    echo "MUTANTS: killed=$killed survived=$survived invalid=$invalid"
    [ "$survived" = 0 ] && [ "$invalid" = 0 ] && [ "$killed" -gt 0 ] ;;
  *) echo "usage: run.sh controls|mutants [fragment]"; exit 2 ;;
esac
