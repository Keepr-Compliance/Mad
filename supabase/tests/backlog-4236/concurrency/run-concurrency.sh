#!/bin/bash
# BACKLOG-4236 two-session controls. PREREQUISITE: both migrations applied (committed) on the test
# project. Each case: setup (committed fixtures, ids random per run) -> two parallel kt-sql calls,
# the second started 1 s after the first -> assert -> teardown + verify (always, from the trap).
#   C1a  write holding its transaction, then turn-off: off waits, then deletes everything.
#        Expect: write applied, off success, 0 deals and 0 messages afterwards.
#   C1b  turn-off holding its transaction, then a write: the write waits, then sees Cloud off.
#        Expect: off success, write {"error":"not_entitled"}, 0 deals afterwards.
#   C2   one session holds the deal row and then upserts the message; the other tombstones the same
#        message meanwhile. Expect: no 40P01 in either result; both calls answer.
#   C3   two registrations of the same content, the first uncommitted for 3 s.
#        Expect: both ok with the same blob_id; 1 live blob.
# Mutants (apply to the APPLIED function, re-run, restore by re-applying the migration):
#   C1a/C1b  move "PERFORM 1 FROM public.cloud_autosave_settings ... FOR SHARE;" after the entitlement
#            check in cloud_upsert_messages -> C1b write applied after off (rows left)
#   C2       in cloud_tombstone, remove the /*TOMB:lockdeals*/ statement -> 40P01 in one session
#   C3       remove "ON CONFLICT (owner_user_id, sha256) WHERE purge_requested_at IS NULL DO NOTHING"
#            -> second registration ERR 23505
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
K=~/.claude/bin/kt-sql
case "${1:-}" in C1a|C1b|C2|C3) ;; *) sed -n '2,23p' "$0"; exit 2 ;; esac

umask 077
tmp="$(mktemp -d)"
RUN="$(openssl rand -hex 8)"
uid() { python3 -c 'import uuid; print(uuid.uuid4())'; }
A="$(uid)"; O="$(uid)"; M="$(uid)"; I="$(uid)"; DEAL=""; MSG=""; SETUP_DONE=0

fill() {  # fill <out> <template>...
  local out="$1"; shift
  for f in "$@"; do cat "$here/$f"; echo; done | sed -e "s/__A__/${A}/g" -e "s/__O__/${O}/g" -e "s/__M__/${M}/g" \
    -e "s/__I__/${I}/g" -e "s/__RUN__/${RUN}/g" -e "s/__DEAL__/${DEAL}/g" -e "s/__MSG__/${MSG}/g" > "$tmp/$out"
}
col() { python3 -c 'import json,sys; print(json.load(sys.stdin)[0][sys.argv[1]] or "")' "$1"; }

cleanup() {
  rc=$?
  set +e
  if [ "$SETUP_DONE" = 1 ]; then
    fill teardown.filled.sql teardown.sql; $K "$tmp/teardown.filled.sql" >/dev/null
    fill verify.filled.sql verify.sql
    v="$($K "$tmp/verify.filled.sql" | col verdict)"
    if [ "$v" != "clean" ]; then
      echo "=================================================================" >&2
      echo "TEARDOWN NOT CLEAN (run ${RUN}, user ${A}): fixture rows are left" >&2
      echo "=================================================================" >&2
      rc=1
    else
      echo "teardown verified clean"
    fi
  fi
  rm -rf "$tmp"
  exit $rc
}
trap cleanup EXIT INT TERM

fill setup.filled.sql setup.sql
SETUP_DONE=1
out="$($K "$tmp/setup.filled.sql")"
DEAL="$(echo "$out" | col deal)"; MSG="$(echo "$out" | col message)"
[ -n "$DEAL" ] && [ -n "$MSG" ] || { echo "setup failed: $out" >&2; exit 1; }

pair() {  # pair <first file> <second file>: first now, second 1 s later, both in parallel
  ( $K "$tmp/$1" > "$tmp/first.out" 2>&1 || true ) &
  p1=$!
  sleep 1
  ( $K "$tmp/$2" > "$tmp/second.out" 2>&1 || true ) &
  p2=$!
  wait $p1 $p2
  echo "first:  $(cat "$tmp/first.out")"
  echo "second: $(cat "$tmp/second.out")"
}

case "$1" in
  C1a) fill a.sql as-user.sql c1-write-hold.sql; fill b.sql as-user.sql c1-off.sql; pair a.sql b.sql ;;
  C1b) fill a.sql as-user.sql c1-off-hold.sql; fill b.sql as-user.sql c1-write.sql; pair a.sql b.sql ;;
  C2)  fill a.sql c2-deal-hold.sql as-user.sql c2-upsert.sql; fill b.sql as-user.sql c2-tombstone.sql; pair a.sql b.sql ;;
  C3)  fill a.sql as-user.sql c3-register-hold.sql; fill b.sql as-user.sql c3-register.sql; pair a.sql b.sql ;;
esac
fill assert.filled.sql assert.sql
echo "state:  $($K "$tmp/assert.filled.sql")"
