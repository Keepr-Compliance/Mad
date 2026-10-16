#!/usr/bin/env bash
# BACKLOG-3684 harness: an invitation is accepted through its invitation link.
#   A = supabase/migrations/20261016140000_backlog_3684_accept_invitation.sql (additive)
#   B = supabase/migrations/20261016140100_backlog_3684_email_claims_off.sql (subtractive)
#
# A thin wrapper over ../backlog-3851/run.sh `one` / `sql`: every run is ONE transaction
# that ends in ROLLBACK, after the 3851 prelude. Stack: M1, ../backlog-3851-setup/lib/
# pin-setup.sql, M2, ../backlog-3851-setup/lib/helpers-setup.sql, 20261016054316 (S),
# then A, B, lib/helpers-3684.sql.
#
#   SSH_HOST=<alias|local> PG_CONTAINER=<container> bash run.sh controls [fragment]
#   ... run.sh twice    [fragment]   # A twice, B twice
#   ... run.sh a-only                # the 3851-setup controls with A appended: all green
#   ... run.sh after-b               # the 3851-setup controls with A + B: lists the reds
#   ... run.sh mutants  [name]       # lib/mutants.py; each must turn its control red
#   ... run.sh drift                 # A and B abort on unexpected objects; B aborts without A
#   ... run.sh rollback              # rollback-3684-b then -a; negatives
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
M="$REPO/supabase/migrations"
H51="$REPO/supabase/tests/backlog-3851/run.sh"
SET="$REPO/supabase/tests/backlog-3851-setup"
M1="$M/20261015152446_backlog_3851_license_model.sql"
M2="$M/20261016100100_backlog_3851_paygo_revert.sql"
S="$M/20261016054316_backlog_3851_setup_completes_invite.sql"
A_SRC="$M/20261016140000_backlog_3684_accept_invitation.sql"
B_SRC="$M/20261016140100_backlog_3684_email_claims_off.sql"
A="${A_OVERRIDE:-$A_SRC}"; B="${B_OVERRIDE:-$B_SRC}"
PIN="$SET/lib/pin-setup.sql"; HLP="$SET/lib/helpers-setup.sql"; H84="$HERE/lib/helpers-3684.sql"
RBA="$HERE/rollback-3684-a.sql"; RBB="$HERE/rollback-3684-b.sql"
: "${SSH_HOST:?set SSH_HOST}" "${PG_CONTAINER:?set PG_CONTAINER}"

run_set() { # $1 dir glob, $2 fragment, $3 quiet, rest: stack
  local glob="$1" frag="$2" quiet="$3"; shift 3
  local pass=0 fail=0 err=0 checks=0 rc c out
  for c in $glob; do
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
abort_probe() { # $1 expected message fragment, rest: stack. PASS when the stack aborts with it.
  local want="$1"; shift; local q out; q="$(mktemp)"; echo "SELECT 'DRIFT-NOT-REACHED';" > "$q"
  out="$(bash "$H51" sql "$q" "$@" 2>&1 || true)"; rm -f "$q"
  if echo "$out" | grep -q "$want" && ! echo "$out" | grep -q DRIFT-NOT-REACHED; then echo "PASS|aborts: $want"; return 0
  else echo "FAIL|did not abort with: $want"; echo "$out" | grep -E 'ERROR|DRIFT' | head -3; return 1; fi
}

CTL="$HERE/controls/[st]*.sql"
mode="${1:-controls}"; arg="${2:-}"
case "$mode" in
  controls) run_set "$CTL" "$arg" 0 "$M1" "$PIN" "$M2" "$HLP" "$S" "$A" "$B" "$H84" ;;
  twice)    run_set "$CTL" "$arg" 0 "$M1" "$PIN" "$M2" "$HLP" "$S" "$A" "$A" "$B" "$B" "$H84" ;;
  a-only)   run_set "$SET/controls/s*.sql" "$arg" 0 "$M1" "$PIN" "$M2" "$HLP" "$S" "$A" ;;
  after-b)  run_set "$SET/controls/s*.sql" "$arg" 1 "$M1" "$PIN" "$M2" "$HLP" "$S" "$A" "$B" || true ;;
  mutants)
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    killed=0; survived=0; invalid=0
    while IFS='|' read -r name part want; do
      [ -n "$arg" ] && [ "$name" != "$arg" ] && continue
      case "$part" in A) src="$A_SRC";; B) src="$B_SRC";; *) echo "INVALID|$name|part $part"; invalid=$((invalid+1)); continue;; esac
      if ! python3 "$HERE/lib/mutants.py" apply "$name" "$src" "$tmp/m.sql"; then
        echo "INVALID|$name|mutant did not apply"; invalid=$((invalid+1)); continue; fi
      ns="$(git diff --no-index --numstat "$src" "$tmp/m.sql" | cut -f1,2 | tr '\t' ' ' || true)"
      [ -z "$ns" ] && { echo "INVALID|$name|changed nothing"; invalid=$((invalid+1)); continue; }
      echo "== $name  MUTATION APPLIED  numstat $ns"
      if [ "$part" = A ]; then
        # B's pre-check pins file A's bodies; a mutated A must still reach B, so that one
        # check is downgraded to a NOTICE in this run only (the guard is not under test here).
        a="$tmp/m.sql"; b="$tmp/b.sql"
        python3 - "$B_SRC" "$b" <<'PY'
