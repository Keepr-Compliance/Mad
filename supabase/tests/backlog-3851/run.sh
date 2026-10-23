#!/usr/bin/env bash
# BACKLOG-3851 harness. Each control runs in ONE transaction that ends with ROLLBACK:
#   the BACKLOG-3946 prelude (3917 + 3938 + 3940 layers) and the three 3946 migrations,
#   lib/prod-bodies-3851.sql (venue setup: production's bodies for the objects 3946 leaves
#   different), lib/pins-3851.sql (venue = PRODUCTION TODAY for every object M1/M2 touch,
#   read 2026-10-14 at ledger 20261014152904, else ERROR), lib/harness-3851.sql,
#   lib/fixtures-3851.sql, the stack under test, the control.
# Nothing is ever committed. Two-session controls are in race.sh (a cloned database).
#
#   SSH_HOST=<ssh alias|local> PG_CONTAINER=<container> bash run.sh precheck
#   ... run.sh controls [fragment]   # M1 + M3 (M1 + M2 + M3 for the m-controls)
#   ... run.sh twice    [fragment]   # M1, M2 and M3 each applied twice
#   ... run.sh base     [fragment]   # neither applied (reds expected)
#   ... run.sh mutants  [fragment]   # lib/mutants.py (each must go red)
#   ... run.sh rollback              # rollback-3851.sql after M1 + M2, then the pins again;
#                                    # rollback-3851-m2.sql (r03) and its cleanup (r04)
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
H46="$REPO/supabase/tests/backlog-3946"
PARITY=("$M/20261003160000_backlog_3673_onboarding_completed_backfill.sql"
        "$M/20261008120000_backlog_3759_function_grants.sql"
        "$M/20261010150116_backlog_3843_org_member_client_write_lockdown.sql"
        "$H/lib/prod-bodies-3917.sql")
MIG3917="$M/20261014002359_backlog_3917_member_status_allow_list.sql"
MIG3938="$M/20261014053520_backlog_3938_membership_helpers_caller_only.sql"
MIG3940="$M/20261014061621_backlog_3940_support_links_internal_only.sql"
MIG3946=("$M/20261014152722_backlog_3946_staff_helpers_caller_only.sql"
         "$M/20261014152839_backlog_3946_identity_helpers_signed_in_only.sql"
         "$M/20261014152904_backlog_3946_support_links_table_grants.sql")
M1="${M1_OVERRIDE:-$M/20261015152446_backlog_3851_license_model.sql}"
M2="${M2_OVERRIDE:-$M/20261016100100_backlog_3851_paygo_revert.sql}"
M3="${M3_OVERRIDE:-$M/20261016200000_backlog_3851_scim_seat_refusal.sql}"
RB="$HERE/rollback-3851.sql"; RB3="$HERE/rollback-3851-m3.sql"
RB2="$HERE/rollback-3851-m2.sql"; RBC="$HERE/rollback-3851-m2-paygo-cleanup.sql"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
PGDB="${PGDB:-postgres}"
psql_in() {
  if [ "$SSH_HOST" = local ]; then docker exec -i "$CONTAINER" psql -U postgres -d "$PGDB" -v ON_ERROR_STOP=1 -X -q -tA -f -
  else ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -d $PGDB -v ON_ERROR_STOP=1 -X -q -tA -f -"; fi
}
strip_txn() { grep -viE '^[[:space:]]*(begin|commit)[[:space:]]*;[[:space:]]*$' "$1"; }
venue_fn() { # pg_temp.venue3851() from the same query text production is read with
  echo 'CREATE FUNCTION pg_temp.venue3851() RETURNS TABLE (k text, v text) LANGUAGE sql AS $fp3851$'
  grep -v '^ORDER BY 1;$' "$HERE/lib/fingerprint-3851.sql"
  echo '$fp3851$;'
}

