#!/usr/bin/env bash
# BACKLOG-3851 PR-2 piece 1 harness: /setup completes an invite
# (supabase/migrations/20261016054316_backlog_3851_setup_completes_invite.sql = NEW).
#
# A thin wrapper over ../backlog-3851/run.sh `one` / `sql`: every run is ONE transaction
# that ends in ROLLBACK, after the 3851 prelude (venue = production pins, fixtures).
# Stack: M1 (20261015152446), lib/pin-setup.sql (venue = production read 2026-10-15,
# else ERROR), M2 (20261016100100), lib/helpers-setup.sql, NEW.
#
#   SSH_HOST=<alias|local> PG_CONTAINER=<container> bash run.sh controls [fragment]
#   ... run.sh base     [fragment]   # without NEW: today's body (reds expected)
#   ... run.sh twice    [fragment]   # NEW applied twice
#   ... run.sh mutants  [name]       # lib/mutants.py; each must turn its control red
#   ... run.sh drift                 # NEW aborts on an unexpected body
#   ... run.sh rollback              # rollback-3851-setup.sql restores the 3882 body
#   ... run.sh race     [NEW file]   # S14, two sessions (race.sh)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
M="$REPO/supabase/migrations"
H51="$REPO/supabase/tests/backlog-3851/run.sh"
M1="$M/20261015152446_backlog_3851_license_model.sql"
M2="$M/20261016100100_backlog_3851_paygo_revert.sql"
NEW="${NEW_OVERRIDE:-$M/20261016054316_backlog_3851_setup_completes_invite.sql}"
PIN="$HERE/lib/pin-setup.sql"; HLP="$HERE/lib/helpers-setup.sql"; RB="$HERE/rollback-3851-setup.sql"
: "${SSH_HOST:?set SSH_HOST}" "${PG_CONTAINER:?set PG_CONTAINER}"

run_set() { # $1 fragment, $2 quiet, rest: stack
  local frag="$1" quiet="$2"; shift 2
  local pass=0 fail=0 err=0 checks=0 rc c out
  for c in "$HERE"/controls/s*.sql; do
    [[ "$(basename "$c")" == *"$frag"* ]] || continue
    rc=0; out="$(bash "$H51" one "$c" "$@")" || rc=$?
    if [ "$rc" = 0 ] && ! echo "$out" | grep -q '^CHECKS|'; then rc=2; fi
    if [ "$quiet" = 0 ]; then echo "== $(basename "$c" .sql)"; echo "$out"
    else echo "$out" | grep -E '^(FAIL|ERROR)\|' | sed "s/^/     $(basename "$c" .sql): /" || true; fi
    checks=$((checks + $(echo "$out" | grep -cE '^(PASS|FAIL)\|' || true)))
    case $rc in 0) pass=$((pass+1));; 1) fail=$((fail+1));; *) err=$((err+1));; esac
  done
  echo "CONTROLS: pass=$pass fail=$fail error=$err checks=$checks"
  [ "$fail" = 0 ] && [ "$err" = 0 ] && [ "$pass" -gt 0 ] && [ "$checks" -gt 0 ]
}

mode="${1:-controls}"; arg="${2:-}"
case "$mode" in
  controls) run_set "$arg" 0 "$M1" "$PIN" "$M2" "$HLP" "$NEW" ;;
  base)     run_set "$arg" 0 "$M1" "$PIN" "$HLP" || true ;;
  twice)    run_set "$arg" 0 "$M1" "$PIN" "$M2" "$HLP" "$NEW" "$NEW" ;;
  mutants)
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    killed=0; survived=0; invalid=0
    while IFS='|' read -r name want; do
      [ -n "$arg" ] && [ "$name" != "$arg" ] && continue
      case "$want" in race:*) continue;; esac
      if ! python3 "$HERE/lib/mutants.py" apply "$name" "$M/20261016054316_backlog_3851_setup_completes_invite.sql" "$tmp/new.sql"; then
        echo "INVALID|$name|mutant did not apply"; invalid=$((invalid+1)); continue; fi
      echo "numstat|$(git diff --no-index --numstat "$M/20261016054316_backlog_3851_setup_completes_invite.sql" "$tmp/new.sql" | cut -f1,2 || true)"
      out="$(run_set "" 1 "$M1" "$PIN" "$M2" "$HLP" "$tmp/new.sql" 2>&1 || true)"
      echo "$out"
      if echo "$out" | grep -q "^     ${want}[^:]*: FAIL|"; then echo "KILLED|$name|$want"; killed=$((killed+1))
      else echo "SURVIVED|$name|$want"; survived=$((survived+1)); fi
    done < <(python3 "$HERE/lib/mutants.py" list)
    echo "MUTANTS: killed=$killed survived=$survived invalid=$invalid"
    [ "$survived" = 0 ] && [ "$invalid" = 0 ] && [ "$killed" -gt 0 ] ;;
  drift)
    q="$(mktemp)"; echo "SELECT 'DRIFT-NOT-REACHED';" > "$q"
    out="$(bash "$H51" sql "$q" "$M1" "$PIN" "$M2" "$HLP" "$HERE/lib/drift-body.sql" "$NEW" 2>&1 || true)"; rm -f "$q"
    echo "$out" | grep -E 'pre-check|DRIFT' | head -3
    if echo "$out" | grep -q '3851 setup pre-check: auto_provision_it_admin body differs' && ! echo "$out" | grep -q DRIFT-NOT-REACHED; then
      echo "PASS|drift: NEW aborts on an unexpected body"; else echo "FAIL|drift: NEW did not abort"; exit 1; fi ;;
  rollback)
    rc_all=0
    echo "== r01 (M1, M2, NEW, rollback)"; bash "$H51" one "$HERE/controls/r01-rollback.sql" "$M1" "$PIN" "$M2" "$HLP" "$NEW" "$RB" || rc_all=1
    echo "== negative: r01 without the rollback (must go red)"
    if bash "$H51" one "$HERE/controls/r01-rollback.sql" "$M1" "$PIN" "$M2" "$HLP" "$NEW" >/dev/null; then echo "FAIL|negative r01 stayed green"; rc_all=1
    else echo "PASS|negative r01 red without the rollback"; fi
    echo "ROLLBACK: $([ $rc_all = 0 ] && echo OK || echo FAILED)"; exit $rc_all ;;
  race) bash "$HERE/race.sh" "${arg:-$NEW}" ;;
  *) echo "usage: run.sh controls|base|twice|mutants|drift|rollback|race [arg]"; exit 2 ;;
esac
