#!/bin/bash
# BACKLOG-4238 two-session controls. PREREQUISITE: the migration is applied (committed) on the
# test project. Each case: snapshot -> setup -> parallel kt-sql calls -> PASS/FAIL against the
# expected values below -> teardown + verify (always, from the EXIT/INT/TERM trap).
# Exit 0 only when the case PASSes and teardown verifies clean. Output line:
#   <case> PASS|FAIL <observed> expected <expected>
#
# D7c  two redemptions of one code, the second started 1 s into the first's 3 s transaction.
#      expected: responses ok=1 invalid_grant=1; events code_replay=1 reconnect_replaced=1;
#      no connection of the run's client left.
#      mutant M18_code_reusable (no "AND k.used_at IS NULL"): the second redemption re-reads the
#      code row, the activation finds the connection already active and returns invalid_grant
#      without a delete -> responses ok=1 invalid_grant=1, events reconnect_replaced=1 only,
#      connections active=1. Differs in events and connections. NOT RUN.
# D13b one call while another transaction holds the call's counter row for 6 s.
#      expected: response error=busy; elapsed < 3 s; outcomes busy=1.
#      mutant (no "PERFORM set_config('lock_timeout', '1000ms', true);" in _mcp_bump): the call
#      waits until the holder commits (about 5 s) and then counts normally -> response ok,
#      elapsed >= 4 s, outcomes ok=1. Differs in response, elapsed and outcomes. NOT RUN.
# D14  40 parallel calls on one connection, all inside one minute window.
#      expected: ok <= 30; ok + rate_limited + busy = 40; no other response; 40 call log rows.
#      mutant ("IF v_n <= p_limit THEN" -> "IF v_n <= p_limit + 10 THEN" in _mcp_bump): up to 40
#      ok -> ok = 40 - busy, which exceeds 30 whenever fewer than 10 calls are busy. When 10 or
#      more calls are busy the mutant is not distinguishable by this case. NOT RUN.
#
# The secret, the run id and the fixture user are random per run; every filled SQL file lives in a
# private temporary directory that the trap removes.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
K=~/.claude/bin/kt-sql
case "${1:-}" in D7c|D13b|D14) ;; *) sed -n '2,29p' "$0"; exit 2 ;; esac

umask 077
tmp="$(mktemp -d)"
SECRET="$(openssl rand -hex 32)"
RUN="$(openssl rand -hex 10)"  # client id kpr_c_cc + 20 = 22 characters
FUID="$(python3 -c 'import uuid; print(uuid.uuid4())')"  # fixture user of this run
CONNS=""; ENABLED=""; SECRET_HEX=""; ALLOW_N=""; SETUP_DONE=0; VERDICT=FAIL

fill() {  # fill <template> <out>
  sed -e "s/__SECRET__/${SECRET}/g" -e "s/__RUN__/${RUN}/g" -e "s/__UID__/${FUID}/g" -e "s/__CONNS__/${CONNS}/g" \
      -e "s/__ENABLED__/${ENABLED}/g" -e "s/__SECRET_HEX__/${SECRET_HEX}/g" -e "s/__ALLOW_N__/${ALLOW_N}/g" "$here/$1" > "$tmp/$2"
}
col() { python3 -c 'import json,sys; print(json.load(sys.stdin)[0][sys.argv[1]] or "")' "$1"; }
now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
# response of one kt-sql call: the "r" column's ok/error, or "none" when the call returned no row
resp() { python3 - "$1" <<'PY'
import json, sys
t = open(sys.argv[1]).read()
try:
    r = json.loads(t)[0]['r']
    r = json.loads(r) if isinstance(r, str) else r
    print('ok' if r.get('ok') is True else r.get('error', 'unknown'))
except Exception:
    print('none')
PY
}
# start only in the first 40 s of a minute, so a case stays inside one counter window
wait_window() { while [ "$(date +%S | sed 's/^0//')" -ge 40 ]; do sleep 1; done; }

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
  [ "$VERDICT" = PASS ] || rc=1
  rm -rf "$tmp"
  exit $rc
}
trap cleanup EXIT INT TERM