prelude() { # $1: BEGIN or nothing
  [ "${1:-BEGIN}" = BEGIN ] && echo "BEGIN;"
  cat "$H/lib/harness-3917.sql"
  local f; for f in "${PARITY[@]}"; do strip_txn "$f"; done
  cat "$H/lib/fixtures-3917.sql" "$H/lib/preconditions-3917.sql"
  strip_txn "$MIG3917"
  cat "$H8/lib/prod-bodies-3938.sql" "$H8/lib/fixtures-3938.sql" "$H8/lib/pins-3938.sql"
  strip_txn "$MIG3938"; strip_txn "$MIG3940"
  cat "$H46/lib/parity-3946.sql" "$H46/lib/catalog-3946.sql" "$H46/lib/pins-3946.sql" \
      "$H46/lib/fixtures-3946.sql" "$H46/lib/capture-3946.sql"
  for f in "${MIG3946[@]}"; do strip_txn "$f"; done
  cat "$HERE/lib/prod-bodies-3851.sql"
  venue_fn
  cat "$HERE/lib/pins-3851.sql" "$HERE/lib/harness-3851.sql" "$HERE/lib/fixtures-3851.sql"
}
build() { # $1 control, rest: stack files in order
  local ctl="$1"; shift
  prelude BEGIN
  echo "SELECT 'STACK|' || $#;"
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
  if ! echo "$out" | grep -q '^PINS3851 OK'; then echo "ERROR|$(basename "$ctl")|pins not reached"; return 2; fi
  if ! echo "$out" | grep -q '^FIXTURES3851 OK'; then echo "ERROR|$(basename "$ctl")|fixtures not reached"; return 2; fi
  echo "$out" | grep -E '^(PASS|FAIL)\|' || true
  n="$(echo "$out" | sed -n 's/^CHECKS|//p')"
  if [ -z "$n" ] || [ "$n" = "0" ]; then echo "ERROR|$(basename "$ctl")|0 checks"; return 2; fi
  echo "CHECKS|$(basename "$ctl" .sql)|$n"
  if echo "$out" | grep -q '^FAIL|'; then return 1; fi
  return 0
}
stack_for() { # control file -> stack. c*: M1 + M3. m*: M1 + M2 + M3. $2 = twice?
  local c; c="$(basename "$1")"
  case "$c" in
    m*) if [ "${2:-}" = twice ]; then echo "$M1 $M1 $M2 $M2 $M3 $M3"; else echo "$M1 $M2 $M3"; fi ;;
    *)  if [ "${2:-}" = twice ]; then echo "$M1 $M1 $M3 $M3"; else echo "$M1 $M3"; fi ;;
  esac
}
run_set() { # $1 fragment, $2 quiet(0/1), $3 mode (normal|twice|base)
  local frag="$1" quiet="$2" mode="$3"
  local pass=0 fail=0 err=0 checks=0 cf=0 rc c out stack
  for c in "$HERE"/controls/[cm]*.sql; do
    [[ "$(basename "$c")" == *"$frag"* ]] || continue
    case "$mode" in base) stack="";; twice) stack="$(stack_for "$c" twice)";; *) stack="$(stack_for "$c")";; esac
    rc=0
    # shellcheck disable=SC2086
    out="$(run_one "$c" $stack)" || rc=$?
    if [ "$quiet" = 0 ]; then echo "== $(basename "$c" .sql)"; echo "$out"; else echo "$out" | grep -E '^(FAIL|ERROR)\|' | sed "s/^/     $(basename "$c" .sql): /" || true; fi
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
    { prelude BEGIN; echo "SELECT 'venue ledger head=' || max(version) FROM supabase_migrations.schema_migrations;"; echo "ROLLBACK;"; } | psql_in 2>&1 | grep -E 'OK$|head=|ERROR|MISMATCH' ;;
  controls) run_set "$frag" 0 normal || exit 1 ;;
  twice)    run_set "$frag" 0 twice || exit 1 ;;
  base)     run_set "$frag" 0 base || true ;;
  mutants)
    echo "-- baseline: every control against the unmutated migrations"
    run_set "$frag" 1 normal || { echo "MUTANTS: aborted - baseline not green"; exit 1; }
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    killed=0; survived=0; invalid=0
    while IFS='|' read -r name part want; do
      [ -n "${MUTANT:-}" ] && [ "$name" != "$MUTANT" ] && continue
      case "$want" in race:*) continue;; esac   # two-session mutants: run.sh race-mutants
      if ! ls "$HERE"/controls/*"$want"*.sql >/dev/null 2>&1; then echo "INVALID|$name|no control matches $want"; invalid=$((invalid+1)); continue; fi
      case "$part" in M1) src="$M1";; M2) src="$M2";; M3) src="$M3";; *) echo "INVALID|$name|part $part"; invalid=$((invalid+1)); continue;; esac
      if ! python3 "$HERE/lib/mutants.py" apply "$name" "$src" "$tmp/m.sql"; then
        echo "INVALID|$name|mutant did not apply"; invalid=$((invalid+1)); continue; fi
      changed="$(diff "$src" "$tmp/m.sql" | grep '^[<>]' | head -4 | tr '\n' ' ' | cut -c1-240 || true)"
      if [ -z "$changed" ]; then echo "INVALID|$name|mutant changed nothing"; invalid=$((invalid+1)); continue; fi
      echo "== $name  MUTATION APPLIED: $changed"
      case "$part" in M1) export M1_OVERRIDE="$tmp/m.sql";; M2) export M2_OVERRIDE="$tmp/m.sql";; M3) export M3_OVERRIDE="$tmp/m.sql";; esac
      if [ "$part" = M1 ]; then  # M3 as written against the mutated M1 (see mutants.py carry)
        if ! carried="$(python3 "$HERE/lib/mutants.py" carry "$name" "$M3" "$tmp/m3.sql")"; then
          echo "INVALID|$name|carry into M3 failed"; invalid=$((invalid+1)); unset M1_OVERRIDE; continue; fi
        echo "   $carried"; export M3_OVERRIDE="$tmp/m3.sql"
      fi
      M1="${M1_OVERRIDE:-$M/20261015152446_backlog_3851_license_model.sql}"; M2="${M2_OVERRIDE:-$M/20261016100100_backlog_3851_paygo_revert.sql}"; M3="${M3_OVERRIDE:-$M/20261016200000_backlog_3851_scim_seat_refusal.sql}"
      if run_set "$want" 1 normal; then echo "SURVIVED|$name|controls $want"; survived=$((survived+1)); else echo "KILLED|$name|controls $want"; killed=$((killed+1)); fi
      unset M1_OVERRIDE M2_OVERRIDE M3_OVERRIDE
      M1="$M/20261015152446_backlog_3851_license_model.sql"; M2="$M/20261016100100_backlog_3851_paygo_revert.sql"; M3="$M/20261016200000_backlog_3851_scim_seat_refusal.sql"
    done < <(python3 "$HERE/lib/mutants.py" list "$frag")
    echo "MUTANTS: killed=$killed survived=$survived invalid=$invalid"
    [ "$survived" = 0 ] && [ "$invalid" = 0 ] && [ "$killed" -gt 0 ] ;;
  rollback)
    rc_all=0
    echo "== r01-rollback (M1 + M2, seed, rollback-3851.sql)"
    run_one "$HERE/controls/r01-rollback.sql" "$M1" "$M2" "$HERE/lib/seed-rollback-3851.sql" "$RB" || rc_all=1
    echo "== r02-rollback-m1-only (M1, seed, rollback-3851.sql)"
    run_one "$HERE/controls/r02-rollback-m1-only.sql" "$M1" "$HERE/lib/seed-rollback-3851.sql" "$RB" || rc_all=1
    echo "== negative: r01 with NO rollback applied (must go red)"
    if run_one "$HERE/controls/r01-rollback.sql" "$M1" "$M2" "$HERE/lib/seed-rollback-3851.sql" >/dev/null; then echo "FAIL|negative r01 stayed green without the rollback"; rc_all=1; else echo "PASS|negative r01 red without the rollback"; fi
    SNAP="$HERE/lib/snapshot-m1-3851.sql"; CNT="$HERE/lib/count-before-cleanup-3851.sql"
    echo "== r03-rollback-m2 (M1, snapshot, M2, seed, rollback-3851-m2.sql)"
    run_one "$HERE/controls/r03-rollback-m2.sql" "$M1" "$SNAP" "$M2" "$HERE/lib/seed-rollback-3851.sql" "$RB2" || rc_all=1
    echo "== negative: r03 with NO rollback applied (must go red)"
    if run_one "$HERE/controls/r03-rollback-m2.sql" "$M1" "$SNAP" "$M2" "$HERE/lib/seed-rollback-3851.sql" >/dev/null; then echo "FAIL|negative r03 stayed green without the rollback"; rc_all=1; else echo "PASS|negative r03 red without the rollback"; fi
    echo "== r04-rollback-m2-cleanup (r03 stack + count + rollback-3851-m2-paygo-cleanup.sql)"
    run_one "$HERE/controls/r04-rollback-m2-cleanup.sql" "$M1" "$SNAP" "$M2" "$HERE/lib/seed-rollback-3851.sql" "$RB2" "$CNT" "$RBC" || rc_all=1
    echo "== negative: r04 without the cleanup (must go red)"
    if run_one "$HERE/controls/r04-rollback-m2-cleanup.sql" "$M1" "$SNAP" "$M2" "$HERE/lib/seed-rollback-3851.sql" "$RB2" "$CNT" >/dev/null; then echo "FAIL|negative r04 stayed green without the cleanup"; rc_all=1; else echo "PASS|negative r04 red without the cleanup"; fi
    echo "== r05-rollback-m3 (M1, M3, rollback-3851-m3.sql)"
    run_one "$HERE/controls/r05-rollback-m3.sql" "$M1" "$M3" "$RB3" || rc_all=1
    echo "== negative: r05 with NO rollback applied (must go red)"
    if run_one "$HERE/controls/r05-rollback-m3.sql" "$M1" "$M3" >/dev/null; then echo "FAIL|negative r05 stayed green without the rollback"; rc_all=1; else echo "PASS|negative r05 red without the rollback"; fi
    echo "== negative: M3 against a drifted seat-trigger body (pre-check must refuse it)"
    if out="$(run_one "$HERE/controls/c19-scim-seat-refusal.sql" "$M1" "$HERE/lib/drift-seat-trigger-3851.sql" "$M3" 2>&1)"; then echo "FAIL|negative M3 applied over a drifted body"; rc_all=1
    elif echo "$out" | grep -q 'M3 pre-check'; then echo "PASS|negative M3 pre-check refused the drifted body"; else echo "FAIL|negative M3 failed for another reason: $(echo "$out" | head -2 | tr '\n' ' ')"; rc_all=1; fi
    echo "ROLLBACK: $([ $rc_all = 0 ] && echo OK || echo FAILED)"; exit $rc_all ;;
  race) shift; bash "$HERE/race.sh" "${1:-all}" ;;
  race-mutants)  # each two-session mutant against its scenario in race.sh; each must go red
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    killed=0; survived=0; invalid=0
    while IFS='|' read -r name part want; do
      case "$want" in race:*) scen="${want#race:}";; *) continue;; esac
      [ -n "${MUTANT:-}" ] && [ "$name" != "$MUTANT" ] && continue
      if ! python3 "$HERE/lib/mutants.py" apply "$name" "$M1" "$tmp/m.sql"; then echo "INVALID|$name"; invalid=$((invalid+1)); continue; fi
      changed="$(diff "$M1" "$tmp/m.sql" | grep '^[<>]' | head -4 | tr '\n' ' ' | cut -c1-240 || true)"
      [ -z "$changed" ] && { echo "INVALID|$name|changed nothing"; invalid=$((invalid+1)); continue; }
      echo "== $name  MUTATION APPLIED: $changed"
      if out="$(bash "$HERE/race.sh" "$scen" "$tmp/m.sql" 2>&1)"; then echo "$out" | grep -E '^(SETUP\|lockline|PASS|FAIL|CHECKS|ERROR)'; echo "SURVIVED|$name|$scen"; survived=$((survived+1))
      else echo "$out" | grep -E '^(SETUP\|lockline|PASS|FAIL|CHECKS|ERROR)'
        if echo "$out" | grep -q '^FAIL|'; then echo "KILLED|$name|$scen"; killed=$((killed+1)); else echo "INVALID|$name|no FAIL line (setup error?)"; invalid=$((invalid+1)); fi
      fi
    done < <(python3 "$HERE/lib/mutants.py" list "$frag")
    echo "RACE MUTANTS: killed=$killed survived=$survived invalid=$invalid"
    [ "$survived" = 0 ] && [ "$invalid" = 0 ] && [ "$killed" -gt 0 ] ;;
  one) shift; ctl="$1"; shift; run_one "$ctl" "$@" ;;
  emit) shift  # prelude + the given stack, no BEGIN/ROLLBACK wrapper end (race.sh commits it)
    prelude BEGIN; for f in "$@"; do strip_txn "$f"; done ;;
  sql) shift; q="$1"; shift  # probe: prelude, the given stack, a SQL file; raw output; ROLLBACK
    { prelude BEGIN; for f in "$@"; do strip_txn "$f"; done; cat "$q"; echo "ROLLBACK;"; } | psql_in 2>&1 ;;
  *) echo "usage: run.sh precheck|controls|twice|base|mutants|rollback [fragment] | one <control> <stack...>"; exit 2 ;;
esac
