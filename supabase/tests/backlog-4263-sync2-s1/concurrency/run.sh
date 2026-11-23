#!/bin/bash
# BACKLOG-4263 S1 two-session controls. TEST DATABASE ONLY. WRITTEN, NOT RUN against a database. Needs 20261123100000 applied.
#
# Usage:
#   run.sh R<n> <run-id> <fixture-user-id> [--mutant]   one case. <run-id> is 16 hex characters and <fixture-user-id> a
#                                     lowercase uuid, both chosen BEFORE the run so the before-note can name them
#                                     (openssl rand -hex 8; python3 -c 'import uuid; print(uuid.uuid4())'). The fixture
#                                     email is p4263s1cc-<run-id>@example.test.
#   run.sh cleanup <run-id> <fixture-user-id>   removes what a run left behind: any *_m4263 function, then the rows of
#                                     that one fixture user (only when its email is that run's fixture address)
#
# Unlike harness-s1.sql these COMMIT fixture rows and remove them in the teardown (always, from the trap, then verified).
# Every file sent starts with guard.sql, which refuses any database that is not the test database; the session-1 file
# starts with its hold marker, before the guard (see "Gate" below).
# Order of a run: argument checks -> precheck and the per-table count query (read-only; nothing is created unless
# both are clean) -> mutant
# create (--mutant only) -> setup -> the two sessions -> state -> verdict -> trap.
# Precheck refuses when: an auth user has the fixture id; an auth user has a p4263s1cc-*@example.test address; any
# public.*_m4263 function exists; or (R3-R6) public.cloud_release_switches.one_computer is not already true. The
# switch is never flipped here (it is a shared row; the coordinator flips it).
#   R1  IA writes a new deal and holds its transaction 4 s; IB claims with replace.
#       Expect: the claim waits for the write (ends after the holder's t_end), the write applied, IB active.
#       No claim-side mutant: without FOR UPDATE the claim still waits at its UPDATE (it conflicts with the writer's FOR SHARE); R3 carries mutant-claim-nolock.sql.
#   R2  IA confirms its blob and holds 4 s; IB claims with replace.
#       Expect: the claim waits; confirm answered object_missing; IB active afterwards.
#       --mutant: mutant-confirm-nolock.sql (confirm without its settings FOR SHARE) -> no wait -> RED.
#   R3  (needs one_computer ON) no active computer; IA claims and holds 4 s; IB claims without replace.
#       Expect: IB waits, IA ok, IB computer_not_active, IA active (exactly one active).
#       --mutant: mutant-claim-nolock.sql in both sessions -> both see no active computer -> both ok -> RED.
#   R4  (needs one_computer ON) IA active; IB takes over and holds 4 s; IA's owed turn-off (with IA's install).
#       Expect: the turn-off waits, then answers computer_not_active; both deals still there; Keepr Cloud still on.
#       --mutant: mutant-off-check-before-lock.sql (the active check read before the settings lock; serially it still
#       refuses) -> reads the old state during the hold, waits, then deletes -> RED.
#   R5  (needs one_computer ON) IA active turns off and holds 4 s; IB claims with replace.
#       Expect: the claim waits; turn-off success; claim not_entitled; no move row. No mutant.
#   R6  (needs one_computer ON) IA active; IB takes over and holds 4 s; IA writes a new deal.
#       Expect: the write waits at its settings lock, then answers computer_not_active; no r6 deal written; IB active.
#       --mutant: mutant-deal-gate-before-lock.sql (gate checked before the settings lock) -> RED.
# --mutant creates ONE new function public.<name>_m4263 (granted to authenticated only); the live functions are never
# replaced. Right after the create the script reads md5(prosrc) of that function and prints MUTATION APPLIED <name> md5 <x>
# (no body -> ERROR, stop); after the sessions it checks the function still exists; the trap drops it FIRST
# (drop-mutants.sql) and checks that no *_m4263 function is left.
# Gate: session 2 starts 1 s after session 1 and waits server-side (gate.sql, up to 20 s) until session 1 sleeps in a
# call whose text carries this run's marker. The marker is the first line of session 1's call (pg_stat_activity.query
# keeps only the first 1 kB of a call on the test project); offline_check.py fails when it ends past byte 900.
# Overlap: both sessions return their start and end from the database clock. The verdict needs session 2 to start
# after session 1's call and at least 1.5 s before session 1's hold ends (hold 4 s - launch offset 1 s = ~3 s expected,
# twice the 1.5 s needed); without that it is INCONCLUSIVE. "Waited" = session 2 ended after session 1's hold ended.
# Verdict (verdict.py; offline self-test: python3 -I selftest.py): a run without --mutant prints PASS only on the case's
# passing shape, a --mutant run prints RED only on the case's own red shape; a session or state call that returned no
# row (an error, a gate timeout, a missing function, a deadlock) prints ERROR; sessions that did not overlap print
# INCONCLUSIVE. The verdict starts as ERROR. Exit status 0 only for PASS or RED.
# Trap: drops the mutant (if made) and checks none is left; prints the fixture user's row count in every table that
# references auth.users (catalogue query, counts only); deletes by the fixture user id (teardown.sql); verifies
# (verify.sql, every count 0, auth.users total equal to the precheck's). Any failure: TEARDOWN NOT CLEAN with the user
# id, the run id and the counts left, and nothing further is deleted. Last call: pg_stat_statements_reset().
# Every call that writes (mutant create and drop, setup, teardown) runs with lock_timeout 3 s; no table-level lock.
# ONE RUN AT A TIME: the precheck and setup refuse while any p4263s1cc-*@example.test fixture user exists.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
K=~/.claude/bin/kt-sql
usage() { sed -n '2,10p' "$0"; exit 2; }
CASE="${1:-}"; RUN="${2:-}"; A="${3:-}"; MUT="${4:-}"
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
case "$CASE" in R1|R2|R3|R4|R5|R6|cleanup) ;; *) usage ;; esac
[[ "$RUN" =~ ^[0-9a-f]{16}$ ]] || usage
[[ "$A" =~ $UUID_RE ]] || { echo "a fixture user id (lowercase uuid) is required" >&2; usage; }
case "$MUT" in ""|--mutant) ;; *) usage ;; esac
umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fill() {
  sed -e "s/__A__/${A:-}/g" -e "s/__O__/${O:-}/g" \
    -e "s/__M__/${M:-}/g" -e "s/__IA__/${IA:-}/g" -e "s/__IB__/${IB:-}/g" -e "s/__RUN__/${RUN}/g" -e "s/__BLOB__/${BLOB:-}/g" \
    -e "s/__ACTIVE__/${ACTIVE:-}/g" -e "s/__CLAIM_FN__/${CLAIM_FN:-}/g" -e "s/__CONFIRM_FN__/${CONFIRM_FN:-}/g" \
    -e "s/__OFF_FN__/${OFF_FN:-}/g" -e "s/__DEAL_FN__/${DEAL_FN:-}/g"
}
guarded() {  # guarded <out> <template>... : guard.sql first, then the templates, placeholders filled
  local out="$1"; shift
  { cat "$here/guard.sql"; echo; for f in "$@"; do cat "$here/$f"; echo; done; } | fill > "$tmp/$out"
}
holder() {  # holder <out> <template>... : the hold marker first, then guard.sql and the templates
  local out="$1"; shift
  { cat "$here/hold-marker.sql"; cat "$here/guard.sql"; echo; for f in "$@"; do cat "$here/$f"; echo; done; } | fill > "$tmp/$out"
}
col() { python3 -c 'import json,sys; print(json.load(sys.stdin)[-1][sys.argv[1]])' "$1"; }
mutants_left() { guarded dm.sql lock-timeout.sql drop-mutants.sql; $K "$tmp/dm.sql" | col left; }
fk_counts() {  # fk_counts <label>: prints the non-zero per-table counts of the fixture user; the last line is the total
  guarded fk.sql fk-counts.sql
  $K "$tmp/fk.sql" > "$tmp/fk.out" 2>&1 || true
  python3 -I "$here/verdict.py" fkcounts "$1" "$tmp/fk.out"
}
auth_total() { guarded ac.sql auth-count.sql; $K "$tmp/ac.sql" | col n; }
stats_reset() { $K -c "select extensions.pg_stat_statements_reset()" >/dev/null 2>&1 || echo "pg_stat_statements_reset failed" >&2; }
teardown() {  # 0 when clean; otherwise TEARDOWN NOT CLEAN with the ids and the counts left
  local v total after
  fk_counts "before the delete, rows of ${A}" || true
  guarded teardown.filled.sql lock-timeout.sql teardown.sql
  $K "$tmp/teardown.filled.sql" > "$tmp/teardown.out" 2>&1 || true
  guarded verify.filled.sql verify.sql
  v="$($K "$tmp/verify.filled.sql" 2>/dev/null | python3 -c 'import json,sys; print([r for r in json.load(sys.stdin) if "verdict" in r][-1]["verdict"])' 2>/dev/null || echo unreadable)"
  total="$(fk_counts "after the delete" | tail -1)" || total=unreadable
  after="$(auth_total 2>/dev/null || echo unreadable)"
  if [ "$v" = clean ] && [ "$total" = 0 ] && [ "$after" = "$AUTH_BEFORE" ]; then
    echo "teardown verified clean (auth.users ${AUTH_BEFORE} before, ${after} after)"; return 0
  fi
  echo "TEARDOWN NOT CLEAN: user ${A}, run ${RUN}; verify ${v}; rows left ${total}; auth.users ${AUTH_BEFORE} before, ${after} after." >&2
  fk_counts "left behind, rows of ${A}" >&2 || true
  echo "Nothing further was deleted. After review: run.sh cleanup ${RUN} ${A}" >&2
  return 1
}
precheck() {  # one read-only call; sets AUTH_BEFORE and ON; refuses (exit 1) unless clean, before anything is created
  guarded pre.sql precheck.sql
  $K "$tmp/pre.sql" > "$tmp/pre.out" 2>&1 || { echo "refusing to start: precheck failed: $(head -c 300 "$tmp/pre.out")" >&2; exit 1; }
  local line
  line="$(python3 -I "$here/verdict.py" precheck "$tmp/pre.out" "$1")" || { echo "refusing to start: ${line}" >&2; exit 1; }
  AUTH_BEFORE="${line#ok auth_users=}"; AUTH_BEFORE="${AUTH_BEFORE%% *}"; ON="${line##* one_computer=}"
}

