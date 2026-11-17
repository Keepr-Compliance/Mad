#!/bin/bash
# BACKLOG-4263 C14: two writers commit out of order; a reader's cursor must never skip a change.
# Venue: keepr-test through ~/.claude/bin/kt-sql. Commits ONE private scratch schema p4263cc_<random> (no row of
# any public table, no user, no migration); the EXIT/INT/TERM trap drops it and verifies it is gone.
# Usage: run-c14.sh pristine | seq_no_head
#   A: writer w1 takes its number and holds its transaction 4 s.
#   B: (gated on A's hold) writer w2.
#   C: (gated) reader from 0 while A holds, plus a witness: how many backends wait on a lock with w2's marker.
#   D: after A, B and C end: reader from C's next_after.
# PASS: every write is seen exactly once across C and D (no skip) and the witness is 1 (w2 was blocked behind w1).
# seq_no_head is the plan's C14 mutant (numbers from a sequence without the head lock); expected FAIL.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
K=~/.claude/bin/kt-sql
MODE="${1:-}"; case "$MODE" in pristine|seq_no_head) ;; *) sed -n '2,13p' "$0"; exit 2 ;; esac
umask 077
tmp="$(mktemp -d)"
RUN="$(openssl rand -hex 8)"; S="p4263cc_${RUN}"
O="$(python3 -c 'import uuid; print(uuid.uuid4())')"
SETUP=0; VERDICT=FAIL
cleanup() {
  rc=$?; set +e; trap - EXIT INT TERM
  wait 2>/dev/null
  if [ "$SETUP" = 1 ]; then
    $K -c "DROP SCHEMA IF EXISTS ${S} CASCADE" >/dev/null
    left="$($K -c "SELECT count(*) AS n FROM pg_namespace WHERE nspname = '${S}'" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["n"])')"
    if [ "$left" = "0" ]; then echo "residue check: schema ${S} gone (0)"; else echo "RESIDUE: schema ${S} left" >&2; rc=1; fi
    $K -c "select extensions.pg_stat_statements_reset()" >/dev/null
  fi
  rm -rf "$tmp"; echo "C14 ${MODE}: ${VERDICT}"
  [ "$VERDICT" = PASS ] || rc=1
  exit $rc
}
trap cleanup EXIT; trap 'exit 130' INT TERM
python3 "$here/build.py" "$tmp/setup.sql" "$S" "$MODE"
sed -i '' "s/__O__/${O}/g" "$tmp/setup.sql"
SETUP=1
$K "$tmp/setup.sql" > "$tmp/setup.out"
GATE="DO \$g\$ DECLARE i integer := 0; BEGIN WHILE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event = 'PgSleep' AND query LIKE '%p_hold:' || '${RUN}*/%') LOOP i := i + 1; IF i > 200 THEN RAISE EXCEPTION 'P_GATE_TIMEOUT'; END IF; PERFORM pg_sleep(0.1); END LOOP; END \$g\$;"
echo "SELECT ${S}.writer('${O}'::uuid, 'w1') AS r, pg_sleep(4) /*p_hold:${RUN}*/ AS hold;" > "$tmp/a.sql"
echo "${GATE} SELECT ${S}.writer('${O}'::uuid, 'w2') AS r /*w2:${RUN}*/;" > "$tmp/b.sql"
echo "${GATE} SELECT pg_sleep(0.5) AS settle; SELECT ${S}.reader('${O}'::uuid, 1) AS r1, (SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%w2:' || '${RUN}*/%') AS waiters;" > "$tmp/c.sql"
( $K "$tmp/a.sql" > "$tmp/a.out" 2>&1 || true ) & pa=$!
sleep 1
( $K "$tmp/b.sql" > "$tmp/b.out" 2>&1 || true ) & pb=$!
sleep 1
( $K "$tmp/c.sql" > "$tmp/c.out" 2>&1 || true ) & pc=$!
wait $pa $pb $pc
for s in a b c; do echo "$s: $(cat "$tmp/$s.out")"; done
C1="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[-1]["r1"]["next_after"])' "$tmp/c.out")"
echo "SELECT ${S}.reader('${O}'::uuid, ${C1}) AS r2, (SELECT jsonb_agg(tag ORDER BY change_seq) FROM ${S}.feed_rows) AS committed;" > "$tmp/d.sql"
$K "$tmp/d.sql" > "$tmp/d.out"; echo "d: $(cat "$tmp/d.out")"
VERDICT="$(python3 - "$tmp/c.out" "$tmp/d.out" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))[-1]; d = json.load(open(sys.argv[2]))[-1]
seen = [t for t in c['r1']['tags'] + d['r2']['tags'] if t != 'seed']
writes = [t for t in d['committed'] if t != 'seed']
ok = sorted(seen) == sorted(writes) and len(seen) == len(set(seen)) and c['waiters'] == 1
print('PASS' if ok else 'FAIL (seen %s of %s, waiters %s)' % (seen, writes, c['waiters']))
PY
)"
