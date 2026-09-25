#!/usr/bin/env bash
# BACKLOG-3519 harness. Runs supabase/migrations/20260925070000_backlog_3519_
# commission_figures.sql -- THE SHIPPED FILE, not a copy -- against a
# disposable LOCAL Postgres container, after the shipped BACKLOG-3503 file
# (whatever is currently in supabase/migrations/, also not a copy).
#
# Unlike backlog-3503/run.sh and backlog-3364/run.sh, this does NOT reach a
# shared test venue over SSH or a URL: there is nothing here for a
# loopback/Tailscale gate to protect, because the container this creates has
# no data and is destroyed at the end of every run. Requires Docker (or any
# docker-compatible daemon on the `docker` CLI, e.g. colima).
#
# `stub-schema.sql` in this directory stands in for the columns/tables 3503's
# and 3519's migrations touch that this repo does not otherwise ship as a
# runnable fixture (auth.users, a minimal organizations/users/
# organization_members/transaction_submissions). It is NOT a copy of any real
# migration and carries no RLS -- this harness proves the DDL (columns, CHECK
# constraints, the FK, the index), not the RLS policies 3503 already tests in
# its own harness.
#
#   ./run.sh setup     start the container, apply stub + 3503 + 3519
#   ./run.sh probes    run probes.sql (the CHECK/FK boundary sweep) and report
#   ./run.sh teardown  remove the container
#   ./run.sh all       setup, probes, teardown in one call
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIGRATION_3503=$(ls "$REPO"/supabase/migrations/*_backlog_3503_commission_agreements.sql | head -1)
MIGRATION_3519="$REPO/supabase/migrations/20260925070000_backlog_3519_commission_figures.sql"
CONTAINER="pg3519-harness"
IMAGE="postgres:16-alpine"

[ -f "$MIGRATION_3503" ] || { echo "3503 migration not found" >&2; exit 2; }
[ -f "$MIGRATION_3519" ] || { echo "3519 migration not found: $MIGRATION_3519" >&2; exit 2; }

psql_in() { docker exec -i "$CONTAINER" psql -U postgres "$@"; }

setup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null
  for _ in $(seq 1 30); do
    docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 1
  done
  psql_in -v ON_ERROR_STOP=1 < "$HERE/stub-schema.sql" >/dev/null
  # 3503 is expected to fail partway through (REVOKE ... FROM anon/authenticated
  # -- those roles do not exist on a bare Postgres). That is fine: the table,
  # its indexes/comments and split_agreement_in_force() are created before that
  # point, which is everything this harness needs. Do not use ON_ERROR_STOP here.
  psql_in < "$MIGRATION_3503" >/dev/null 2>&1 || true
  if ! psql_in -tAc "SELECT to_regclass('public.agent_split_agreements') IS NOT NULL" | grep -q '^t$'; then
    echo "SETUP FAILED: agent_split_agreements was not created by the 3503 migration" >&2
    exit 1
  fi
  psql_in -v ON_ERROR_STOP=1 < "$MIGRATION_3519" >/dev/null
  echo "setup: OK (3503 table + split_agreement_in_force() present, 3519 applied)"
}

probes() {
  psql_in < "$HERE/probes.sql"
}

teardown() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  echo "teardown: OK"
}

case "${1:-}" in
  setup) setup ;;
  probes) probes ;;
  teardown) teardown ;;
  all) setup; probes; teardown ;;
  *) sed -n '2,24p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
