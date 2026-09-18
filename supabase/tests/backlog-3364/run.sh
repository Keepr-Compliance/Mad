#!/usr/bin/env bash
# BACKLOG-3364 harness: prove migration 1 on a real Postgres + PostgREST + storage stack.
#
#   supabase/tests/backlog-3364/run.sh '<postgres url>' <command>
#
# The URL is always explicit -- never --linked, never read from the environment
# -- and must point at loopback or a Tailscale address (100.64.0.0/10). Anything
# else is refused, so this can never be aimed at production.
#
# It must connect as the venue's `postgres` role (the role production applies
# migrations as). The gate checks that.
#
# Commands, in the order the README runs them:
#   gate       venue gate: role, supautils, catalog fingerprint vs production
#   seed       lib/seed-storage.sql (production's bucket + 4 storage policies)
#   txn        one-transaction control: a copy with a failing LAST statement
#              must exit non-zero and leave the fingerprint unchanged
#   txn-mutant the same copy with BEGIN/COMMIT removed must CHANGE the
#              fingerprint (run on a venue WITHOUT migration 1; follow with teardown)
#   apply      apply migration 1 and record its history row
#   twice      apply again: exit 0 and fingerprint unchanged; then the
#              ADD COLUMN-without-IF-NOT-EXISTS mutant must fail AND leave it unchanged
#   controls   every controls/*.sql in its own rolled-back transaction
#   mutants    every mutants/m*.sql x every control, plus the backfill mutant
#   teardown   lib/teardown.sql (takes migration 1 back off the venue)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIGRATION="$REPO/supabase/migrations/20260915160637_backlog_3364_personal_organizations.sql"
BACKFILL="$REPO/supabase/parked/backlog-3364/backfill_personal_organizations.sql"
STAMP="20260915160637"
PSQL="${PSQL:-$(command -v psql || echo /opt/homebrew/opt/libpq/bin/psql)}"
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-15}"

URL="${1:-}"; CMD="${2:-}"
if [ -z "$URL" ] || [ -z "$CMD" ]; then
  sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 2
fi

