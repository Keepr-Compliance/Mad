#!/usr/bin/env bash
# BACKLOG-3849 S4 harness for migration A (20261013100000_backlog_3849_billing_drain.sql).
# Each control runs in ONE transaction ending in ROLLBACK: helpers, the migration
# (or a mutant), optionally a second apply, then the control. Nothing is
# committed and no queued pg_net request is ever sent.
#
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh controls [fragment]
#   SSH_HOST=... PG_CONTAINER=... bash run.sh mutants  [fragment]
#
# Header tag in a control file:  -- harness: apply-twice
# Step lines in a control file:   -- @step rollback   (runs rollback-3849.sql)
#                                 -- @step reapply    (applies the migration again)
# S1-S3 (two sessions, real commits) live in concurrency/run.sh.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations/20261013100000_backlog_3849_billing_drain.sql"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
psql_in() {
  if [ "$SSH_HOST" = local ]; then docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -
  else ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -"; fi
}

step() { # $1 step name, $2 file
  echo "SELECT pg_temp.run_step('$1', \$h3849\$"
  grep -viE '^\s*(begin|commit);\s*$' "$2"
  echo "\$h3849\$);"
}

build() { # $1 control, $2 migration
  echo "BEGIN;"
  echo "SET LOCAL TimeZone = 'UTC';"
  cat "$HERE/lib/harness.sql"
  echo "SELECT pg_temp.check('venue: no billing_drain objects before apply',"
  echo "  NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'billing_drain%')"
  echo "  AND NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name LIKE 'billing_drain%'));"
  step apply1 "$2"
  echo "SELECT pg_temp.check('migration applied', pg_temp.step_ok('apply1'), pg_temp.step_err('apply1'));"
  echo "SELECT set_config('t3849.secret_md5_after1', coalesce((SELECT md5(decrypted_secret) FROM vault.decrypted_secrets WHERE name = 'billing_drain_secret'), ''), true) IS NULL;"
  if grep -q -- '-- harness: apply-twice' "$1"; then
    step apply2 "$2"
    echo "SELECT pg_temp.check('second apply succeeded', pg_temp.step_ok('apply2'), pg_temp.step_err('apply2'));"
  fi
  # Placeholder lines in a control run a file as a named step at that point.
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "-- @step rollback") step rollback "$HERE/rollback-3849.sql" ;;
      "-- @step reapply") step reapply "$2" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done <"$1"
  echo "SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '|' || label || '|' || coalesce(detail, '') FROM t3849_r ORDER BY seq;"
  echo "SELECT 'CHECKS|' || count(*) FROM t3849_r;"
  echo "ROLLBACK;"
}

run_one() { # returns 0 PASS, 1 FAIL, 2 ERROR
  local out n
  if ! out="$(build "$1" "$2" | psql_in 2>&1)"; then
    echo "$out" | tail -3; echo "ERROR|$(basename "$1")|psql failed"; return 2
  fi
  echo "$out" | grep -E '^(PASS|FAIL)\|' || true
  n="$(echo "$out" | sed -n 's/^CHECKS|//p')"
  if [ -z "$n" ] || [ "$n" = "0" ]; then echo "ERROR|$(basename "$1")|0 checks"; return 2; fi
  echo "$out" | grep -q '^FAIL|' && return 1
  return 0
}

run_controls() { # $1 fragment, $2 migration
  local pass=0 fail=0 err=0 rc c
  for c in "$HERE"/controls/*.sql; do
    [[ "$(basename "$c")" == *"$1"* ]] || continue
    echo "== $(basename "$c" .sql)"
    rc=0; run_one "$c" "$2" || rc=$?
    case $rc in 0) pass=$((pass+1));; 1) fail=$((fail+1));; *) err=$((err+1));; esac
  done
  echo "CONTROLS: pass=$pass fail=$fail error=$err"
  [ "$fail" = 0 ] && [ "$err" = 0 ] && [ "$pass" -gt 0 ]
}

grep -q 'h3849\$' "$MIG" && { echo "ERROR|migration contains the \$h3849\$ tag"; exit 2; }

mode="${1:-controls}"; frag="${2:-}"
case "$mode" in
  controls) run_controls "$frag" "$MIG" || exit 1 ;;
  mutants)
    echo "-- baseline: every control against the unmutated migration"
    run_controls "" "$MIG" || { echo "MUTANTS: aborted - baseline not all PASS"; exit 1; }
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    killed=0; survived=0; invalid=0
    while IFS='|' read -r name targets; do
      [ -n "$frag" ] && [[ "$name" != *"$frag"* ]] && continue
      if ! python3 "$HERE/lib/mutants.py" apply "$name" "$MIG" "$tmp/m.sql"; then
        echo "INVALID|$name|mutant did not apply"; invalid=$((invalid+1)); continue
      fi
      changed="$(diff "$MIG" "$tmp/m.sql" | grep '^[<>]' | head -3 | tr '\n' ' ' | cut -c1-240 || true)"
      if [ -z "$changed" ]; then echo "INVALID|$name|mutant changed nothing"; invalid=$((invalid+1)); continue; fi
      echo "== $name  MUTATION APPLIED: $changed"
      : >"$tmp/status"
      for t in $targets; do
        c="$(ls "$HERE"/controls/"$t"-*.sql | head -1)"
        run_one "$c" "$tmp/m.sql" >"$tmp/out" 2>&1 || true
        grep -E '^(PASS|FAIL|ERROR)\|' "$tmp/out" | sed "s/^\([A-Z]*\)|/\1|[$t] /" >>"$tmp/status" || true
        grep -E '^(FAIL|ERROR)\|' "$tmp/out" | sed "s/^/  [$t] /" | head -4 || true
      done
      verdict="$(python3 "$HERE/lib/mutants.py" classify <"$tmp/status")"
      echo "$verdict|$name"
      case "$verdict" in KILLED) killed=$((killed+1));; SURVIVED) survived=$((survived+1));; *) invalid=$((invalid+1));; esac
    done < <(python3 "$HERE/lib/mutants.py" list)
    echo "MUTANTS: killed=$killed survived=$survived invalid=$invalid"
    [ "$survived" = 0 ] && [ "$invalid" = 0 ] && [ "$killed" -gt 0 ] ;;
  *) echo "usage: run.sh controls|mutants [fragment]"; exit 2 ;;
esac
