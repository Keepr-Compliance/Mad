#!/usr/bin/env bash
# BACKLOG-3946 harness. Each control runs in ONE transaction that ends with ROLLBACK, in
# this order:
#   the BACKLOG-3917 harness layers (helpers, venue parity, fixtures, preconditions, the
#   3917 migration), the BACKLOG-3938 libs (prod bodies, fixtures, pins), the 3938 and 3940
#   migrations, lib/parity-3946.sql, lib/catalog-3946.sql, lib/pins-3946.sql (every helper
#   and helper policy equals production, else ERROR), lib/fixtures-3946.sql,
#   lib/capture-3946.sql (visibility fingerprint before), the stack under test, the control.
# Nothing is ever committed. Run sets one at a time (they share fixture ids).
#
#   SSH_HOST=<ssh alias|local> PG_CONTAINER=<container> bash run.sh precheck
#   ... run.sh controls [fragment]   # A + B + C
#   ... run.sh twice    [fragment]   # A + B + C applied twice
#   ... run.sh base     [fragment]   # none of them: production today (reds expected)
#   ... run.sh variants              # wrong fixes (each must go red)
#   ... run.sh mutants  [fragment]   # lib/mutants.py (each must go red)
#   ... run.sh rollback              # each rollback alone, then all three
#   ... run.sh one <control> <stack files...>
#
# Output: PASS|label|detail / FAIL|label|detail per check, CHECKS|<control>|<n>.
# A control with 0 checks or a psql error is ERROR.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
M="$REPO/supabase/migrations"
H="$REPO/supabase/tests/backlog-3917"
H8="$REPO/supabase/tests/backlog-3938"
PARITY=("$M/20261003160000_backlog_3673_onboarding_completed_backfill.sql"
        "$M/20261008120000_backlog_3759_function_grants.sql"
        "$M/20261010150116_backlog_3843_org_member_client_write_lockdown.sql"
        "$H/lib/prod-bodies-3917.sql")
