#!/bin/bash
# BACKLOG-4263 S1 two-session controls. TEST DATABASE ONLY. PREREQUISITE: migration 20261123100000 applied (committed).
#
# Usage:
#   run.sh R<n> <run-id> [--mutant]   one case; <run-id> is 16 hex characters chosen BEFORE the run (openssl rand -hex 8)
#                                     so the before-note can name it; fixture email p4263s1cc-<run-id>@example.test
#   run.sh cleanup <run-id>|all       removes leftover fixtures of one run (or of every run) and any *_m4263 function
#
# Unlike harness-s1.sql these COMMIT fixture rows and remove them in the teardown (always, from the trap, then verified).
# Every file sent starts with guard.sql, which refuses any database that is not the test database. Before anything else
# the script refuses to start while any public.*_m4263 function exists.
#   R1  IA writes a new deal and holds its transaction 4 s; IB claims with replace.
#       Expect: the claim waits for the write (server clock: claim end >= write time + 3.5 s), the write applied, IB active.
#       No claim-side mutant: without FOR UPDATE the claim still waits at its UPDATE (it conflicts with the writer's FOR SHARE); R3 carries mutant-claim-nolock.sql.
#   R2  IA confirms its blob and holds 4 s; IB claims with replace.
#       Expect: the claim waits (claim end >= confirm time + 3.5 s); confirm answered object_missing; IB active afterwards.
#       --mutant: mutant-confirm-nolock.sql (confirm without its settings FOR SHARE) -> no wait -> FAIL.
#   R3  (needs one_computer ON) no active computer; IA claims and holds 4 s; IB claims without replace.
#       Expect: IA ok, IB computer_not_active, IA active (exactly one active).
#       --mutant: mutant-claim-nolock.sql in both sessions -> both see no active computer -> both ok -> FAIL.
#   R4  (needs one_computer ON) IA active; IB takes over and holds 4 s; IA's owed turn-off (with IA's install).
#       Expect: the turn-off waits, then answers computer_not_active; both deals still there; Keepr Cloud still on.
#       --mutant: mutant-off-no-active-check.sql (turn-off refusal removed) -> deals deleted -> FAIL.
#   R5  (needs one_computer ON) IA active turns off and holds 4 s; IB claims with replace.
#       Expect: turn-off success; claim not_entitled; no move row. No mutant.
#   R6  (needs one_computer ON) IA active; IB takes over and holds 4 s; IA writes a new deal.
#       Expect: the write waits at its settings lock, then answers computer_not_active; no r6 deal written; IB active.
#       --mutant: mutant-deal-gate-before-lock.sql (gate checked before the settings lock) -> the write passes the gate
#       on the old state, waits, then writes -> FAIL.
# R1 and R2 run with the switch either way. R3-R6 refuse to start unless public.cloud_release_switches.one_computer is
# already true (they never flip it): on the test database that is after the coordinator's flip (after P2 merges).
# --mutant creates ONE new function public.<name>_m4263 (granted to authenticated only); the live functions are never
# replaced. The trap drops it (drop-mutants.sql) and checks that no *_m4263 function is left.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
K=~/.claude/bin/kt-sql
usage() { sed -n '2,33p' "$0"; exit 2; }
CASE="${1:-}"; RUN="${2:-}"; MUT="${3:-}"
umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

guarded() {  # guarded <out> <template>... : guard.sql first, then the templates, placeholders filled
  local out="$1"; shift
  { cat "$here/guard.sql"; echo; for f in "$@"; do cat "$here/$f"; echo; done; } | sed -e "s/__A__/${A:-}/g" -e "s/__O__/${O:-}/g" \
    -e "s/__M__/${M:-}/g" -e "s/__IA__/${IA:-}/g" -e "s/__IB__/${IB:-}/g" -e "s/__RUN__/${RUN}/g" -e "s/__BLOB__/${BLOB:-}/g" \
    -e "s/__ACTIVE__/${ACTIVE:-}/g" -e "s/__PAT__/${PAT:-}/g" -e "s/__CLAIM_FN__/${CLAIM_FN:-}/g" -e "s/__CONFIRM_FN__/${CONFIRM_FN:-}/g" \
    -e "s/__OFF_FN__/${OFF_FN:-}/g" -e "s/__DEAL_FN__/${DEAL_FN:-}/g" > "$tmp/$out"
}
col() { python3 -c 'import json,sys; print(json.load(sys.stdin)[-1][sys.argv[1]])' "$1"; }
mutants_left() { guarded dm.sql drop-mutants.sql; $K "$tmp/dm.sql" | col left; }
count_mutants() {
  printf '%s\n' "SELECT count(*) AS n FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '%\\_m4263';" > "$tmp/cm.tpl"
  { cat "$here/guard.sql"; echo; cat "$tmp/cm.tpl"; } > "$tmp/cm.sql"; $K "$tmp/cm.sql" | col n
}

