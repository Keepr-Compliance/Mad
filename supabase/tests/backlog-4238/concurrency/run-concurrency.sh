#!/bin/bash
# BACKLOG-4238 two-session controls. PREREQUISITE: the migration is applied (committed) on the
# test project. Each case: setup -> parallel kt-sql calls -> assert -> teardown.
#   D7c  two parallel redemptions of one code: exactly one ok; the connection is then removed
#        (a second redemption is a replay) and one code_replay row is written.
#   D13b a call while another transaction holds the counter row: {"error":"busy"} within ~1 s
#        and a 'busy' log row.
#   D14  40 parallel calls on one connection: ok <= 30, ok + rate_limited + busy = 40, 40 log rows.
# Mutants (apply to the APPLIED function, re-run, restore by re-applying the migration):
#   D7c  M18_code_reusable                      -> two ok
#   D13b remove "PERFORM set_config('lock_timeout', '1000ms', true);" -> waits 4 s, then ok
#   D14  "IF v_n <= p_limit THEN" -> "IF v_n <= p_limit + 10 THEN" -> ok > 30
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
K=~/.claude/bin/kt-sql
case "${1:-}" in
  D7c)
    $K "$here/setup.sql" >/dev/null
    $K "$here/exchange.sql" > /tmp/p4238-d7-1.txt & p1=$!
    sleep 1; $K "$here/exchange.sql" > /tmp/p4238-d7-2.txt & p2=$!
    wait $p1 $p2; cat /tmp/p4238-d7-1.txt /tmp/p4238-d7-2.txt; $K "$here/assert.sql"
    $K "$here/teardown.sql" >/dev/null ;;
  D13b)
    $K "$here/setup.sql" >/dev/null
    $K "$here/hold-counter.sql" >/dev/null & p1=$!
    sleep 1; t0=$(date +%s); $K "$here/call.sql"; echo "call_s=$(( $(date +%s) - t0 ))"
    wait $p1; $K "$here/assert.sql"; $K "$here/teardown.sql" >/dev/null ;;
  D14)
    $K "$here/setup.sql" >/dev/null
    for i in $(seq 1 40); do $K "$here/call.sql" > "/tmp/p4238-d14-$i.txt" & done; wait
    cat /tmp/p4238-d14-*.txt | command grep -o '"error" *: *"[a-z_]*"\|"ok" *: *true' | sort | uniq -c
    $K "$here/assert.sql"; $K "$here/teardown.sql" >/dev/null ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
