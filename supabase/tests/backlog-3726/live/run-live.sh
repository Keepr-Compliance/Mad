#!/usr/bin/env bash
# BACKLOG-3726 live run on a LOCAL stack. Applies the 3726 migration (committed)
# to the venue, points the Vault URL at the local Kong, then drives
# `supabase functions serve` through the phases of live-run.mjs.
#   STACK_WORKDIR  supabase workdir of the local stack (its config.toml decides project id and ports)
#   PG_CONTAINER   db container of that stack; KONG = its kong container
# Never run against a linked/production project: live-run.mjs refuses a non-local API_URL.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
WD="${STACK_WORKDIR:?set STACK_WORKDIR}"
PG="${PG_CONTAINER:?set PG_CONTAINER}"
KONG="${KONG_CONTAINER:-${PG/supabase_db_/supabase_kong_}}"
eval "$(supabase status --workdir "$WD" -o env 2>/dev/null | grep -E '^(API_URL|SERVICE_ROLE_KEY)=')"
export API_URL SERVICE_ROLE_KEY PG_CONTAINER="$PG"
case "$API_URL" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "refusing: $API_URL is not local" >&2; exit 2 ;; esac
psql_in() { docker exec -i "$PG" psql -U postgres -v ON_ERROR_STOP=1 -X -tA -q -f -; }
psql_in < "$REPO/supabase/migrations/20261005120000_backlog_3726_submission_sweep.sql"
echo "SELECT vault.update_secret((SELECT id FROM vault.secrets WHERE name='submission_sweep_url'), 'http://$KONG:8000/functions/v1/submission-sweep');" | psql_in >/dev/null
# functions serve mounts <workdir>/supabase/functions (a symlink does not mount): copy the function in
if [ "$(cd "$WD" && pwd)" != "$REPO" ]; then
  mkdir -p "$WD/supabase/functions"; rm -rf "$WD/supabase/functions/submission-sweep"
  cp -R "$REPO/supabase/functions/submission-sweep" "$WD/supabase/functions/submission-sweep"
fi
SERVE_PID=""
serve() {  # serve <mode> [delay_ms]
  stop_serve
  local envf; envf="$(mktemp)"; printf 'SUBMISSION_SWEEP_MODE=%s\nSUBMISSION_SWEEP_TEST_DELAY_MS=%s\n' "$1" "${2:-}" > "$envf"
  supabase functions serve submission-sweep --workdir "$WD" --no-verify-jwt --env-file "$envf" > "$HERE/.serve.log" 2>&1 &
  SERVE_PID=$!
  for _ in $(seq 1 90); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API_URL/functions/v1/submission-sweep" -d '{}' || true)
    [ "$code" = "401" ] && return 0; sleep 1
  done
  echo "functions serve did not come up" >&2; tail -20 "$HERE/.serve.log" >&2; exit 1
}
stop_serve() { if [ -n "$SERVE_PID" ]; then kill "$SERVE_PID" 2>/dev/null || true; wait "$SERVE_PID" 2>/dev/null || true; SERVE_PID=""; sleep 2; fi; }
trap stop_serve EXIT
phase() { node "$HERE/live-run.mjs" "$@"; }
rc=0
phase storage || rc=1
serve dry_run;   out="$(phase dry)" || rc=1; echo "$out" | grep -v '^STATE'
STATE="$(grep '^STATE ' <<<"$out" | sed 's/^STATE //')"
serve live;      STATE="$STATE" phase live || rc=1
phase race || rc=1
phase badsecret || rc=1
serve live 8000; phase delay || rc=1
if [ "${WITH_TIMEOUT_MUTANT:-}" = 1 ]; then
  echo "MUTATION APPLIED: submission_sweep_invoke timeout_milliseconds 150000 -> 5000 (live venue)"
  sed 's/timeout_milliseconds := 150000/timeout_milliseconds := 5000/' "$REPO/supabase/migrations/20261005120000_backlog_3726_submission_sweep.sql" | grep -c 'timeout_milliseconds := 5000' >/dev/null
  sed 's/timeout_milliseconds := 150000/timeout_milliseconds := 5000/' "$REPO/supabase/migrations/20261005120000_backlog_3726_submission_sweep.sql" | psql_in
  echo "SELECT vault.update_secret((SELECT id FROM vault.secrets WHERE name='submission_sweep_url'), 'http://$KONG:8000/functions/v1/submission-sweep');" | psql_in >/dev/null
  phase timeout || rc=1
  psql_in < "$REPO/supabase/migrations/20261005120000_backlog_3726_submission_sweep.sql"
fi
stop_serve
echo "live run exit $rc"; exit $rc
