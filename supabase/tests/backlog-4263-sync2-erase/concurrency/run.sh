#!/bin/bash
# BACKLOG-4263 sync plan P3: two-session controls for the erase job (test project, ~/.claude/bin/kt-sql). WRITTEN, NOT RUN.
# Needs E1 applied on the test project and the coordinator's go, with the fixture user id named in the before-note
# FIRST: the id is an argument, never generated here. Make one with: python3 -c 'import uuid; print(uuid.uuid4())'
#
# Usage: run.sh attach   <fixture-user-id> [single_statement_fence]   P3 condition 1: attach (A) versus orphan sweep (B)
#        run.sh c6g_skip <fixture-user-id> [no_skip_locked]           C-6g (ii): a claim holds the settings row -> skip
#        run.sh c6g_wait <fixture-user-id> [read_before_lock]         C-6g (i):  a batch holds the settings row -> move waits
#        run.sh cleanup  <fixture-user-id> <run-id>                   remove a fixture user the trap did not remove
#
# Order: argument checks -> precheck and the per-table count query (read-only; nothing is created unless both
# are clean) -> own-name copy
# (when the case needs one) -> setup -> the two sessions -> verdict -> trap.
# Precheck refuses when: an auth user has the fixture id; any p4263c-*@example.test user exists; any public.*_m4263
# function exists; any cloud_blob_erase_runs row is marked p4263c; (attach) 900 or more unreferenced blobs are older
# than 24 h (blob X might then not be listed).
# Rows COMMITTED by setup (8): 1 auth.users (email p4263c-<run>@example.test, inserted with session_replication_role =
# replica), 1 cloud_autosave_settings, 2 cloud_deals, 3 cloud_deal_messages, 1 cloud_blobs (no stored object).
# attach's session A commits 1 cloud_deal_files row more (9). Every other session is one DO block that ends in RAISE,
# so its writes (an erase run row marked {"p4263c": 1}; in c6g, the switch set on when it is off) roll back with it.
# Functions: the live cloud_blob_erase_claim / cloud_blob_erase_scrub are NEVER replaced. A mutant, and the pristine
# c6g_wait (which needs a sleep inside the scrub), use a COMMITTED own-name copy public.<function>_m4263 made by
# copyfn.py from the E1 text with one exact-string change (REVOKEd from every API role); the script proves it exists
# (md5 of its body) before the sessions; the trap drops it FIRST and checks that no *_m4263 function is left.
# Gate: session B starts 1 s after A and waits server-side (gate.sql, up to 20 s) until A sleeps in a call whose text
# carries this run's marker; the marker is the first line of A's call (pg_stat_activity.query keeps the first 1 kB).
# Timing: hold 4 s, launch offset 1 s, so B starts ~3 s before A's hold ends; the verdict needs >= 1.5 s (twice that is
# the expected 3 s). Both sessions answer start and end from the database clock (verdict.py). Waited = B ended after
# A's hold ended. lock_timeout: 3 s on every call that writes (setup, copy, drop, delete) and in session A; 8 s in
# session B, which has to outwait A's 4 s hold.
#   attach:   PASS when B waited and fenced = false. Mutant single_statement_fence: CAUGHT when fenced = true.
#   c6g_skip: PASS when B did not wait and state = skipped. Mutant no_skip_locked: CAUGHT when B waited.
#   c6g_wait: PASS when B waited. Mutant read_before_lock (read and sleep BEFORE the lock): CAUGHT when B did not wait.
# Verdict (verdict.py; offline self-test: python3 -I selftest.py): no P_A / P_B marker (an error, a gate or lock
# timeout), a missing time, or no measured overlap is INCONCLUSIVE and exits 1, with or without a mutant.
# Trap: drops the copy; prints the fixture user's row count in every table that references auth.users (catalogue
# query, counts only); deletes the auth user by id and this run's exact email (rows cascade); checks residue and that
# the auth.users total equals the precheck's. Any failure: TEARDOWN NOT CLEAN with the user id, the run id and the
# counts left, and nothing further is deleted. Last call: pg_stat_statements_reset().
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
K=~/.claude/bin/kt-sql
CASE="${1:-}"; U="${2:-}"; MUT="${3:-}"
usage() { sed -n '2,9p' "$0"; exit 2; }
case "$CASE" in attach|c6g_skip|c6g_wait|cleanup) ;; *) usage ;; esac
echo "$U" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || { echo "a fixture user id (lowercase uuid) is required"; usage; }
case "$CASE:$MUT" in attach:|attach:single_statement_fence|c6g_skip:|c6g_skip:no_skip_locked|c6g_wait:|c6g_wait:read_before_lock) ;;
  cleanup:*) [[ "$MUT" =~ ^[0-9a-f]{16}$ ]] || usage ;; *) echo "unknown mutant ${MUT}"; usage ;; esac
umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fill() {  # fill <template> <out>
  sed -e "s/__U__/${U}/g" -e "s/__RUN__/${RUN:-}/g" -e "s/__I1__/${I1:-}/g" -e "s/__I2__/${I2:-}/g" -e "s/__X__/${X:-}/g" \
    -e "s/__D1__/${D1:-}/g" -e "s/__CLAIM_FN__/${CLAIM_FN:-}/g" -e "s/__SCRUB_FN__/${SCRUB_FN:-}/g" \
    -e "s/__COPY_SIG__/${COPY_SIG:-}/g" "$here/$1" > "$tmp/$2"
}
col() { python3 -c 'import json,sys; print(json.load(sys.stdin)[-1][sys.argv[1]])' "$1"; }
stats_reset() { $K -c "select extensions.pg_stat_statements_reset()" >/dev/null 2>&1 || echo "pg_stat_statements_reset failed" >&2; }
copies_left() { fill drop-copies.sql drop.sql; $K "$tmp/drop.sql" 2>/dev/null | col left 2>/dev/null || echo unreadable; }
fk_counts() {  # fk_counts <label>: the non-zero per-table counts of the fixture user; the last line is the total
  fill fk-counts.sql fk.sql
  $K "$tmp/fk.sql" > "$tmp/fk.out" 2>&1 || true
  python3 -I "$here/verdict.py" fkcounts "$1" "$tmp/fk.out"
}
remove_user() {  # 0 when clean; otherwise TEARDOWN NOT CLEAN with the ids and the counts left
  local left after
  fk_counts "before the delete, rows of ${U}" || true
  fill delete.sql del.sql; $K "$tmp/del.sql" > "$tmp/del.out" 2>&1 || true
  fill residue.sql res.sql; $K "$tmp/res.sql" > "$tmp/res.out" 2>&1 || true
  left="$(col n < "$tmp/res.out" 2>/dev/null || echo unreadable)"; after="$(col auth_users < "$tmp/res.out" 2>/dev/null || echo unreadable)"
  total="$(fk_counts "after the delete" | tail -1)" || total=unreadable
  if [ "$left" = 0 ] && [ "$total" = 0 ] && [ "$after" = "$AUTH_BEFORE" ]; then
    echo "residue check: fixture user ${U} and its rows gone (0); auth.users ${AUTH_BEFORE} before, ${after} after"; return 0
  fi
  echo "TEARDOWN NOT CLEAN: user ${U}, run ${RUN}; residue ${left}; rows left ${total}; auth.users ${AUTH_BEFORE} before, ${after} after." >&2
  fk_counts "left behind, rows of ${U}" >&2 || true
  echo "Nothing further was deleted. After review: run.sh cleanup ${U} ${RUN}" >&2
  return 1
}

if [ "$CASE" = cleanup ]; then
  RUN="$MUT"
  $K -c "SELECT (SELECT count(*) FROM auth.users WHERE id = '${U}' AND email IS DISTINCT FROM 'p4263c-${RUN}@example.test') AS n, (SELECT count(*) FROM auth.users WHERE id = '${U}') AS mine, (SELECT count(*) FROM auth.users) AS total" > "$tmp/own.out"
  [ "$(col n < "$tmp/own.out")" = 0 ] || { echo "refusing: ${U} is not the fixture user of run ${RUN}" >&2; exit 3; }
  AUTH_BEFORE=$(( $(col total < "$tmp/own.out") - $(col mine < "$tmp/own.out") ))
  left="$(copies_left)"; [ "$left" = 0 ] || { echo "CLEANUP NOT CLEAN: ${left} *_m4263 function(s) left; nothing deleted" >&2; exit 1; }
  rc=0; remove_user || rc=1
  stats_reset
  exit $rc
fi

CLAIM_FN=cloud_blob_erase_claim; SCRUB_FN=cloud_blob_erase_scrub; COPY=""; COPY_SIG=""
case "$CASE:$MUT" in
  attach:single_statement_fence) COPY=cloud_blob_erase_claim; COPY_SIG='cloud_blob_erase_claim_m4263(boolean,integer,integer)'; CLAIM_FN=cloud_blob_erase_claim_m4263 ;;
  c6g_skip:no_skip_locked|c6g_wait:*) COPY=cloud_blob_erase_scrub; COPY_SIG='cloud_blob_erase_scrub_m4263(uuid,uuid,boolean,integer)'; SCRUB_FN=cloud_blob_erase_scrub_m4263 ;;
