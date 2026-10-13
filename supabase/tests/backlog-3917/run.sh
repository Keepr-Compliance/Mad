#!/usr/bin/env bash
# BACKLOG-3917 harness. Each control runs in ONE transaction that ends with
# ROLLBACK, in this order:
#   helpers, venue parity (repo migrations 3673, 3759, 3843 + lib/prod-bodies-3917.sql),
#   fixtures, preconditions (every pinned object equals production; fp_before),
#   the 3917 migration (or a mutant of it), [the file again: apply-twice],
#   [rollback-3917.sql: rollback], the control.
# Nothing is ever committed.
#
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh precheck
#   SSH_HOST=... PG_CONTAINER=... bash run.sh controls [fragment]
#   SSH_HOST=... PG_CONTAINER=... bash run.sh mutants  [fragment]
#   SSH_HOST=... PG_CONTAINER=... bash run.sh base     [fragment]   # controls WITHOUT the 3917 file
#
# `base` runs the controls against production's definitions; the ones that
# describe 3917's behaviour must FAIL there (each control can go red).
# Output: PASS|label|detail / FAIL|label|detail per check, CHECKS|<n> per control.
# A control with 0 checks or a psql error is ERROR. mutants: every edit in
# lib/mutants.py must match exactly once (else the mutant is INVALID); exit 0
# only when every mutant is KILLED or an EXPECTED SURVIVOR.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
M="$REPO/supabase/migrations"
PARITY=("$M/20261003160000_backlog_3673_onboarding_completed_backfill.sql"
        "$M/20261008120000_backlog_3759_function_grants.sql"
        "$M/20261010150116_backlog_3843_org_member_client_write_lockdown.sql"
        "$HERE/lib/prod-bodies-3917.sql")
MIG="${MIG_OVERRIDE:-$M/20261014100000_backlog_3917_member_status_allow_list.sql}"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
psql_in() {
  if [ "$SSH_HOST" = local ]; then docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -
  else ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -"; fi
}
strip_txn() { grep -viE '^[[:space:]]*(begin|commit)[[:space:]]*;[[:space:]]*$' "$1"; }

build() { # $1 control file, $2 3917 migration file ('' = none)
  local ctl="$1" mig="$2"
  echo "BEGIN;"
  cat "$HERE/lib/harness-3917.sql"
  for f in "${PARITY[@]}"; do strip_txn "$f"; done
  cat "$HERE/lib/fixtures-3917.sql" "$HERE/lib/preconditions-3917.sql"
  if [ -n "$mig" ]; then
    cat "$mig"
    if grep -q -- '-- harness: apply-twice' "$ctl"; then
      echo "SELECT set_config('t3917.fp_once', pg_temp.fp3917_md5(), true) IS NULL;"
      cat "$mig"
    fi
    if grep -q -- '-- harness: rollback' "$ctl"; then strip_txn "$HERE/rollback-3917.sql"; fi
  fi
  cat "$ctl"
  echo "SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '|' || label || '|' || coalesce(detail, '') FROM t3917_r ORDER BY seq;"
  echo "SELECT 'CHECKS|' || count(*) FROM t3917_r;"
  echo "ROLLBACK;"
}

run_one() {
  local out
  if ! out="$(build "$1" "$2" | psql_in 2>&1)"; then
    echo "$out" | tail -3; echo "ERROR|$(basename "$1")|psql failed"; return 2
  fi
  echo "$out" | grep -E '^(PASS|FAIL)\|' || true
  local n; n="$(echo "$out" | sed -n 's/^CHECKS|//p')"
  if [ -z "$n" ] || [ "$n" = "0" ]; then echo "ERROR|$(basename "$1")|0 checks"; return 2; fi
  echo "CHECKS|$(basename "$1" .sql)|$n"
  if echo "$out" | grep -q '^FAIL|'; then return 1; fi
  return 0
}

run_controls() { # $1 fragment, $2 migration ('' = none)
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

mode="${1:-controls}"; frag="${2:-}"
case "$mode" in
  precheck)
    { echo "BEGIN;"; cat "$HERE/lib/harness-3917.sql"; for f in "${PARITY[@]}"; do strip_txn "$f"; done
      cat "$HERE/lib/preconditions-3917.sql"; echo "SELECT 'precheck OK fp=' || pg_temp.fp3917_md5();"
      echo "SELECT 'venue ledger head=' || max(version) FROM supabase_migrations.schema_migrations;"; echo "ROLLBACK;"; } | psql_in ;;
  controls) run_controls "$frag" "$MIG" || exit 1 ;;
  base)     run_controls "$frag" "" || exit 1 ;;
  mutants)
    echo "-- baseline: every control against the unmutated migration"
    if ! run_controls "" "$MIG"; then
      echo "MUTANTS: aborted - baseline controls did not all PASS; no mutant was run"; exit 1
    fi
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    killed=0; survived=0; expected=0; invalid=0
    while IFS='|' read -r name exp targets; do
      [ -n "$frag" ] && [[ "$name" != *"$frag"* ]] && continue
      if ! python3 "$HERE/lib/mutants.py" apply "$name" "$MIG" "$tmp/m.sql"; then
        echo "INVALID|$name|mutant did not apply"; invalid=$((invalid+1)); continue; fi
      changed="$(diff "$MIG" "$tmp/m.sql" | grep '^[<>]' | head -2 | tr '\n' ' ' | cut -c1-200 || true)"
      if [ -z "$changed" ]; then echo "INVALID|$name|mutant changed nothing"; invalid=$((invalid+1)); continue; fi
      echo "== $name  MUTATION APPLIED: $changed"
      : >"$tmp/status"
      for t in $targets; do
        run_one "$HERE/controls/$t.sql" "$tmp/m.sql" >"$tmp/out" 2>&1 || true
        grep -E '^(PASS|FAIL|ERROR)\|' "$tmp/out" >>"$tmp/status" || true
        nf="$(grep -cE '^(FAIL|ERROR)\|' "$tmp/out" || true)"
        echo "   $t: $(grep -cE '^PASS\|' "$tmp/out" || true) pass, $nf fail/error"
        grep -E '^(FAIL|ERROR)\|' "$tmp/out" | head -3 | sed 's/^/     /' || true
      done
      verdict="$(python3 "$HERE/lib/mutants.py" classify <"$tmp/status")"
      if [ "$verdict" = SURVIVED ] && [ "$exp" = survivor ]; then verdict="EXPECTED SURVIVOR"; fi
      echo "$verdict|$name"
      case "$verdict" in KILLED) killed=$((killed+1));; SURVIVED) survived=$((survived+1));;
        "EXPECTED SURVIVOR") expected=$((expected+1));; *) invalid=$((invalid+1));; esac
    done < <(python3 "$HERE/lib/mutants.py" list)
    echo "MUTANTS: killed=$killed survived=$survived expected_survivor=$expected invalid=$invalid"
    [ "$survived" = 0 ] && [ "$invalid" = 0 ] && [ "$killed" -gt 0 ] ;;
  *) echo "usage: run.sh precheck|controls|base|mutants [fragment]"; exit 2 ;;
esac