snap="$($K "$here/snapshot.sql")"
ENABLED="$(echo "$snap" | col enabled)"; SECRET_HEX="$(echo "$snap" | col secret_hex)"; ALLOW_N="$(echo "$snap" | col allow_n)"
[ -n "$ENABLED" ] || { echo "no mcp_settings row: is the migration applied?" >&2; exit 1; }
fill setup.sql setup.filled.sql
SETUP_DONE=1
CONNS="$($K "$tmp/setup.filled.sql" | col conns)"
for f in exchange call hold-counter assert; do fill "$f.sql" "$f.filled.sql"; done
state() { $K "$tmp/assert.filled.sql" | python3 -c 'import json,sys; j=json.load(sys.stdin)[0]["j"]; j=json.loads(j) if isinstance(j,str) else j; print(json.dumps(j, sort_keys=True))'; }

case "$1" in
  D7c)
    $K "$tmp/exchange.filled.sql" > "$tmp/d7-1.txt" 2>&1 & p1=$!
    sleep 1; $K "$tmp/exchange.filled.sql" > "$tmp/d7-2.txt" 2>&1 & p2=$!
    wait $p1 || true; wait $p2 || true
    r1="$(resp "$tmp/d7-1.txt")"; r2="$(resp "$tmp/d7-2.txt")"; st="$(state)"
    obs="responses=$(printf '%s\n%s\n' "$r1" "$r2" | sort | paste -sd, -) state=${st}"
    exp='responses=invalid_grant,ok events={"code_replay": 1, "reconnect_replaced": 1} connections=null outcomes=null'
    VERDICT="$(python3 - "$r1" "$r2" "$st" <<'PY'
import json, sys
r = sorted(sys.argv[1:3]); s = json.loads(sys.argv[3])
ok = (r == ['invalid_grant', 'ok'] and s.get('events') == {'code_replay': 1, 'reconnect_replaced': 1}
      and s.get('connections') is None and s.get('outcomes') is None)
print('PASS' if ok else 'FAIL')
PY
)" ;;
  D13b)
    wait_window
    $K "$tmp/hold-counter.filled.sql" > "$tmp/hold.txt" 2>&1 & p1=$!
    sleep 1; t0=$(now_ms); $K "$tmp/call.filled.sql" > "$tmp/call.txt" 2>&1 || true; ms=$(( $(now_ms) - t0 ))
    wait $p1 || true
    r="$(resp "$tmp/call.txt")"; st="$(state)"
    obs="response=${r} elapsed_ms=${ms} state=${st}"
    exp='response=busy elapsed_ms<3000 outcomes={"busy": 1}'
    VERDICT="$(python3 - "$r" "$ms" "$st" <<'PY'
import json, sys
r, ms, s = sys.argv[1], int(sys.argv[2]), json.loads(sys.argv[3])
print('PASS' if (r == 'busy' and ms < 3000 and s.get('outcomes') == {'busy': 1}) else 'FAIL')
PY
)" ;;
  D14)
    wait_window
    pids=()
    for i in $(seq 1 40); do $K "$tmp/call.filled.sql" > "$tmp/d14-$i.txt" 2>&1 & pids+=($!); done
    for p in "${pids[@]}"; do wait "$p" || true; done
    counts="$(for i in $(seq 1 40); do resp "$tmp/d14-$i.txt"; done | sort | uniq -c | awk '{printf "%s=%s ", $2, $1}')"
    st="$(state)"
    obs="responses=${counts}state=${st}"
    exp='ok<=30 ok+rate_limited+busy=40 no other response; 40 call log rows'
    VERDICT="$(python3 - "$counts" "$st" <<'PY'
import json, sys
c = dict(kv.split('=') for kv in sys.argv[1].split()); c = {k: int(v) for k, v in c.items()}
s = json.loads(sys.argv[2]); o = s.get('outcomes') or {}
ok_n = c.get('ok', 0); known = ok_n + c.get('rate_limited', 0) + c.get('busy', 0)
fine = (ok_n <= 30 and known == 40 and set(c) <= {'ok', 'rate_limited', 'busy'}
        and sum(o.values()) == 40 and o.get('ok', 0) == ok_n)
print('PASS' if fine else 'FAIL')
PY
)" ;;
esac
echo "$1 ${VERDICT} ${obs} expected ${exp}"
