#!/bin/bash
# BACKLOG-4238 two-session controls. PREREQUISITE: the migration is applied (committed) on the
# test project. Each case: snapshot mcp_settings -> setup -> parallel kt-sql calls -> assert ->
# teardown + verify (always, from the EXIT/INT/TERM trap).
#   D7c  two parallel redemptions of one code: exactly one ok; the connection is then removed
#        (a second redemption is a replay) and one code_replay row is written.
#   D13b a call while another transaction holds the counter row: {"error":"busy"} within ~1 s
#        and a 'busy' log row.
#   D14  40 parallel calls on one connection: ok <= 30, ok + rate_limited + busy = 40, 40 log rows.
# Mutants (apply to the APPLIED function, re-run, restore by re-applying the migration):
#   D7c  M18_code_reusable                      -> two ok
#   D13b remove "PERFORM set_config('lock_timeout', '1000ms', true);" -> waits 4 s, then ok
#   D14  "IF v_n <= p_limit THEN" -> "IF v_n <= p_limit + 10 THEN" -> ok > 30
# The secret and the run id are random per run; every filled SQL file lives in a private
# temporary directory that the trap removes.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
K=~/.claude/bin/kt-sql
case "${1:-}" in D7c|D13b|D14) ;; *) sed -n '2,17p' "$0"; exit 2 ;; esac

umask 077
tmp="$(mktemp -d)"
SECRET="$(openssl rand -hex 32)"
RUN="$(openssl rand -hex 10)"  # client id kpr_c_cc + 20 = 22 characters
FUID="$(python3 -c 'import uuid; print(uuid.uuid4())')"  # fixture user of this run
CONNS=""; ENABLED=""; SECRET_HEX=""; SETUP_DONE=0

fill() {  # fill <template> <out>
  sed -e "s/__SECRET__/${SECRET}/g" -e "s/__RUN__/${RUN}/g" -e "s/__UID__/${FUID}/g" -e "s/__CONNS__/${CONNS}/g" \
      -e "s/__ENABLED__/${ENABLED}/g" -e "s/__SECRET_HEX__/${SECRET_HEX}/g" "$here/$1" > "$tmp/$2"
}
col() { python3 -c 'import json,sys; print(json.load(sys.stdin)[0][sys.argv[1]] or "")' "$1"; }

cleanup() {
  rc=$?
  set +e
  if [ "$SETUP_DONE" = 1 ]; then
    fill teardown.sql teardown.filled.sql; $K "$tmp/teardown.filled.sql" >/dev/null
    fill verify.sql verify.filled.sql
    v="$($K "$tmp/verify.filled.sql" | col verdict)"
    if [ "$v" != "clean" ]; then
      echo "=================================================================" >&2
      echo "TEARDOWN NOT CLEAN (run id ${RUN}): fixture rows or mcp_settings differ" >&2
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

snap="$($K "$here/snapshot.sql")"
ENABLED="$(echo "$snap" | col enabled)"; SECRET_HEX="$(echo "$snap" | col secret_hex)"
[ -n "$ENABLED" ] || { echo "no mcp_settings row: is the migration applied?" >&2; exit 1; }
fill setup.sql setup.filled.sql
SETUP_DONE=1
CONNS="$($K "$tmp/setup.filled.sql" | col conns)"
for f in exchange call hold-counter assert; do fill "$f.sql" "$f.filled.sql"; done

case "$1" in
  D7c)
    $K "$tmp/exchange.filled.sql" > "$tmp/d7-1.txt" 2>&1 & p1=$!
    sleep 1; $K "$tmp/exchange.filled.sql" > "$tmp/d7-2.txt" 2>&1 & p2=$!
    wait $p1 || true; wait $p2 || true
    cat "$tmp/d7-1.txt" "$tmp/d7-2.txt"; $K "$tmp/assert.filled.sql" ;;
  D13b)
    $K "$tmp/hold-counter.filled.sql" > "$tmp/hold.txt" 2>&1 & p1=$!
    sleep 1; t0=$(date +%s); $K "$tmp/call.filled.sql" || true; echo "call_s=$(( $(date +%s) - t0 ))"
    wait $p1 || true; $K "$tmp/assert.filled.sql" ;;
  D14)
    pids=()
    for i in $(seq 1 40); do $K "$tmp/call.filled.sql" > "$tmp/d14-$i.txt" 2>&1 & pids+=($!); done
    for p in "${pids[@]}"; do wait "$p" || true; done
    cat "$tmp"/d14-*.txt | command grep -o '"error" *: *"[a-z_]*"\|"ok" *: *true' | sort | uniq -c || true
    $K "$tmp/assert.filled.sql" ;;
esac