if [ "$CASE" = cleanup ]; then
  echo "CLEANUP run ${RUN}, fixture user ${A} (only if its email is p4263s1cc-${RUN}@example.test), and any public.*_m4263 function"
  guarded own.sql
  printf '%s\n' "SELECT (SELECT count(*) FROM auth.users WHERE id = '${A}'::uuid AND email IS DISTINCT FROM 'p4263s1cc-${RUN}@example.test') AS n," \
    "       (SELECT count(*) FROM auth.users WHERE id = '${A}'::uuid) AS mine, (SELECT count(*) FROM auth.users) AS total;" >> "$tmp/own.sql"
  $K "$tmp/own.sql" > "$tmp/own.out"
  [ "$(col n < "$tmp/own.out")" = 0 ] || { echo "refusing: ${A} is not the fixture user of run ${RUN}" >&2; exit 3; }
  AUTH_BEFORE=$(( $(col total < "$tmp/own.out") - $(col mine < "$tmp/own.out") ))
  left="$(mutants_left)"; [ "$left" = 0 ] || { echo "CLEANUP NOT CLEAN: ${left} *_m4263 function(s) left; nothing deleted" >&2; exit 1; }
  rc=0; teardown || rc=1
  stats_reset
  exit $rc
fi

MUTANT_FILE=""
if [ "$MUT" = --mutant ]; then
  case "$CASE" in
    R2) MUTANT_FILE=mutant-confirm-nolock.sql ;;
    R3) MUTANT_FILE=mutant-claim-nolock.sql ;;
    R4) MUTANT_FILE=mutant-off-check-before-lock.sql ;;
    R6) MUTANT_FILE=mutant-deal-gate-before-lock.sql ;;
    *) echo "${CASE} has no mutant" >&2; exit 2 ;;
  esac
