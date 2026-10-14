#!/usr/bin/env bash
# BACKLOG-3938 / BACKLOG-3940 harness. Each control runs in ONE transaction that
# ends with ROLLBACK, in this order:
#   the BACKLOG-3917 harness layers (helpers, venue parity, fixtures, preconditions,
#   the 3917 migration), lib/prod-bodies-3938.sql, lib/fixtures-3938.sql,
#   lib/pins-3938.sql (every object 3938/3940 touches or calls equals production,
#   else ERROR), lib/rollback-checks-3938.sql, the stack under test, the control.
# Nothing is ever committed.
#
#   SSH_HOST=<ssh alias|local> PG_CONTAINER=<container> bash run.sh precheck
#   ... run.sh controls [fragment]   # both migrations
#   ... run.sh twice    [fragment]   # both migrations applied twice
#   ... run.sh base     [fragment]   # neither migration: production today
#   ... run.sh variants              # wrong fixes in variants/ (each must go red)
#   ... run.sh mutants  [fragment]   # lib/mutants.py (each must go red)
#   ... run.sh rollback              # each rollback alone, then both
#
# Output: PASS|label|detail / FAIL|label|detail per check, CHECKS|<control>|<n>.
# A control with 0 checks or a psql error is ERROR.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
M="$REPO/supabase/migrations"
H="$REPO/supabase/tests/backlog-3917"
PARITY=("$M/20261003160000_backlog_3673_onboarding_completed_backfill.sql"
        "$M/20261008120000_backlog_3759_function_grants.sql"
        "$M/20261010150116_backlog_3843_org_member_client_write_lockdown.sql"
        "$H/lib/prod-bodies-3917.sql")
MIG3917="$M/20261014002359_backlog_3917_member_status_allow_list.sql"
MIG3938="${MIG3938_OVERRIDE:-$M/20261014120000_backlog_3938_membership_helper_oracle.sql}"
MIG3940="${MIG3940_OVERRIDE:-$M/20261014120100_backlog_3940_support_links_internal_only.sql}"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
psql_in() {
  if [ "$SSH_HOST" = local ]; then docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -
  else ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -"; fi
}
strip_txn() { grep -viE '^[[:space:]]*(begin|commit)[[:space:]]*;[[:space:]]*$' "$1"; }

prelude() {
  echo "BEGIN;"
  cat "$H/lib/harness-3917.sql"
  for f in "${PARITY[@]}"; do strip_txn "$f"; done
  cat "$H/lib/fixtures-3917.sql" "$H/lib/preconditions-3917.sql"
  strip_txn "$MIG3917"
  cat "$HERE/lib/prod-bodies-3938.sql" "$HERE/lib/fixtures-3938.sql" "$HERE/lib/pins-3938.sql" "$HERE/lib/rollback-checks-3938.sql"
}
build() { # $1 control, rest: stack files in order
  local ctl="$1"; shift
  prelude
  local f; for f in "$@"; do strip_txn "$f"; done
  cat "$ctl"
  echo "SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '|' || label || '|' || coalesce(detail, '') FROM t3917_r ORDER BY seq;"
  echo "SELECT 'CHECKS|' || count(*) FROM t3917_r;"
  echo "ROLLBACK;"
}
run_one() { # $1 control, rest: stack
  local ctl="$1" out n; shift
  if ! out="$(build "$ctl" "$@" | psql_in 2>&1)"; then
    echo "$out" | grep -E 'ERROR' | head -2; echo "ERROR|$(basename "$ctl")|psql failed"; return 2
  fi
  if ! echo "$out" | grep -q '^PINS OK'; then echo "ERROR|$(basename "$ctl")|pins not reached"; return 2; fi
  echo "$out" | grep -E '^(PASS|FAIL)\|' || true
  n="$(echo "$out" | sed -n 's/^CHECKS|//p')"
  if [ -z "$n" ] || [ "$n" = "0" ]; then echo "ERROR|$(basename "$ctl")|0 checks"; return 2; fi
  echo "CHECKS|$(basename "$ctl" .sql)|$n"
  if echo "$out" | grep -q '^FAIL|'; then return 1; fi
  return 0
}
run_set() { # $1 fragment, $2 quiet(0/1), rest: stack. d-controls only.
  local frag="$1" quiet="$2"; shift 2
  local pass=0 fail=0 err=0 checks=0 cf=0 rc c out
  for c in "$HERE"/controls/d*.sql; do
    [[ "$(basename "$c")" == *"$frag"* ]] || continue
    rc=0; out="$(run_one "$c" "$@")" || rc=$?
    if [ "$quiet" = 0 ]; then echo "== $(basename "$c" .sql)"; echo "$out"; else echo "$out" | grep -E '^(FAIL|ERROR)\|' | sed 's/^/     /' || true; fi
    checks=$((checks + $(echo "$out" | grep -cE '^(PASS|FAIL)\|' || true)))
    cf=$((cf + $(echo "$out" | grep -cE '^FAIL\|' || true)))
    case $rc in 0) pass=$((pass+1));; 1) fail=$((fail+1));; *) err=$((err+1));; esac
  done
  echo "CONTROLS: pass=$pass fail=$fail error=$err checks=$checks failed_checks=$cf"
  [ "$fail" = 0 ] && [ "$err" = 0 ] && [ "$pass" -gt 0 ] && [ "$checks" -gt 0 ]
}