host="$(sed -E 's#^[a-z]+://([^@/]*@)?(\[[^]]+\]|[^:/?]+).*#\2#' <<<"$URL")"
if ! [[ "$host" =~ ^(127\.0\.0\.1|localhost|::1|\[::1\])$ ]] \
   && ! [[ "$host" =~ ^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
  echo "REFUSING: host '$host' is neither loopback nor a Tailscale address." >&2
  exit 2
fi

q() { "$PSQL" "$URL" -v ON_ERROR_STOP=1 -X -q "$@"; }

snapshot() { q -tA -f "$HERE/lib/snapshot.sql"; }

run_control() {
  # $1 control file, $2 optional mutant file, $3 backfill path
  local control="$1" mutant="${2:-}" backfill="${3:-$BACKFILL}" out rc
  set +e
  out=$(
    {
      echo "BEGIN;"
      echo "\\i $HERE/lib/fixtures.sql"
      [ -n "$mutant" ] && echo "\\i $mutant"
      echo "\\i $control"
      echo "SELECT 'ASSERTIONS=' || current_setting('t3364.asserts');"
      echo "ROLLBACK;"
    } | "$PSQL" "$URL" -v ON_ERROR_STOP=1 -X -tA -v backfill="$backfill" 2>&1
  )
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
    CONTROL_DETAIL="$(grep -m1 -E 'ERROR|FATAL' <<<"$out" | sed -E 's/^.*(ERROR|FATAL):\s*//' | cut -c1-160)"
  fi
}

case "$CMD" in
  gate)
    echo "== venue gate =="
    q -tA -c "select 'connected_as=' || current_user || ' rolsuper=' || (select rolsuper from pg_roles where rolname = current_user) || ' server=' || current_setting('server_version')"
    who=$(q -tA -c "select current_user")
    [ "$who" = "postgres" ] || { echo "GATE FAIL: must connect as postgres, got $who" >&2; exit 1; }
    q -tA -c "select 'supautils.policy_grants lists storage.objects for postgres=' || (coalesce(current_setting('supautils.policy_grants', true), '{}')::jsonb -> 'postgres' ? 'storage.objects')"
    q -tA -c "select 'session_preload_libraries=' || coalesce(current_setting('session_preload_libraries', true), '')"
    actual="$(q -tA -f "$HERE/lib/gate-catalog.sql" | LC_ALL=C sort)"
    fail=0; accepted=0; matched=0
    while IFS='|' read -r key val; do
      [ -z "$key" ] && continue
      [[ "$key" == \#* ]] && continue
      got="$(grep -F "$key|" <<<"$actual" | head -1 | cut -d'|' -f2-)"
      if [ "$got" = "$val" ]; then
        matched=$((matched+1))
      elif grep -qF "$key|$got|" "$HERE/lib/gate-accepted.txt"; then
        reason="$(grep -F "$key|$got|" "$HERE/lib/gate-accepted.txt" | head -1 | cut -d'|' -f3-)"
        echo "ACCEPTED  $key  venue=$got  production=$val  -- $reason"
        accepted=$((accepted+1))
      else
        echo "MISMATCH  $key  venue=${got:-<missing>}  production=$val"
        fail=$((fail+1))
      fi
    done < "$HERE/lib/gate-expected.txt"
    echo "gate: matched=$matched accepted=$accepted mismatched=$fail"
    [ $fail -eq 0 ] || exit 1
    ;;

  seed)
    q -f "$HERE/lib/seed-storage.sql"
    echo "seed: done"
    ;;

  txn)
    before="$(snapshot)"
    set +e; q -f "$HERE/mutants/t1-migration-with-failing-last-statement.sql" >/tmp/t3364-txn.$$ 2>&1; rc=$?; set -e
    grep -m1 ERROR /tmp/t3364-txn.$$ || true; rm -f /tmp/t3364-txn.$$
    after="$(snapshot)"
    if [ $rc -ne 0 ] && [ "$before" = "$after" ]; then
      echo "txn: GREEN (exit $rc, fingerprint unchanged, $(wc -l <<<"$before" | tr -d ' ') rows)"
    else
      echo "txn: RED (exit $rc, fingerprint changed: $([ "$before" = "$after" ] && echo no || echo yes))"; exit 1
    fi
    ;;

  txn-mutant)
    before="$(snapshot)"
    grep -qE '^(BEGIN|COMMIT);$' "$HERE/mutants/t1m-migration-autocommit-with-failing-last-statement.sql" \
      && { echo "MUTATION NOT APPLIED: BEGIN/COMMIT still present" >&2; exit 1; }
    echo "MUTATION APPLIED: $(diff <(grep -E '^(BEGIN|COMMIT);$' "$MIGRATION") <(grep -E '^(BEGIN|COMMIT);$' "$HERE/mutants/t1m-migration-autocommit-with-failing-last-statement.sql") | grep -c '^<') transaction lines removed"
    set +e; q -f "$HERE/mutants/t1m-migration-autocommit-with-failing-last-statement.sql" >/dev/null 2>&1; rc=$?; set -e
    after="$(snapshot)"
    if [ $rc -ne 0 ] && [ "$before" != "$after" ]; then
      echo "txn-mutant: the txn control's condition goes RED as required (exit $rc, fingerprint CHANGED)"
      echo "txn-mutant: run 'teardown' now"
    else
      echo "txn-mutant: control did NOT go red (exit $rc, changed: $([ "$before" = "$after" ] && echo no || echo yes))"; exit 1
    fi
    ;;

  apply)
    q -f "$MIGRATION"
    q -c "insert into supabase_migrations.schema_migrations (version, name) values ('$STAMP', 'backlog_3364_personal_organizations') on conflict do nothing"
    echo "apply: done"
    ;;

  twice)
    before="$(snapshot)"
    set +e; q -f "$MIGRATION" >/dev/null 2>&1; rc=$?; set -e
    after="$(snapshot)"
    if [ $rc -eq 0 ] && [ "$before" = "$after" ]; then
      echo "twice: GREEN (second apply exit 0, fingerprint unchanged)"
    else
      echo "twice: RED (exit $rc, changed: $([ "$before" = "$after" ] && echo no || echo yes))"; exit 1
    fi
    grep -q 'ADD COLUMN IF NOT EXISTS' "$HERE/mutants/t2m-migration-add-column-without-if-not-exists.sql" \
      && { echo "MUTATION NOT APPLIED" >&2; exit 1; }
    echo "MUTATION APPLIED: $(grep -m1 'ADD COLUMN' "$HERE/mutants/t2m-migration-add-column-without-if-not-exists.sql" | sed 's/^ *//')"
    set +e; out=$(q -f "$HERE/mutants/t2m-migration-add-column-without-if-not-exists.sql" 2>&1); rc=$?; set -e
    after2="$(snapshot)"
    echo "twice-mutant: exit $rc, $(grep -m1 ERROR <<<"$out" || echo 'no error'), fingerprint changed: $([ "$before" = "$after2" ] && echo no || echo yes)"
    [ $rc -ne 0 ] && [ "$before" = "$after2" ] || { echo "twice-mutant: expected a failure that changes nothing"; exit 1; }
    ;;

  controls)
    fail=0; n=0
    for c in "$HERE"/controls/*.sql; do
      run_control "$c"
      n=$((n+1))
      printf '%-58s %-5s %s\n' "$(basename "$c")" "$CONTROL_RESULT" "$CONTROL_DETAIL"
      [ "$CONTROL_RESULT" = "GREEN" ] || { fail=$((fail+1)); [ -n "${VERBOSE:-}" ] && echo "$CONTROL_OUT"; }
    done
    echo "controls: $((n-fail)) green / $n"
    [ $fail -eq 0 ] || exit 1
    ;;

  mutants)
    controls=( "$HERE"/controls/*.sql )
    for m in "$HERE"/mutants/m*.sql; do
      reds=(); greens=(); details=(); applied=""
      for c in "${controls[@]}"; do
        run_control "$c" "$m"
        a=$(grep -m1 -o 'MUTATION APPLIED: .*' <<<"$CONTROL_OUT" || true)
        [ -n "$a" ] && applied="$a"
        if grep -q 'MUTATION NOT APPLIED' <<<"$CONTROL_OUT"; then
          echo "$(basename "$m"): MUTATION NOT APPLIED -- result void" >&2; exit 1
        fi
        name="$(basename "$c" .sql | cut -d- -f1-2)"
        if [ "$CONTROL_RESULT" = "RED" ]; then
          if [ -z "$a" ]; then
            # red before the proof ran: the mutant itself failed to apply
            echo "$(basename "$m") x $(basename "$c"): RED WITHOUT PROOF -- $CONTROL_DETAIL" >&2; exit 1
          fi
          reds+=("$name")
          details+=("      $name: $CONTROL_DETAIL")
        else
          greens+=("$name")
        fi
      done
      [ -n "$applied" ] || { echo "$(basename "$m"): no MUTATION APPLIED line" >&2; exit 1; }
      printf '%s\n    %s\n    RED:   %s\n    green: %s\n' "$(basename "$m")" "${applied:0:150}" "${reds[*]:-none}" "${greens[*]:-none}"
      [ ${#details[@]} -gt 0 ] && printf '%s\n' "${details[@]}"
    done
    # Backfill mutant: substitute the file.
    b="$HERE/mutants/b01-backfill-without-invite-skip.sql"
    if grep -q 'invited_email' "$b"; then echo "b01: MUTATION NOT APPLIED" >&2; exit 1; fi
    echo "b01-backfill-without-invite-skip.sql"
    echo "    MUTATION APPLIED: invite skip removed ($(diff "$BACKFILL" "$b" | grep -c '^<') lines removed from the shipped backfill)"
    run_control "$HERE/controls/b-backfill-skips-invites-and-reruns-clean.sql" "" "$b"
    echo "    b-backfill: $CONTROL_RESULT -- $CONTROL_DETAIL"
    ;;

  teardown)
    q -f "$HERE/lib/teardown.sql"
    echo "teardown: done"
    ;;

  *)
    echo "unknown command: $CMD" >&2; exit 2 ;;
esac