fi
CLAIM_FN=cloud_claim_install; CONFIRM_FN=cloud_confirm_blob; OFF_FN=set_my_cloud_autosave; DEAL_FN=cloud_upsert_deal
MUTANT_SIG=""
case "$MUTANT_FILE" in
  mutant-confirm-nolock.sql) CONFIRM_FN=cloud_confirm_blob_m4263; MUTANT_SIG='cloud_confirm_blob_m4263(uuid,uuid,uuid)' ;;
  mutant-claim-nolock.sql) CLAIM_FN=cloud_claim_install_m4263; MUTANT_SIG='cloud_claim_install_m4263(uuid,uuid,boolean)' ;;
  mutant-off-check-before-lock.sql) OFF_FN=set_my_cloud_autosave_m4263; MUTANT_SIG='set_my_cloud_autosave_m4263(uuid,boolean,integer,uuid)' ;;
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
O="$(uid)"; M="$(uid)"; IA="$(uid)"; IB="$(uid)"; BLOB=""; SETUP_DONE=0; MUTANT_MADE=0; VERDICT=ERROR; AUTH_BEFORE=""; ON=""
case "$CASE" in R3) ACTIVE=none ;; *) ACTIVE=IA ;; esac
echo "RUN ${RUN} case ${CASE}${MUTANT_FILE:+ mutant ${MUTANT_FILE}}: fixture user ${A}, email p4263s1cc-${RUN}@example.test"
echo "  leftovers, if this run is killed: run.sh cleanup ${RUN} ${A}"