if [ "$CASE" = cleanup ]; then
  case "$RUN" in all) PAT='%' ;; *) [[ "$RUN" =~ ^[0-9a-f]{16}$ ]] || usage; PAT="$RUN" ;; esac
  echo "CLEANUP pattern p4263s1cc-${PAT}@example.test and any public.*_m4263 function"
  echo "mutant functions left after drop: $(mutants_left)"
  guarded sweep.filled.sql sweep.sql
  out="$($K "$tmp/sweep.filled.sql")"; echo "$out"
  python3 -c 'import json,sys; r=json.loads(sys.argv[1])[-1]; sys.exit(0 if r["users_left"]==0 and r["orgs_left"]==0 and r["mutants_left"]==0 else 1)' "$out" \
    && echo "cleanup verified clean" || { echo "CLEANUP NOT CLEAN" >&2; exit 1; }
  exit 0
fi
case "$CASE" in R1|R2|R3|R4|R5|R6) ;; *) usage ;; esac
[[ "$RUN" =~ ^[0-9a-f]{16}$ ]] || usage
case "$MUT" in ""|--mutant) ;; *) usage ;; esac
MUTANT_FILE=""
if [ "$MUT" = --mutant ]; then
  case "$CASE" in
    R2) MUTANT_FILE=mutant-confirm-nolock.sql ;;
    R3) MUTANT_FILE=mutant-claim-nolock.sql ;;
    R4) MUTANT_FILE=mutant-off-no-active-check.sql ;;
    R6) MUTANT_FILE=mutant-deal-gate-before-lock.sql ;;
    *) echo "${CASE} has no mutant" >&2; exit 2 ;;
  esac
fi
CLAIM_FN=cloud_claim_install; CONFIRM_FN=cloud_confirm_blob; OFF_FN=set_my_cloud_autosave; DEAL_FN=cloud_upsert_deal
case "$MUTANT_FILE" in
  mutant-confirm-nolock.sql) CONFIRM_FN=cloud_confirm_blob_m4263 ;;
  mutant-claim-nolock.sql) CLAIM_FN=cloud_claim_install_m4263 ;;
  mutant-off-no-active-check.sql) OFF_FN=set_my_cloud_autosave_m4263 ;;
  mutant-deal-gate-before-lock.sql) DEAL_FN=cloud_upsert_deal_m4263 ;;
esac

uid() { python3 -c 'import uuid; print(uuid.uuid4())'; }
A="$(uid)"; O="$(uid)"; M="$(uid)"; IA="$(uid)"; IB="$(uid)"; BLOB=""; SETUP_DONE=0; MUTANT_MADE=0; VERDICT=FAIL
case "$CASE" in R3) ACTIVE=none ;; *) ACTIVE=IA ;; esac
echo "RUN ${RUN} case ${CASE}${MUTANT_FILE:+ mutant ${MUTANT_FILE}}: fixture email p4263s1cc-${RUN}@example.test, user ${A}"
echo "  leftovers, if this run is killed: run.sh cleanup ${RUN}"

n="$(count_mutants)"
[ "$n" = 0 ] || { echo "refusing to start: ${n} public.*_m4263 function(s) exist; run: run.sh cleanup all" >&2; exit 1; }

cleanup() {
  rc=$?
  set +e
  trap - EXIT INT TERM
  wait 2>/dev/null
  [ "$INTERRUPTED" = 1 ] && sleep 8
  if [ "$SETUP_DONE" = 1 ]; then
    guarded teardown.filled.sql teardown.sql; $K "$tmp/teardown.filled.sql" >/dev/null
    guarded verify.filled.sql verify.sql
    v="$($K "$tmp/verify.filled.sql" | python3 -c 'import json,sys; print([r for r in json.load(sys.stdin) if "verdict" in r][-1]["verdict"])')"
    if [ "$v" != "clean" ]; then echo "TEARDOWN NOT CLEAN (run ${RUN}): run.sh cleanup ${RUN}" >&2; rc=1; else echo "teardown verified clean"; fi
  fi
  if [ "$MUTANT_MADE" = 1 ]; then
    left="$(mutants_left)"
    if [ "$left" != 0 ]; then echo "MUTANT FUNCTION NOT REMOVED (${left} left): run.sh cleanup all" >&2; rc=1; else echo "mutant function dropped, none left"; fi
  fi
  rm -rf "$tmp"
  echo "${CASE}${MUTANT_FILE:+ (mutant)}: ${VERDICT}"
  [ "$VERDICT" = PASS ] || rc=1
  exit $rc
}
INTERRUPTED=0
trap cleanup EXIT
trap 'INTERRUPTED=1; exit 130' INT TERM

