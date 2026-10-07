#!/usr/bin/env bash
# BACKLOG-3714 harness. Each control runs in ONE transaction that ends with
# ROLLBACK: harness helpers, fixtures, the 3673 migration (production will
# have it), the 3714 migration (or a mutant of it), then the control.
# Nothing is ever committed.
#
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> ROLLBACK_FILE=<rollback .sql> \
#     bash run.sh controls [fragment]
#   ... bash run.sh mutants [fragment]
#
# SSH_HOST=local runs `docker exec` on this machine instead of over ssh.
# The rollback SQL is not kept in the repo; it is posted with the apply packet
# on the backlog item and passed in by path.
#
# Control header tags:
#   -- harness: baseline       the 3714 migration is NOT applied (3673 is)
#   -- harness: apply-twice    the 3714 migration runs twice
#   -- harness: rollback       ROLLBACK_FILE runs after the 3714 migration
# Output: PASS|label|detail or FAIL|label|detail per check. A control that
# raises, or produces no checks, is ERROR (psql's error text is printed).
# `controls` ends with `CONTROLS: pass= fail= error=`; `mutants` first requires
# every control to PASS on the unmutated migration, then ends with
# `MUTANTS: killed= survived= invalid=` (verdict: lib/mutants.py classify).
# Mutants named x* are measurements: printed as MEASURE|name|verdict, not counted.
# Exit 0 only when all controls pass / all counted mutants are KILLED.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="${MIG_OVERRIDE:-$REPO/supabase/migrations/20261007200000_backlog_3714_users_column_update_grants.sql}"
PRE_MIG="$REPO/supabase/migrations/20261003160000_backlog_3673_onboarding_completed_backfill.sql"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
RB="${ROLLBACK_FILE:?set ROLLBACK_FILE}"
psql_in() {
  if [ "$SSH_HOST" = "local" ]; then
    docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -
  else
    ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -"
  fi
}

# The rollback file as run inside the harness transaction: its own BEGIN/COMMIT
# stripped, and each `RAISE EXCEPTION 'rollback verify: ...'` turned into a
# FAIL check with the same label. Any other raise still aborts the run (ERROR).
rb_body() {
  grep -viE '^\s*(begin|commit);\s*$' "$1" \
    | sed -E "s/RAISE EXCEPTION '(rollback verify: [^']*)';/PERFORM pg_temp.check('\1', false);/"
}

build() { # $1 control file, $2 migration file, $3 rollback file
  local ctl="$1" mig="$2" rb="$3"
  echo "BEGIN;"
  cat "$HERE/lib/harness.sql" "$HERE/lib/fixtures.sql" "$PRE_MIG"
  if ! grep -q -- '-- harness: baseline' "$ctl"; then
    cat "$mig"
    if grep -q -- '-- harness: apply-twice' "$ctl"; then
      cat "$mig"
    fi
    if grep -q -- '-- harness: rollback' "$ctl"; then
      rb_body "$rb"
    fi
  fi
  cat "$ctl"
  echo "SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '|' || label || '|' || coalesce(detail, '') FROM t3714_r ORDER BY seq;"
  echo "SELECT 'CHECKS|' || count(*) FROM t3714_r;"
  echo "ROLLBACK;"
}

run_one() { # $1 control, $2 migration, $3 rollback; prints status lines;
  # returns 0 all checks PASS, 1 some FAIL, 2 ERROR (psql failed, or no checks)
  local out
  if ! out="$(build "$1" "$2" "$3" | psql_in 2>&1)"; then
    echo "$out" | grep -v '^$' | tail -6
    echo "ERROR|$(basename "$1")|psql failed"; return 2
  fi
  echo "$out" | grep -E '^(PASS|FAIL)\|' || true
  local n; n="$(echo "$out" | sed -n 's/^CHECKS|//p')"
  if [ -z "$n" ] || [ "$n" = "0" ]; then echo "ERROR|$(basename "$1")|0 checks"; return 2; fi
  if echo "$out" | grep -q '^FAIL|'; then return 1; fi
  return 0
}

run_controls() { # $1 fragment
  local pass=0 fail=0 err=0 rc c
  for c in "$HERE"/controls/*${1}*.sql; do
    [ -e "$c" ] || continue
    echo "== $(basename "$c")"
    rc=0; run_one "$c" "$MIG" "$RB" || rc=$?
    case $rc in 0) pass=$((pass+1));; 1) fail=$((fail+1));; *) err=$((err+1));; esac
  done
  echo "CONTROLS: pass=$pass fail=$fail error=$err"
  [ "$fail" = 0 ] && [ "$err" = 0 ] && [ "$pass" -gt 0 ]
}

md5of() { (md5 -q "$1" 2>/dev/null || md5sum "$1" | cut -d' ' -f1); }
echo "FILES|migration $(basename "$MIG") md5=$(md5of "$MIG")|3673 md5=$(md5of "$PRE_MIG")|rollback md5=$(md5of "$RB")"
echo "VENUE|$(echo "select version() || ' | users=' || (select count(*) from public.users) || ' | owner=' || (select tableowner from pg_tables where schemaname='public' and tablename='users') || ' | relacl=' || (select relacl::text from pg_class where oid='public.users'::regclass);" | psql_in)"

mode="${1:-controls}"; frag="${2:-}"
case "$mode" in
  controls)
    run_controls "$frag" || exit 1 ;;
  mutants)
    echo "-- baseline: every control against the unmutated migration"
    if ! run_controls ""; then
      echo "MUTANTS: aborted - baseline controls did not all PASS; no mutant was run"
      exit 1
    fi
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    killed=0; survived=0; invalid=0
    while IFS='|' read -r name targets; do
      [ -n "$frag" ] && [[ "$name" != *"$frag"* ]] && continue
      # raises unless every pattern occurs exactly once, so an unapplied mutant never counts
      python3 "$HERE/lib/mutants.py" apply "$name" "$MIG" "$RB" "$tmp/m.sql" "$tmp/rb.sql"
      changed="$( (diff "$MIG" "$tmp/m.sql"; diff "$RB" "$tmp/rb.sql") | grep -E '^[<>]' | head -1 | cut -c1-140 || true)"
      if [ -z "$changed" ]; then echo "INVALID|$name|mutant changed nothing"; invalid=$((invalid+1)); continue; fi
      echo "== $name  MUTATION APPLIED: $changed"
      : >"$tmp/status"
      for t in $targets; do
        run_one "$HERE/controls/$t.sql" "$tmp/m.sql" "$tmp/rb.sql" >"$tmp/out" 2>&1 || true
        grep -E '^(PASS|FAIL|ERROR)\|' "$tmp/out" >>"$tmp/status" || true
        grep -vE '^(PASS)\|' "$tmp/out" | head -8 || true
      done
      verdict="$(python3 "$HERE/lib/mutants.py" classify <"$tmp/status")"
      if [[ "$name" == x* ]]; then echo "MEASURE|$name|$verdict"; continue; fi
      echo "$verdict|$name"
      case "$verdict" in KILLED) killed=$((killed+1));; SURVIVED) survived=$((survived+1));; *) invalid=$((invalid+1));; esac
    done < <(python3 "$HERE/lib/mutants.py" list)
    echo "MUTANTS: killed=$killed survived=$survived invalid=$invalid"
    [ "$survived" = 0 ] && [ "$invalid" = 0 ] && [ "$killed" -gt 0 ] ;;
  *) echo "usage: run.sh controls|mutants [fragment]"; exit 2 ;;
esac