case "$CASE" in R3|R4|R5|R6) NEED_ON=1 ;; *) NEED_ON=0 ;; esac
precheck "$NEED_ON"
FK0="$(fk_counts "precheck, rows of ${A}" 2>/dev/null | tail -1)" || true
[ "$FK0" = 0 ] || { echo "refusing to start: the per-table count query answered ${FK0:-nothing} (needs 0 before setup); nothing was created" >&2; exit 1; }
echo "precheck clean: no fixture user, no *_m4263 function; auth.users ${AUTH_BEFORE}; one_computer ${ON}"

cleanup() {
  rc=$?
  set +e
  trap - EXIT INT TERM
  wait 2>/dev/null
  [ "$INTERRUPTED" = 1 ] && sleep 8
  STOP=0
  if [ "$MUTANT_MADE" = 1 ]; then
    left="$(mutants_left)"
    if [ "$left" != 0 ]; then
      echo "TEARDOWN NOT CLEAN: MUTANT FUNCTION NOT REMOVED (${left} left); user ${A}, run ${RUN}; fixture rows NOT deleted" >&2
      fk_counts "left behind, rows of ${A}" >&2; rc=1; STOP=1
    else echo "mutant function dropped, none left"; fi
  fi
  if [ "$SETUP_DONE" = 1 ] && [ "$STOP" = 0 ]; then teardown || rc=1; fi
  stats_reset
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
  guarded mutant.sql lock-timeout.sql "$MUTANT_FILE"; $K "$tmp/mutant.sql" > "$tmp/mutant.out" 2>&1 || true
  applied="$(mutant_md5 applied.out)" || { VERDICT="ERROR: ${applied}"; exit 1; }
  echo "$applied"
fi
guarded setup.filled.sql lock-timeout.sql setup.sql
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
  R1) holder a.sql as-user.sql r1-write-hold.sql end-hold.sql; guarded b.sql gate.sql as-user.sql claim-ib-replace.sql end.sql ;;
  R2) holder a.sql as-user.sql r2-confirm-hold.sql end-hold.sql; guarded b.sql gate.sql as-user.sql claim-ib-replace.sql end.sql ;;
  R3) holder a.sql as-user.sql r3-claim-ia-hold.sql end-hold.sql; guarded b.sql gate.sql as-user.sql r3-claim-ib.sql end.sql ;;
  R4) holder a.sql as-user.sql r4-claim-ib-hold.sql end-hold.sql; guarded b.sql gate.sql as-user.sql r4-off-ia.sql end.sql ;;
  R5) holder a.sql as-user.sql r5-off-ia-hold.sql end-hold.sql; guarded b.sql gate.sql as-user.sql r5-claim-ib.sql end.sql ;;
  R6) holder a.sql as-user.sql r6-claim-ib-hold.sql end-hold.sql; guarded b.sql gate.sql as-user.sql r6-write-ia.sql end.sql ;;
esac
pair a.sql b.sql
if [ -n "$MUTANT_FILE" ]; then
  still="$(mutant_md5 still.out)" || { VERDICT="ERROR: the mutant was gone by the end of the case (${still})"; exit 1; }
  echo "mutant still present at the end of the case: ${still#MUTATION APPLIED }"
fi
guarded assert.filled.sql assert.sql
$K "$tmp/assert.filled.sql" > "$tmp/state.out" 2>&1 || true
echo "state:  $(cat "$tmp/state.out")"

VERDICT="$(python3 -I "$here/verdict.py" "$CASE" "$MODE" "$tmp/first.out" "$tmp/second.out" "$tmp/state.out" "$IA" "$IB" || true)"
[ -n "$VERDICT" ] || VERDICT="ERROR: no verdict"
