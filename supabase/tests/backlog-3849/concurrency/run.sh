#!/usr/bin/env bash
# BACKLOG-3849 S1-S3: two-connection controls on billing_outbox_claim.
#
# These need two sessions and real commits, so they cannot run inside one
# rolled-back transaction. They run in a throwaway database that this script
# creates and drops (prints dropped_check=0 at the end).
#
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh
#
# Exit 0 only when the unmutated claim passes and every mutant that should go
# red does (nolock -> S1, nolease -> S2, nomode -> S3). `noskip` (FOR UPDATE
# without SKIP LOCKED) is expected to stay green: SKIP LOCKED only removes the wait.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
MIG="$REPO/supabase/migrations/20261011230913_backlog_3845_billing_foundation.sql"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
DB=t3849_concurrency
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

remote() { # stdin -> command inside the container
  if [ "$SSH_HOST" = local ]; then docker exec -i "$CONTAINER" "$@"
  else ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER $(printf '%q ' "$@")"; fi
}

python3 "$HERE/build.py" "$MIG" "$tmp/setup.sql"
remote psql -U postgres -X -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" </dev/null
cleanup_db() { remote psql -U postgres -X -q -c "DROP DATABASE IF EXISTS $DB" </dev/null || true; }
trap 'cleanup_db; rm -rf "$tmp"' EXIT
remote psql -U postgres -d "$DB" -X -q -v ON_ERROR_STOP=1 -f - <"$tmp/setup.sql" >/dev/null
remote bash -s "$DB" <"$HERE/inner.sh" | tee "$tmp/out"
cleanup_db
echo "dropped_check=$(remote psql -U postgres -X -tA -c "SELECT count(*) FROM pg_database WHERE datname = '$DB'" </dev/null)"
trap 'rm -rf "$tmp"' EXIT

line() { grep "^$1|$2|" "$tmp/out" || echo "MISSING"; }
fail=0
expect() { # $1 label, $2 actual line, $3 regex it must match
  if [[ "$2" =~ $3 ]]; then echo "PASS|$1"; else echo "FAIL|$1|$2"; fail=1; fi
}
expect "S1/S2 orig: one claim, no re-claim"        "$(line S1S2 orig)"    '\|A=1\|B=0 .*\|C=0\|attempts=1$'
expect "S1 nolock RED: B also claims"               "$(line S1S2 nolock)"  '\|B=1 '
expect "S2 nolease RED: C re-claims"                "$(line S1S2 nolease)" '\|C=1\|'
expect "noskip stays green (latency only)"          "$(line S1S2 noskip)"  '\|A=1\|B=0 .*\|C=0\|attempts=1$'
expect "S3 orig: live claim takes only live"        "$(line S3 orig)"      'modes=live$'
expect "S3 nomode RED: live claim takes test row"   "$(line S3 nomode)"    'modes=live,test$'
expect "parked row never claimed"                   "$(line PARK orig)"    'claimed=0$'
expect "late guarded write changes nothing"         "$(line GUARD orig)"   'w1=1\|w2=2\|late_guarded_rows=0$'
expect "claim has no cap (drain parks at claim)"    "$(line CAP orig)"     'claimed_attempts=9$'
exit $fail
