#!/usr/bin/env bash
# BACKLOG-3553 venue runner. Splices the migration file into controls.sql at
# each "-- harness: migration" marker and runs the result through psql in the
# venue container. The script ends in ROLLBACK.
#
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh
#   MIG=<path to a mutant migration> ... bash run.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="${MIG:-$REPO/supabase/migrations/20260929074121_backlog_3553_storage_usage_execute.sql}"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20)
n=$(grep -c '^-- harness: migration$' "$HERE/controls.sql")
[ "$n" -eq 3 ] || { echo "expected 3 migration markers, found $n" >&2; exit 2; }
awk -v mig="$MIG" '
  $0 == "-- harness: migration" { while ((getline l < mig) > 0) print l; close(mig); next }
  { print }' "$HERE/controls.sql" |
  ssh "${SSH_OPTS[@]}" "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -tA -f -"
