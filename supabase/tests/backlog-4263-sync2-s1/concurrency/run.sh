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
# replaced. Right after the create the script reads md5(prosrc) of that function and prints MUTATION APPLIED <name> md5 <x>
# (no body -> ERROR, stop); after the sessions it checks the function still exists; the trap drops it (drop-mutants.sql)
# and checks that no *_m4263 function is left.
# Verdict (verdict.py; offline self-test: python3 -I selftest.py): a run without --mutant prints PASS only on the case's
# passing shape, a --mutant run prints RED only on the case's own red shape; anything else, including a session or state
# call that returned no row (a gate timeout, a missing function, a deadlock), prints ERROR. The verdict starts as ERROR.
# Exit status 0 only for PASS or RED.
# ONE RUN AT A TIME: setup refuses while any p4263s1cc-*@example.test fixture user exists (a run in progress, or leftovers:
# run.sh cleanup), and every run refuses while any *_m4263 function exists.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
K=~/.claude/bin/kt-sql
usage() { sed -n '2,44p' "$0"; exit 2; }
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
MUTANT_SIG=""
case "$MUTANT_FILE" in
  mutant-confirm-nolock.sql) CONFIRM_FN=cloud_confirm_blob_m4263; MUTANT_SIG='cloud_confirm_blob_m4263(uuid,uuid,uuid)' ;;
  mutant-claim-nolock.sql) CLAIM_FN=cloud_claim_install_m4263; MUTANT_SIG='cloud_claim_install_m4263(uuid,uuid,boolean)' ;;
  mutant-off-no-active-check.sql) OFF_FN=set_my_cloud_autosave_m4263; MUTANT_SIG='set_my_cloud_autosave_m4263(uuid,boolean,integer,uuid)' ;;
  mutant-deal-gate-before-lock.sql) DEAL_FN=cloud_upsert_deal_m4263; MUTANT_SIG='cloud_upsert_deal_m4263(uuid,jsonb)' ;;
esac
MODE=pristine; [ -n "$MUTANT_FILE" ] && MODE=mutant
mutant_md5() {  # mutant_md5 <out>: md5(prosrc) of the mutant function, through verdict.py applied
  printf '%s\n' "SELECT (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.${MUTANT_SIG}')) AS m;" > "$tmp/md5.tpl"
  { cat "$here/guard.sql"; echo; cat "$tmp/md5.tpl"; } > "$tmp/md5.sql"
  $K "$tmp/md5.sql" > "$tmp/$1" 2>&1 || true
  python3 -I "$here/verdict.py" applied "${MUTANT_SIG%%(*}" "$tmp/$1"
}

uid() { python3 -c 'import uuid; print(uuid.uuid4())'; }
A="$(uid)"; O="$(uid)"; M="$(uid)"; IA="$(uid)"; IB="$(uid)"; BLOB=""; SETUP_DONE=0; MUTANT_MADE=0; VERDICT=ERROR
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
  case "$MODE:$VERDICT" in pristine:PASS|mutant:RED) ;; *) rc=1 ;; esac
  exit $rc
}
INTERRUPTED=0
trap cleanup EXIT
trap 'INTERRUPTED=1; exit 130' INT TERM

if [ -n "$MUTANT_FILE" ]; then
  MUTANT_MADE=1
  guarded mutant.sql "$MUTANT_FILE"; $K "$tmp/mutant.sql" > "$tmp/mutant.out" 2>&1 || true
  applied="$(mutant_md5 applied.out)" || { VERDICT="ERROR: ${applied}"; exit 1; }
  echo "$applied"
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
if [ -n "$MUTANT_FILE" ]; then
  still="$(mutant_md5 still.out)" || { VERDICT="ERROR: the mutant was gone by the end of the case (${still})"; exit 1; }
  echo "mutant still present at the end of the case: ${still#MUTATION APPLIED }"
fi
guarded assert.filled.sql assert.sql
$K "$tmp/assert.filled.sql" > "$tmp/state.out"
echo "state:  $(cat "$tmp/state.out")"

VERDICT="$(python3 -I "$here/verdict.py" "$CASE" "$MODE" "$tmp/first.out" "$tmp/second.out" "$tmp/state.out" "$IA" "$IB" || true)"
[ -n "$VERDICT" ] || VERDICT="ERROR: no verdict"