mode="${1:-controls}"; frag="${2:-}"
case "$mode" in
  precheck)
    { prelude; echo "SELECT 'venue ledger head=' || max(version) FROM supabase_migrations.schema_migrations;"; echo "ROLLBACK;"; } | psql_in ;;
  controls) run_set "$frag" 0 "$MIG3938" "$MIG3940" || exit 1 ;;
  twice)    run_set "$frag" 0 "$MIG3938" "$MIG3940" "$MIG3938" "$MIG3940" || exit 1 ;;
  base)     run_set "$frag" 0 || true ;;
  variants)
    V="$HERE/variants"; killed=0; survived=0
    for spec in "w1-revoke-anon-only:$MIG3940 $V/w1-revoke-anon-only.sql" \
                "w2-revoke-public-anon:$MIG3940 $V/w2-revoke-public-anon.sql" \
                "alt-revoke-and-retarget:$MIG3938 $MIG3940 $V/alt-revoke-and-retarget.sql" \
                "x1-additive:$MIG3938 $V/x1-additive.sql" "x2-using-only:$MIG3938 $V/x2-using-only.sql" \
                "x3-write-only:$MIG3938 $V/x3-write-only.sql" "x4-insert-only:$MIG3938 $V/x4-insert-only.sql"; do
      name="${spec%%:*}"; stack="${spec#*:}"
      echo "== variant $name"
      # shellcheck disable=SC2086
      if run_set "" 1 $stack; then echo "SURVIVED|$name"; survived=$((survived+1)); else echo "KILLED|$name"; killed=$((killed+1)); fi
    done
    echo "VARIANTS: killed=$killed survived=$survived"; [ "$survived" = 0 ] ;;
  mutants)
    echo "-- baseline: every control against the unmutated migrations"
    run_set "" 1 "$MIG3938" "$MIG3940" || { echo "MUTANTS: aborted - baseline not green"; exit 1; }
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    killed=0; survived=0; invalid=0
    while IFS='|' read -r name file; do
      [ -n "$frag" ] && [[ "$name" != *"$frag"* ]] && continue
      if [ "$file" = 3938 ]; then src="$MIG3938"; else src="$MIG3940"; fi
      if ! python3 "$HERE/lib/mutants.py" apply "$name" "$src" "$tmp/m.sql"; then
        echo "INVALID|$name|mutant did not apply"; invalid=$((invalid+1)); continue; fi
      changed="$(diff "$src" "$tmp/m.sql" | grep '^[<>]' | head -2 | tr '\n' ' ' | cut -c1-160 || true)"
      if [ -z "$changed" ]; then echo "INVALID|$name|mutant changed nothing"; invalid=$((invalid+1)); continue; fi
      echo "== $name  MUTATION APPLIED: $changed"
      if [ "$file" = 3938 ]; then set -- "$tmp/m.sql" "$MIG3940"; else set -- "$MIG3938" "$tmp/m.sql"; fi
      if run_set "" 1 "$@"; then echo "SURVIVED|$name"; survived=$((survived+1)); else echo "KILLED|$name"; killed=$((killed+1)); fi
    done < <(python3 "$HERE/lib/mutants.py" list)
    echo "MUTANTS: killed=$killed survived=$survived invalid=$invalid"
    [ "$survived" = 0 ] && [ "$invalid" = 0 ] && [ "$killed" -gt 0 ] ;;
  rollback)
    C="$HERE/lib/capture-3938.sql"; P="$HERE/lib/pins-3938.sql"; rc_all=0
    echo "== r01: 3938 + 3940 applied, rollback-3938 alone"
    run_one "$HERE/controls/r01-rollback-3938-alone.sql" "$MIG3938" "$MIG3940" "$C" "$HERE/rollback-3938.sql" || rc_all=1
    echo "   behaviour after r01 (3938 controls red, 3940 controls green expected):"
    run_set "" 1 "$MIG3938" "$MIG3940" "$HERE/rollback-3938.sql" || true
    echo "== r02: 3938 + 3940 applied, rollback-3940 alone"
    run_one "$HERE/controls/r02-rollback-3940-alone.sql" "$MIG3938" "$MIG3940" "$C" "$HERE/rollback-3940.sql" || rc_all=1
    echo "   behaviour after r02 (3940 controls red, 3938 controls green expected):"
    run_set "" 1 "$MIG3938" "$MIG3940" "$HERE/rollback-3940.sql" || true
    echo "== r03: both rollbacks, then lib/pins-3938.sql again (every pin equals production)"
    run_one "$HERE/controls/r03-rollback-both.sql" "$MIG3938" "$MIG3940" "$C" "$HERE/rollback-3938.sql" "$HERE/rollback-3940.sql" "$P" || rc_all=1
    echo "ROLLBACK: $([ $rc_all = 0 ] && echo OK || echo FAILED)"; exit $rc_all ;;
  *) echo "usage: run.sh precheck|controls|twice|base|variants|mutants|rollback [fragment]"; exit 2 ;;
esac
