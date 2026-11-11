#!/bin/bash
# BACKLOG-4236 two-session controls. PREREQUISITE: both migrations applied (committed) on the test
# project. Each case: setup (committed fixtures, ids random per run) -> two parallel kt-sql calls,
# the second started 1 s after the first and held by gate.sql until the first is seen in its hold
# -> assert -> automated verdict -> teardown + verify (always,
# from the trap). Prints PASS or FAIL per case and exits non-zero on FAIL or on a dirty teardown.
#   C1a  new-row writes (a new deal, a new blob) holding their transaction, then turn-off.
#        Expect: deal applied, blob ok, turn-off success; afterwards no deal and no live new blob.
#        Mutant: in set_my_cloud_autosave drop the settings FOR UPDATE AND move the settings UPDATE
#        after the DELETE and the fence -> the DELETE runs before the writes commit and cannot see
#        them -> the new deal and blob are left.
#   C1b  turn-off holding its transaction, then the same new-row writes.
#        Expect: turn-off success, both writes {"error":"not_entitled"}; no new deal, no new blob.
#        Mutant S_C1b_deal_share_after_check: in cloud_upsert_deal only, move the settings FOR SHARE after
#        the entitlement check -> the check passes on the old state, the write waits, then inserts after
#        the turn-off committed -> d applied (b stays not_entitled) and a new deal is left.
#   C2   one session holds the deal row, then upserts the message; the other tombstones that message.
#        Expect: no 40P01; upsert applied; tombstone removed.
#        Mutant: in cloud_tombstone remove the /*TOMB:lockdeals*/ statement -> 40P01 in one session.
#   C3   two registrations of the same content, the first uncommitted for 3 s.
#        Expect: both ok with the same blob_id; one live blob with that content.
#        Mutant: remove the ON CONFLICT ... DO NOTHING in cloud_register_blob -> ERR 23505.
#   C4   two file upserts on two deals attaching the same two blobs in opposite payload order; the
#        first session holds the lower-id blob first.
#        Expect: no 40P01; both results ok with every row applied.
#        Mutant S_C4_blobs_locked_per_row_payload_order: drop /*FILE:lockblobs*/ and lock each blob FOR
#        UPDATE at its per-row lookup (payload order) -> 40P01. (F02, no blob lock at all, stays green.)
# Mutant names are the modes of concurrency/mutants.py (C1a S_C1a_turnoff_unlocked_update_late, C2
# S_C2_tombstone_no_deal_lock, C3 S_C3_register_no_on_conflict). `mutants.py emit <dir>` writes, per
# mode, a one-function CREATE OR REPLACE for the mutant and for the pristine text; apply the mutant,
# re-run the case, apply the pristine file. Mutant results above are predicted, not run.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
K=~/.claude/bin/kt-sql
case "${1:-}" in C1a|C1b|C2|C3|C4) ;; *) sed -n '2,31p' "$0"; exit 2 ;; esac
CASE="$1"

umask 077
tmp="$(mktemp -d)"
RUN="$(openssl rand -hex 8)"
uid() { python3 -c 'import uuid; print(uuid.uuid4())'; }
A="$(uid)"; O="$(uid)"; M="$(uid)"; I="$(uid)"
DEAL=""; MSG=""; DEAL4A=""; DEAL4B=""; LOW_SHA=""; LOW_ID=""; HIGH_SHA=""; SETUP_DONE=0; VERDICT=FAIL

fill() {  # fill <out> <template>...
  local out="$1"; shift
  for f in "$@"; do cat "$here/$f"; echo; done | sed -e "s/__A__/${A}/g" -e "s/__O__/${O}/g" -e "s/__M__/${M}/g" \
    -e "s/__I__/${I}/g" -e "s/__RUN__/${RUN}/g" -e "s/__DEAL__/${DEAL}/g" -e "s/__MSG__/${MSG}/g" \
    -e "s/__DEAL4A__/${DEAL4A}/g" -e "s/__DEAL4B__/${DEAL4B}/g" -e "s/__LOW_SHA__/${LOW_SHA}/g" \
    -e "s/__LOW_ID__/${LOW_ID}/g" -e "s/__HIGH_SHA__/${HIGH_SHA}/g" > "$tmp/$out"
}
col() { python3 -c 'import json,sys; print(json.load(sys.stdin)[0][sys.argv[1]] or "")' "$1"; }