import sys
s = open(sys.argv[1]).read(); k = "RAISE EXCEPTION '3684 B pre-check: file A"
assert s.count(k) == 1; open(sys.argv[2], 'w').write(s.replace(k, "RAISE NOTICE '3684 B pre-check: file A"))
PY
      else a="$A_SRC"; b="$tmp/m.sql"; fi
      out="$(run_set "$CTL" "" 1 "$M1" "$PIN" "$M2" "$HLP" "$S" "$a" "$b" "$H84" 2>&1 || true)"
      echo "$out" | head -8
      if echo "$out" | grep -q "^     ${want}[^:]*: FAIL|"; then echo "KILLED|$name|$want"; killed=$((killed+1))
      else echo "SURVIVED|$name|$want"; survived=$((survived+1)); fi
    done < <(python3 "$HERE/lib/mutants.py" list)
    echo "MUTANTS: killed=$killed survived=$survived invalid=$invalid"
    [ "$survived" = 0 ] && [ "$invalid" = 0 ] && [ "$killed" -gt 0 ] ;;
  drift)
    rc=0
    abort_probe '3684 A pre-check: accept_invitation differs' "$M1" "$PIN" "$M2" "$HLP" "$S" "$HERE/lib/drift-a.sql" "$A" || rc=1
    abort_probe '3684 B pre-check: file A' "$M1" "$PIN" "$M2" "$HLP" "$S" "$B" || rc=1
    abort_probe '3684 B pre-check: users_can_view_own_invite differs' "$M1" "$PIN" "$M2" "$HLP" "$S" "$A" "$HERE/lib/drift-b-policy.sql" "$B" || rc=1
    abort_probe '3684 B pre-check: auto_provision_it_admin body differs' "$M1" "$PIN" "$M2" "$HLP" "$A" "$B" || rc=1
    abort_probe '3684 B pre-check: claim_pending_invite differs' "$M1" "$PIN" "$M2" "$HLP" "$S" "$A" "$HERE/lib/drift-b-acl.sql" "$B" || rc=1
    echo "DRIFT: $([ $rc = 0 ] && echo OK || echo FAILED)"; exit $rc ;;
  rollback)
    rc=0
    echo "== r01 (A, B, rollback-b): production state of every object B touched"
    bash "$H51" one "$HERE/lib/r01-rollback-b.sql" "$M1" "$PIN" "$M2" "$HLP" "$S" "$A" "$B" "$RBB" "$H84" || rc=1
    echo "== negative: r01 without rollback-b (must go red)"
    if bash "$H51" one "$HERE/lib/r01-rollback-b.sql" "$M1" "$PIN" "$M2" "$HLP" "$S" "$A" "$B" "$H84" >/dev/null; then echo "FAIL|negative r01 stayed green"; rc=1
    else echo "PASS|negative r01 red without rollback-b"; fi
    echo "== r02 (A, B, rollback-b, rollback-a): the three functions are gone"
    bash "$H51" one "$HERE/lib/r02-rollback-a.sql" "$M1" "$PIN" "$M2" "$HLP" "$S" "$A" "$B" "$RBB" "$RBA" || rc=1
    echo "== r03 (A, B, rollback-b, A, B): re-apply after the rollback"
    bash "$H51" one "$HERE/lib/r03-reapply.sql" "$M1" "$PIN" "$M2" "$HLP" "$S" "$A" "$B" "$RBB" "$A" "$B" || rc=1
    echo "== negative: rollback-a while B is in force (must abort)"
    abort_probe '3684 rollback A refused' "$M1" "$PIN" "$M2" "$HLP" "$S" "$A" "$B" "$RBA" || rc=1
    echo "ROLLBACK: $([ $rc = 0 ] && echo OK || echo FAILED)"; exit $rc ;;
  *) echo "usage: run.sh controls|twice|a-only|after-b|mutants|drift|rollback [arg]"; exit 2 ;;
esac