if [ -n "$MUTANT_FILE" ]; then
  MUTANT_MADE=1
  guarded mutant.sql "$MUTANT_FILE"; $K "$tmp/mutant.sql" >/dev/null
fi
guarded setup.filled.sql setup.sql
SETUP_DONE=1
out="$($K "$tmp/setup.filled.sql")"
BLOB="$(echo "$out" | col blob)"; ON="$(echo "$out" | col one_computer)"
[ -n "$BLOB" ] || { echo "setup failed: $out" >&2; exit 1; }
case "$CASE" in R3|R4|R5|R6) [ "$ON" = "True" ] || { echo "${CASE} needs one_computer on (it is ${ON}); not run" >&2; exit 1; } ;; esac

pair() {
  ( $K "$tmp/$1" > "$tmp/first.out" 2>&1 || true ) &
  p1=$!
  sleep 1
  ( $K "$tmp/$2" > "$tmp/second.out" 2>&1 || true ) &
  p2=$!
  wait $p1 $p2
  echo "first:  $(cat "$tmp/first.out")"
  echo "second: $(cat "$tmp/second.out")"
}
case "$CASE" in
  R1) guarded a.sql as-user.sql r1-write-hold.sql; guarded b.sql gate.sql as-user.sql claim-ib-replace.sql ;;
  R2) guarded a.sql as-user.sql r2-confirm-hold.sql; guarded b.sql gate.sql as-user.sql claim-ib-replace.sql ;;
  R3) guarded a.sql as-user.sql r3-claim-ia-hold.sql; guarded b.sql gate.sql as-user.sql r3-claim-ib.sql ;;
  R4) guarded a.sql as-user.sql r4-claim-ib-hold.sql; guarded b.sql gate.sql as-user.sql r4-off-ia.sql ;;
  R5) guarded a.sql as-user.sql r5-off-ia-hold.sql; guarded b.sql gate.sql as-user.sql r5-claim-ib.sql ;;
  R6) guarded a.sql as-user.sql r6-claim-ib-hold.sql; guarded b.sql gate.sql as-user.sql r6-write-ia.sql ;;
esac
pair a.sql b.sql
guarded assert.filled.sql assert.sql
$K "$tmp/assert.filled.sql" > "$tmp/state.out"
echo "state:  $(cat "$tmp/state.out")"

VERDICT="$(python3 - "$CASE" "$tmp/first.out" "$tmp/second.out" "$tmp/state.out" "$IA" "$IB" <<'PY'
import json, sys
from datetime import datetime
case, f1, f2, fs, ia, ib = sys.argv[1:7]
def ts(x):
    try:
        return datetime.fromisoformat(str(x).replace('Z', '+00:00'))
    except Exception:
        return None
def waited(a, b):
    t0, t1 = ts(a.get('t_write')), ts(b.get('t_end'))
    return t0 is not None and t1 is not None and (t1 - t0).total_seconds() >= 3.5
def last_row(p):
    t = open(p).read()
    try:
        r = json.loads(t.split('\nkt-sql:')[0])
        return r[-1] if isinstance(r, list) and r else {}
    except Exception:
        return {}
a, b, st = last_row(f1), last_row(f2), last_row(fs).get('j', {})
ra, rb = a.get('r') or {}, b.get('r') or {}
raw = open(f1).read() + open(f2).read()
ok = '40P01' not in raw
if case == 'R1':
    ok = ok and (ra.get('results') or [{}])[0].get('status') == 'applied' and rb.get('ok') is True \
        and waited(a, b) and st.get('active') == ib and st.get('deal_r1') == 1
elif case == 'R2':
    ok = ok and ra.get('error') == 'object_missing' and rb.get('ok') is True and waited(a, b) and st.get('active') == ib
elif case == 'R3':
    ok = ok and ra.get('ok') is True and rb.get('error') == 'computer_not_active' and st.get('active') == ia and st.get('moves') == 0
elif case == 'R4':
    ok = ok and ra.get('ok') is True and rb.get('error') == 'computer_not_active' and st.get('deals') == 2 \
        and st.get('enabled') is True and st.get('active') == ib
elif case == 'R5':
    ok = ok and ra.get('success') is True and rb.get('error') == 'not_entitled' and st.get('moves') == 0 and st.get('deals') == 0
elif case == 'R6':
    ok = ok and ra.get('ok') is True and rb.get('error') == 'computer_not_active' and st.get('deal_r6') == 0 and st.get('active') == ib
print('PASS' if ok else 'FAIL')
PY
)"