cleanup() {
  rc=$?
  set +e
  trap - EXIT INT TERM
  # sessions still running hold row locks; let them end before the teardown reads the rows
  wait 2>/dev/null
  [ "$INTERRUPTED" = 1 ] && sleep 8  # a killed client leaves its server transaction running (holds <= 6 s)
  if [ "$SETUP_DONE" = 1 ]; then
    fill teardown.filled.sql teardown.sql; $K "$tmp/teardown.filled.sql" >/dev/null
    fill verify.filled.sql verify.sql
    v="$($K "$tmp/verify.filled.sql" | python3 -c 'import json,sys; print([r for r in json.load(sys.stdin) if "verdict" in r][-1]["verdict"])')"
    if [ "$v" != "clean" ]; then
      echo "TEARDOWN NOT CLEAN (run ${RUN}, user ${A}): fixture rows are left" >&2
      rc=1
    else
      echo "teardown verified clean"
    fi
  fi
  rm -rf "$tmp"
  echo "${CASE}: ${VERDICT}"
  [ "$VERDICT" = PASS ] || rc=1
  exit $rc
}
INTERRUPTED=0
trap cleanup EXIT
trap 'INTERRUPTED=1; exit 130' INT TERM

fill setup.filled.sql setup.sql
SETUP_DONE=1
out="$($K "$tmp/setup.filled.sql")"
DEAL="$(echo "$out" | col deal)"; MSG="$(echo "$out" | col message)"
DEAL4A="$(echo "$out" | col deal4a)"; DEAL4B="$(echo "$out" | col deal4b)"
LOW_SHA="$(echo "$out" | col low_sha)"; LOW_ID="$(echo "$out" | col low_id)"; HIGH_SHA="$(echo "$out" | col high_sha)"
[ -n "$DEAL" ] && [ -n "$MSG" ] && [ -n "$LOW_ID" ] || { echo "setup failed: $out" >&2; exit 1; }

pair() {  # first now, second 1 s later (it waits server-side in gate.sql for the first's hold)
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
  C1a) fill a.sql as-user.sql c1-newwrite-hold.sql; fill b.sql gate.sql as-user.sql c1-off.sql; pair a.sql b.sql ;;
  C1b) fill a.sql as-user.sql c1-off-hold.sql; fill b.sql gate.sql as-user.sql c1-newwrite.sql; pair a.sql b.sql ;;
  C2)  fill a.sql c2-deal-hold.sql as-user.sql c2-upsert.sql; fill b.sql gate.sql as-user.sql c2-tombstone.sql; pair a.sql b.sql ;;
  C3)  fill a.sql as-user.sql c3-register-hold.sql; fill b.sql gate.sql as-user.sql c3-register.sql; pair a.sql b.sql ;;
  C4)  fill a.sql c4-lowlock-then-files.sql as-user.sql c4-files-a.sql; fill b.sql gate.sql as-user.sql c4-files-b.sql; pair a.sql b.sql ;;
esac
fill assert.filled.sql assert.sql
$K "$tmp/assert.filled.sql" > "$tmp/state.out"
echo "state:  $(cat "$tmp/state.out")"

VERDICT="$(python3 - "$CASE" "$tmp/first.out" "$tmp/second.out" "$tmp/state.out" <<'PY'
import json, sys
case, f1, f2, fs = sys.argv[1:5]
def rows(p):
    t = open(p).read()
    try:
        return json.loads(t.split('\nkt-sql:')[0])
    except Exception:
        return t
def last_row(p):
    r = rows(p)
    return r[-1] if isinstance(r, list) and r else {}
a, b = last_row(f1), last_row(f2)
raw = open(f1).read() + open(f2).read()
st = last_row(fs).get('j', {})
ok = '40P01' not in raw
if case == 'C1a':
    ok = ok and a.get('d', {}).get('results', [{}])[0].get('status') == 'applied' and a.get('b', {}).get('ok') is True \
        and b.get('r', {}).get('success') is True and st.get('deals') == 0 and st.get('live_new_blob') == 0
elif case == 'C1b':
    ok = ok and a.get('r', {}).get('success') is True and b.get('d', {}).get('error') == 'not_entitled' \
        and b.get('b', {}).get('error') == 'not_entitled' and st.get('new_deal') == 0 and st.get('live_new_blob') == 0
elif case == 'C2':
    ok = ok and a.get('r', {}).get('results', [{}])[0].get('status') == 'applied' \
        and b.get('r', {}).get('results', [{}])[0].get('status') == 'removed'
elif case == 'C3':
    ok = ok and a.get('r', {}).get('ok') is True and b.get('r', {}).get('ok') is True \
        and a['r'].get('blob_id') == b['r'].get('blob_id') and st.get('live_cc_blob') == 1
elif case == 'C4':
    ok = ok and all(x.get('r', {}).get('ok') is True and [e.get('status') for e in x['r'].get('results', [])] == ['applied', 'applied'] for x in (a, b))
print('PASS' if ok else 'FAIL')
PY
)"
