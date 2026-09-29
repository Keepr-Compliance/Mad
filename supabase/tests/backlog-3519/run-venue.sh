#!/usr/bin/env bash
# BACKLOG-3519 section 5 (commission lock) runner against a Supabase-shaped
# Postgres. Runs THE SHIPPED migration (not a copy) and lock-probes.sql inside
# ONE transaction that always ends in ROLLBACK, so the target is left unchanged.
#
#   PSQL_CMD='<command that runs psql reading SQL from stdin>' ./run-venue.sh [overlay.sql]
#
# PSQL_CMD must run psql with -v ON_ERROR_STOP=1 and read the script from
# stdin (e.g. `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f -`). overlay.sql, if
# given, runs first inside the same transaction: use it to bring a test
# database's policies/triggers in line with production before the migration.
#
# The migration opens and closes its own transaction. Its BEGIN; and COMMIT;
# lines are removed (exactly two, asserted) so the inner COMMIT cannot commit
# the outer transaction.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIGRATION="${MIGRATION:-$REPO/supabase/migrations/20260925070000_backlog_3519_commission_figures.sql}"
OVERLAY="${1:-}"
: "${PSQL_CMD:?set PSQL_CMD to a psql command that reads SQL from stdin}"

[ -f "$MIGRATION" ] || { echo "migration not found: $MIGRATION" >&2; exit 2; }
removed=$(grep -cE '^(BEGIN|COMMIT);$' "$MIGRATION" || true)
[ "$removed" = "2" ] || { echo "expected exactly 2 BEGIN;/COMMIT; lines in the migration, found $removed" >&2; exit 2; }

{
  echo "BEGIN;"
  [ -n "$OVERLAY" ] && cat "$OVERLAY"
  grep -vE '^(BEGIN|COMMIT);$' "$MIGRATION"
  cat "$HERE/lock-probes.sql"
  echo "ROLLBACK;"
} | eval "$PSQL_CMD"
