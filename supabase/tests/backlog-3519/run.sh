#!/usr/bin/env bash
# BACKLOG-3519 harness. Runs THE SHIPPED supabase/migrations/20260925070000_
# backlog_3519_commission_figures.sql (not a copy) against a disposable LOCAL
# Postgres container. The migration depends on nothing unapplied, so no other
# migration is loaded. Requires Docker (or a docker-compatible daemon).
#
#   ./run.sh setup     start the container, apply stub + 3519
#   ./run.sh probes    run probes.sql (the CHECK boundary sweep)
#   ./run.sh teardown  remove the container
#   ./run.sh all       setup, probes, teardown
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIGRATION_3519="$REPO/supabase/migrations/20260925070000_backlog_3519_commission_figures.sql"
CONTAINER="pg3519-harness"
IMAGE="postgres:16-alpine"
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
  psql_in -v ON_ERROR_STOP=1 < "$MIGRATION_3519" >/dev/null
  echo "setup: OK (3519 applied on the stub)"
}
probes() { psql_in < "$HERE/probes.sql"; }
teardown() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; echo "teardown: OK"; }
case "${1:-}" in
  setup) setup ;;
  probes) probes ;;
  teardown) teardown ;;
  all) setup; probes; teardown ;;
  *) sed -n '2,10p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