MIG3917="$M/20261014002359_backlog_3917_member_status_allow_list.sql"
MIG3938="$M/20261014053520_backlog_3938_membership_helpers_caller_only.sql"
MIG3940="$M/20261014061621_backlog_3940_support_links_internal_only.sql"
MIG_A="${MIG_A_OVERRIDE:-$M/20261014130000_backlog_3946_staff_helpers_caller_only.sql}"
MIG_B="${MIG_B_OVERRIDE:-$M/20261014130100_backlog_3946_identity_helpers_signed_in_only.sql}"
MIG_C="${MIG_C_OVERRIDE:-$M/20261014130200_backlog_3946_support_links_table_grants.sql}"
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
  cat "$H8/lib/prod-bodies-3938.sql" "$H8/lib/fixtures-3938.sql" "$H8/lib/pins-3938.sql"
  strip_txn "$MIG3938"; strip_txn "$MIG3940"
  cat "$HERE/lib/parity-3946.sql" "$HERE/lib/catalog-3946.sql" "$HERE/lib/pins-3946.sql" \
      "$HERE/lib/fixtures-3946.sql" "$HERE/lib/capture-3946.sql"
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
  local ctl="$1" out n sf; shift
  for sf in "$@"; do [ -f "$sf" ] || { echo "ERROR|$(basename "$ctl")|missing stack file $sf"; return 2; }; done
  if ! out="$(build "$ctl" "$@" | psql_in 2>&1)"; then
    echo "$out" | grep -E 'ERROR|MISMATCH' | head -4; echo "ERROR|$(basename "$ctl")|psql failed"; return 2
  fi
  if ! echo "$out" | grep -q '^PINS3946 OK'; then echo "ERROR|$(basename "$ctl")|pins not reached"; return 2; fi
  echo "$out" | grep -E '^(PASS|FAIL)\|' || true
  n="$(echo "$out" | sed -n 's/^CHECKS|//p')"
  if [ -z "$n" ] || [ "$n" = "0" ]; then echo "ERROR|$(basename "$ctl")|0 checks"; return 2; fi
  echo "CHECKS|$(basename "$ctl" .sql)|$n"
  if echo "$out" | grep -q '^FAIL|'; then return 1; fi
  return 0
}
run_set() { # $1 fragment, $2 quiet(0/1), rest: stack. e-controls only.
  local frag="$1" quiet="$2"; shift 2
  local pass=0 fail=0 err=0 checks=0 cf=0 rc c out
  for c in "$HERE"/controls/e*.sql; do
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
  controls) run_set "$frag" 0 "$MIG_A" "$MIG_B" "$MIG_C" || exit 1 ;;
  twice)    run_set "$frag" 0 "$MIG_A" "$MIG_B" "$MIG_C" "$MIG_A" "$MIG_B" "$MIG_C" || exit 1 ;;
  base)     run_set "$frag" 0 || true ;;
  variants)
    V="$HERE/variants"; killed=0; survived=0
    for spec in "v1-alt3938:$MIG_A $V/v1-alt3938.sql $MIG_C" \
                "v2-revoke-no-retarget:$MIG_A $V/v2-revoke-no-retarget.sql $MIG_C" \
                "v3-guard-hir-only:$V/v3-guard-hir-only.sql $MIG_B $MIG_C" \
                "v4-noarg-is-internal:$V/v4-noarg-is-internal.sql $MIG_C" \
                "v5-item-text-literal:$MIG_A $V/v5-item-text-literal.sql $MIG_C" \
                "A-only:$MIG_A" "A+C:$MIG_A $MIG_C" "B-without-A:$MIG_B $MIG_C" "C-only:$MIG_C"; do
      name="${spec%%:*}"; stack="${spec#*:}"
      echo "== variant $name"
      # shellcheck disable=SC2086
      if run_set "" 1 $stack; then echo "SURVIVED|$name"; survived=$((survived+1)); else echo "KILLED|$name"; killed=$((killed+1)); fi
    done
    echo "VARIANTS: killed=$killed survived=$survived"; [ "$survived" = 0 ] ;;
  mutants)
    echo "-- baseline: every control against the unmutated migrations"
    run_set "" 1 "$MIG_A" "$MIG_B" "$MIG_C" || { echo "MUTANTS: aborted - baseline not green"; exit 1; }
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    killed=0; survived=0; invalid=0
    while IFS='|' read -r name part; do
      [ -n "$frag" ] && [[ "$name" != *"$frag"* ]] && continue
      case "$part" in A) src="$MIG_A";; B) src="$MIG_B";; C) src="$MIG_C";; *) echo "INVALID|$name|part $part"; invalid=$((invalid+1)); continue;; esac
      if ! python3 "$HERE/lib/mutants.py" apply "$name" "$src" "$tmp/m.sql"; then
        echo "INVALID|$name|mutant did not apply"; invalid=$((invalid+1)); continue; fi
      changed="$(diff "$src" "$tmp/m.sql" | grep '^[<>]' | head -4 | tr '\n' ' ' | cut -c1-240 || true)"
      if [ -z "$changed" ]; then echo "INVALID|$name|mutant changed nothing"; invalid=$((invalid+1)); continue; fi
      echo "== $name  MUTATION APPLIED: $changed"
      case "$part" in A) set -- "$tmp/m.sql" "$MIG_B" "$MIG_C";; B) set -- "$MIG_A" "$tmp/m.sql" "$MIG_C";; C) set -- "$MIG_A" "$MIG_B" "$tmp/m.sql";; esac
      if run_set "" 1 "$@"; then echo "SURVIVED|$name"; survived=$((survived+1)); else echo "KILLED|$name"; killed=$((killed+1)); fi
    done < <(python3 "$HERE/lib/mutants.py" list)
    echo "MUTANTS: killed=$killed survived=$survived invalid=$invalid"
    [ "$survived" = 0 ] && [ "$invalid" = 0 ] && [ "$killed" -gt 0 ] ;;
  rollback)
    RA="$HERE/rollback-A.sql"; RB="$HERE/rollback-B.sql"; RC="$HERE/rollback-C.sql"; rc_all=0
    for spec in "r01-rollback-A-alone:$RA" "r02-rollback-B-alone:$RB" "r03-rollback-C-alone:$RC"; do
      name="${spec%%:*}"; rb="${spec#*:}"
      echo "== $name"
      run_one "$HERE/controls/$name.sql" "$MIG_A" "$MIG_B" "$MIG_C" "$rb" || rc_all=1
      echo "   behaviour after $name (reds expected only for the part rolled back):"
      run_set "" 1 "$MIG_A" "$MIG_B" "$MIG_C" "$rb" || true
    done
    echo "== r04-rollback-all (then lib/pins-3946.sql again)"
    run_one "$HERE/controls/r04-rollback-all.sql" "$MIG_A" "$MIG_B" "$MIG_C" "$RA" "$RB" "$RC" "$HERE/lib/pins-3946.sql" || rc_all=1
    echo "   behaviour after all three rollbacks (= base):"
    run_set "" 1 "$MIG_A" "$MIG_B" "$MIG_C" "$RA" "$RB" "$RC" || true
    echo "ROLLBACK: $([ $rc_all = 0 ] && echo OK || echo FAILED)"; exit $rc_all ;;
  one)      shift; ctl="$1"; shift; run_one "$ctl" "$@" ;;   # one control against an explicit stack
  *) echo "usage: run.sh precheck|controls|twice|base|variants|mutants|rollback [fragment] | one <control> <stack...>"; exit 2 ;;
esac
