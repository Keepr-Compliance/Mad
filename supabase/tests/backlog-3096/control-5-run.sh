#!/usr/bin/env bash
# BACKLOG-3096 / CONTROL 5 runner: two concurrent /setup callers, one admin.
#
# Usage:  DATABASE_URL='postgresql://...' ./control-5-run.sh
#
# Use the DIRECT (non-pooler) connection string. Both sessions hold an open
# transaction with a sleep in it; a pooler adds a variable of its own that this
# test is not trying to measure.
#
# WHAT TO LOOK FOR, in this order:
#   1. Session B's b_before_call / b_after_call gap. ~5s = B blocked on the row
#      lock. ~0s = there is no lock and the roles below prove nothing.
#   2. The assert step: A must be admin, B must be agent.
#
# Exit status is the assert step's status. A timing regression does NOT fail the
# script -- read the timestamps.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set. Use the direct (non-pooler) connection string." >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== step 1/4: seed fixture ==="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$HERE/control-5-setup.sql"

echo "=== step 2/4: session A (background, holds its transaction ~6s) ==="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$HERE/control-5-session-a.sql" \
  > "$HERE/.control-5-session-a.out" 2>&1 &
A_PID=$!

# Let A get past its RPC call and into pg_sleep before B starts, so B is
# guaranteed to arrive while A's row lock is held.
sleep 1

echo "=== step 3/4: session B (must block ~5s if the lock exists) ==="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$HERE/control-5-session-b.sql" \
  > "$HERE/.control-5-session-b.out" 2>&1 &
B_PID=$!

wait "$A_PID" || { echo "session A failed:"; cat "$HERE/.control-5-session-a.out"; exit 1; }
wait "$B_PID" || { echo "session B failed:"; cat "$HERE/.control-5-session-b.out"; exit 1; }

echo "--- session A output ---"; cat "$HERE/.control-5-session-a.out"
echo "--- session B output (CHECK THE GAP BETWEEN b_before_call AND b_after_call) ---"
cat "$HERE/.control-5-session-b.out"

echo "=== step 4/4: assert roles and tear down ==="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$HERE/control-5-assert.sql"
