#!/usr/bin/env bash
# BACKLOG-3503 harness. Runs supabase/migrations/20260922220719_backlog_3503_
# commission_agreements.sql -- THE SHIPPED FILE, not a copy -- on a real Postgres,
# and records what every control and every mutant did.
#
# Transport differs from backlog-3364/run.sh and backlog-3096's: the venue's
# database port does not answer from the developer machine, so psql cannot be run
# here as a client. Instead psql runs ON the venue, inside its container, and SQL
# is piped to it over SSH.
#
# The venue is NOT named in this file. backlog-3364/run.sh sets the precedent:
# it takes the target as input and validates it rather than publishing it. Set
# both variables in the environment; their values are recorded on the backlog
# item, not here.
#
#   SSH_HOST=<ssh alias>  PG_CONTAINER=<container name>  ./run.sh gate
#
# Four consequences of that transport, all handled here:
#   1. `\i <path>` would resolve inside the container, where the repo does not
#      exist. Every file is therefore CONCATENATED ON THE CLIENT into one stream.
#   2. The URL host gate (loopback or 100.64.0.0/10) has nothing to check. It is
#      replaced by: a literal container name, plus a refusal unless public.users
#      is empty. Production can never satisfy the second.
#   3. Every control runs inside one BEGIN ... ROLLBACK that this script writes.
#      A top-level `BEGIN;`/`COMMIT;` inside the migration would commit the
#      tables onto the venue and the gate would then refuse every later run, so
#      strip_txn removes them from the stream. LIMIT: strip_txn is line-based
#      and would also strip a bare `COMMIT;` on its own line inside a
#      dollar-quoted body. The migration has none, and `gate` after a run is the
#      backstop that would catch it if one appeared.
#   4. No PostgREST. Role switching is simulated with set_config('role', ...) +
#      request.jwt.claim.sub, which is the shape PostgREST itself produces.
#
#   ./run.sh gate | controls | mutants [name-fragment]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIGRATION="$REPO/supabase/migrations/20260922220719_backlog_3503_commission_agreements.sql"
# NOTE: no apostrophe in either message below. Inside ${VAR:?word} bash treats a
# single quote as a quoting character even within double quotes, so an
# apostrophe here pairs with the next one -- swallowing the newline and the
# CONTAINER assignment with it. Measured, not theorised.
SSH_HOST="${SSH_HOST:?set SSH_HOST to the ssh alias of the test venue -- see the header}"
CONTAINER="${PG_CONTAINER:?set PG_CONTAINER to the postgres container name on that venue -- see the header}"

[ -f "$MIGRATION" ] || { echo "migration not found: $MIGRATION" >&2; exit 2; }

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20 -o ControlMaster=auto -o ControlPath=/tmp/.ssh-3503-%r@%h:%p -o ControlPersist=300)
psql_in() { ssh "${SSH_OPTS[@]}" "$SSH_HOST" \
  "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -tA -f -"; }

# See note 3 above.
strip_txn() { grep -vE '^[[:space:]]*(BEGIN|COMMIT|END)[[:space:]]*;[[:space:]]*$'; }

gate() {
  local out
  out=$(printf "%s\n" \
    "select 'db=' || current_database() || ' user=' || current_user || ' server=' || current_setting('server_version');" \
    "select 'users_rows=' || count(*) from public.users;" \
    "select 'orgs_rows=' || count(*) from public.organizations;" \
    "select 'target_tables_absent=' || (not exists (select 1 from information_schema.tables where table_schema='public' and table_name in ('agent_commission_agreements','organization_franchise_fees')));" \
    | psql_in)
  echo "$out"
  grep -q '^users_rows=0$' <<<"$out" || { echo "GATE FAIL: public.users is not empty -- refusing." >&2; exit 1; }
  grep -q '^target_tables_absent=true$' <<<"$out" || { echo "GATE FAIL: the target tables already exist." >&2; exit 1; }
  grep -q 'user=postgres' <<<"$out" || { echo "GATE FAIL: not connected as postgres." >&2; exit 1; }
  echo "gate: OK"
}

# run_control <control> [mutant]
run_control() {
  local control="$1" mutant="${2:-}" out rc
  set +e
  out=$( { echo "BEGIN;"
           strip_txn < "$MIGRATION"
           [ -n "$mutant" ] && cat "$mutant"
           cat "$HERE/fixtures.sql"
           cat "$control"
           echo "SELECT 'ASSERTIONS=' || current_setting('t3503.asserts');"
           echo "ROLLBACK;"
         } | psql_in 2>&1 )
  rc=$?
  set -e
  CONTROL_OUT="$out"
  local asserts
  asserts=$(grep -o 'ASSERTIONS=[0-9]*' <<<"$out" | tail -1 | cut -d= -f2 || true)
  if [ $rc -eq 0 ] && [ -n "$asserts" ] && [ "$asserts" -gt 0 ]; then
    CONTROL_RESULT="GREEN"; CONTROL_DETAIL="$asserts assertions"
  elif [ $rc -eq 0 ]; then
    CONTROL_RESULT="VOID"; CONTROL_DETAIL="exit 0 but no assertion ran"
  else
    CONTROL_RESULT="RED"
    CONTROL_DETAIL="$(grep -m1 -E 'ERROR|FATAL' <<<"$out" | sed -E 's/^.*(ERROR|FATAL):[[:space:]]*//' | cut -c1-150)"
  fi
}

case "${1:-}" in
  gate) gate ;;
  controls)
    fail=0; n=0
    for c in "$HERE"/controls/*.sql; do
      run_control "$c"; n=$((n+1))
      printf '%-46s %-5s %s\n' "$(basename "$c" .sql)" "$CONTROL_RESULT" "$CONTROL_DETAIL"
      [ "$CONTROL_RESULT" = "GREEN" ] || { fail=$((fail+1)); [ -n "${VERBOSE:-}" ] && echo "$CONTROL_OUT"; }
    done
    echo "controls: $((n-fail)) green / $n"
    [ $fail -eq 0 ] || exit 1 ;;
  mutants)
    only="${2:-}"
    for m in "$HERE"/mutants/m*.sql; do
      [ -n "$only" ] && [[ "$(basename "$m")" != *"$only"* ]] && continue
      reds=(); greens=(); applied=""; details=()
      for c in "$HERE"/controls/*.sql; do
        run_control "$c" "$m"
        a=$(grep -m1 -o 'MUTATION APPLIED: .*' <<<"$CONTROL_OUT" || true)
        [ -n "$a" ] && applied="$a"
        name="$(basename "$c" .sql | cut -d- -f1)"
        if [ "$CONTROL_RESULT" = "GREEN" ]; then greens+=("$name")
        else
          [ -z "$a" ] && { echo "$(basename "$m") x $name: RED WITHOUT PROOF -- $CONTROL_DETAIL" >&2; exit 1; }
          reds+=("$name"); details+=("      $name: $CONTROL_DETAIL")
        fi
      done
      [ -n "$applied" ] || { echo "$(basename "$m"): no MUTATION APPLIED line -- result void" >&2; exit 1; }
      printf '%s\n    %s\n    RED:   %s\n    green: %s\n' "$(basename "$m" .sql)" "${applied:0:140}" "${reds[*]:-NONE}" "${greens[*]:-none}"
      [ ${#details[@]} -gt 0 ] && printf '%s\n' "${details[@]}"
    done ;;
  *) sed -n '2,34p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