esac
RUN="$(openssl rand -hex 8)"
I1="$(python3 -c 'import uuid; print(uuid.uuid4())')"; I2="$(python3 -c 'import uuid; print(uuid.uuid4())')"
echo "RUN ${RUN} case ${CASE} ${MUT:-pristine}: fixture user ${U}, email p4263c-${RUN}@example.test (named in the before-note; deleted by the trap)"
echo "  leftovers, if this run is killed: run.sh cleanup ${U} ${RUN}"

fill precheck.sql pre.sql
$K "$tmp/pre.sql" > "$tmp/pre.out" 2>&1 || { echo "refusing to start: precheck failed: $(head -c 300 "$tmp/pre.out")" >&2; exit 1; }
line="$(python3 -I "$here/verdict.py" precheck "$tmp/pre.out" "$CASE")" || { echo "refusing to start: ${line}" >&2; exit 1; }
AUTH_BEFORE="${line#ok auth_users=}"
FK0="$(fk_counts "precheck, rows of ${U}" 2>/dev/null | tail -1)" || true
[ "$FK0" = 0 ] || { echo "refusing to start: the per-table count query answered ${FK0:-nothing} (needs 0 before setup); nothing was created" >&2; exit 1; }
echo "precheck clean: no fixture user, no *_m4263 function, no marked run row; auth.users ${AUTH_BEFORE}"

SETUP=0; COPY_MADE=0; VERDICT=INCONCLUSIVE
cleanup() {
  rc=$?; set +e; trap - EXIT INT TERM
  wait 2>/dev/null
  # interrupted: the server-side sessions may still hold rows for up to their 4 s hold; wait before the first call
  [ "$INTERRUPTED" = 1 ] && sleep 8
  STOP=0
  if [ "$COPY_MADE" = 1 ]; then
    left="$(copies_left)"
    if [ "$left" != 0 ]; then
      echo "TEARDOWN NOT CLEAN: OWN-NAME COPY NOT REMOVED (${left} left); user ${U}, run ${RUN}; fixture rows NOT deleted" >&2
      fk_counts "left behind, rows of ${U}" >&2; rc=1; STOP=1
    else echo "own-name copy dropped, none left"; fi
  fi
  if [ "$SETUP" = 1 ] && [ "$STOP" = 0 ]; then remove_user || rc=1; fi
  stats_reset
  rm -rf "$tmp"; echo "${CASE} ${MUT:-pristine}: ${VERDICT}"
  case "$VERDICT" in PASS|CAUGHT) ;; *) rc=1 ;; esac
  exit $rc
}
INTERRUPTED=0
trap cleanup EXIT; trap 'INTERRUPTED=1; exit 130' INT TERM

if [ -n "$COPY" ]; then
  E1="${root}/supabase/migrations/20261123110000_backlog_4263_cloud_blob_erase.sql"
  sig="${COPY_SIG#*(}"; sig="${sig%)}"; sig="${sig//,/, }"
  python3 -I "$here/copyfn.py" "$E1" "$COPY" "$sig" "$CASE" "$MUT" > "$tmp/copy.sql"   # refuses unless the change matches once
  COPY_MADE=1
  $K "$tmp/copy.sql" > "$tmp/copy.out" 2>&1 || true
  fill md5.sql md5.sql
  $K "$tmp/md5.sql" > "$tmp/md5.out" 2>&1 || true
  applied="$(python3 -I "$here/verdict.py" applied "${COPY_SIG%%(*}" "$tmp/md5.out")" || { echo "$applied" >&2; exit 1; }
  echo "$applied"
fi

fill setup.sql setup.sql
SETUP=1
$K "$tmp/setup.sql" > "$tmp/setup.out"; echo "setup: $(cat "$tmp/setup.out")"
X="$(col x < "$tmp/setup.out")"; D1="$(col d1 < "$tmp/setup.out")"

case "$CASE" in
  attach)   fill attach-a.sql a.sql; fill attach-b.sql b1.sql ;;
  c6g_skip) fill skip-a.sql a.sql;   fill skip-b.sql b1.sql ;;
  c6g_wait) fill wait-a.sql a.sql;   fill wait-b.sql b1.sql ;;
esac
fill gate.sql g.sql; cat "$tmp/g.sql" "$tmp/b1.sql" > "$tmp/b.sql"

( $K "$tmp/a.sql" > "$tmp/a.out" 2>&1 || true ) & pa=$!
sleep 1
( $K "$tmp/b.sql" > "$tmp/b.out" 2>&1 || true ) & pb=$!
wait $pa $pb
echo "a: $(head -c 1500 "$tmp/a.out")"; echo "b: $(head -c 1500 "$tmp/b.out")"
VERDICT="$(python3 -I "$here/verdict.py" "$CASE" "$MUT" "$tmp/a.out" "$tmp/b.out" || true)"
[ -n "$VERDICT" ] || VERDICT="INCONCLUSIVE: no verdict"
