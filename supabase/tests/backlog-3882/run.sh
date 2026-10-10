#!/usr/bin/env bash
# BACKLOG-3882 harness. Each control runs in ONE transaction that ends with
# ROLLBACK: harness helpers, fixtures, the 3882 migration (or a mutant of it),
# then the control. Nothing is ever committed.
#
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh controls [fragment]
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh mutants  [fragment]
#
# The venue must be at the production schema; c0 asserts the pre-migration
# state of everything the migration touches.
#
# Control header tags:
#   -- harness: baseline     the migration is NOT applied
#   -- harness: apply-twice  the migration runs a second time inside EXECUTE;
#                            any error is a FAIL check
#   -- harness: rollback     rollback-3882.sql runs after the migration
#   -- harness: drift        auto_provision_it_admin's body is altered first, then
#                            the migration runs inside EXECUTE (error -> t3882_err)
# Output: PASS|label|detail or FAIL|label|detail per check. A control that
# raises, or produces no checks, is ERROR (psql's error text is printed).
# Exit 0 only when all controls pass / all mutants are KILLED.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="${MIG_OVERRIDE:-$REPO/supabase/migrations/20261010170000_backlog_3882_tenant_from_identity.sql}"
RB="$HERE/rollback-3882.sql"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
psql_in() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -"; }

# The migration inside EXECUTE; on error, $2 (SQL using SQLERRM) runs instead.
mig_exec() {
  echo 'DO $wrap3882$ BEGIN'
  echo 'EXECUTE $mig3882$'
  cat "$1"
  echo '$mig3882$;'
  echo "$3"
  echo "EXCEPTION WHEN OTHERS THEN $2"
  echo 'END $wrap3882$;'
}
rb_body() { grep -viE '^\s*(begin|commit);\s*$' "$1"; }

build() { # $1 control file, $2 migration file, $3 rollback file
  local ctl="$1" mig="$2" rb="$3"
  echo "BEGIN;"
  cat "$HERE/lib/harness.sql" "$HERE/lib/fixtures.sql"
  if grep -q -- '-- harness: drift' "$ctl"; then
    echo "CREATE TEMP TABLE t3882_err (err text) ON COMMIT DROP;"
    echo "SELECT pg_temp.drift();"
    mig_exec "$mig" "INSERT INTO t3882_err VALUES (SQLERRM);" "INSERT INTO t3882_err VALUES (NULL);"
  elif ! grep -q -- '-- harness: baseline' "$ctl"; then
    cat "$mig"
    if grep -q -- '-- harness: apply-twice' "$ctl"; then
      mig_exec "$mig" "PERFORM pg_temp.check('apply-twice: second apply raised', false, SQLSTATE || ' ' || SQLERRM);" ""
    fi
    grep -q -- '-- harness: rollback' "$ctl" && rb_body "$rb"
  fi
  cat "$ctl"
  echo "SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '|' || label || '|' || coalesce(detail, '') FROM t3882_r ORDER BY seq;"
  echo "SELECT 'CHECKS|' || count(*) FROM t3882_r;"
  echo "ROLLBACK;"
}

run_one() { # returns 0 all PASS, 1 some FAIL, 2 ERROR (psql failed, or no checks)
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
echo "FILES|migration $(basename "$MIG") md5=$(md5of "$MIG")|rollback md5=$(md5of "$RB")"
echo "VENUE|$(echo "select version() || ' | ledger max=' || (select max(version) from supabase_migrations.schema_migrations) || ' rows=' || (select count(*) from supabase_migrations.schema_migrations);" | psql_in)"
grep -qE 'wrap3882|mig3882' "$MIG" && { echo "ERROR|migration contains a dollar tag build() uses"; exit 2; }

mode="${1:-controls}"; frag="${2:-}"
case "$mode" in
  controls)
    run_controls "$frag" || exit 1 ;;
  mutants)
    echo "-- baseline: every control against the unmutated migration"
    if ! run_controls "" || ! bash "$HERE/race.sh"; then
      echo "MUTANTS: aborted - baseline controls did not all PASS; no mutant was run"
      exit 1
    fi
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    killed=0; survived=0; invalid=0
    while IFS='|' read -r name targets; do
      [ -n "$frag" ] && [[ "$name" != *"$frag"* ]] && continue
      # raises unless the pattern occurs exactly once, so an unapplied mutant never counts
      python3 "$HERE/lib/mutants.py" apply "$name" "$MIG" "$RB" "$tmp/m.sql" "$tmp/rb.sql"
      changed="$( (diff "$MIG" "$tmp/m.sql"; diff "$RB" "$tmp/rb.sql") | grep -E '^[<>]' | head -2 | cut -c1-140 | tr '\n' ' ' || true)"
      if [ -z "$changed" ]; then echo "INVALID|$name|mutant changed nothing"; invalid=$((invalid+1)); continue; fi
      echo "== $name  MUTATION APPLIED: $changed"
      : >"$tmp/status"
      for t in $targets; do
        if [ "$t" = race ]; then bash "$HERE/race.sh" "$tmp/m.sql" >"$tmp/out" 2>&1 || true
        else run_one "$HERE/controls/$t.sql" "$tmp/m.sql" "$tmp/rb.sql" >"$tmp/out" 2>&1 || true; fi
        grep -E '^(PASS|FAIL|ERROR)\|' "$tmp/out" >>"$tmp/status" || true
        grep -vE '^(PASS)\|' "$tmp/out" | head -8 || true
      done
      verdict="$(python3 "$HERE/lib/mutants.py" classify <"$tmp/status")"
      echo "$verdict|$name"
      case "$verdict" in KILLED) killed=$((killed+1));; SURVIVED) survived=$((survived+1));; *) invalid=$((invalid+1));; esac
    done < <(python3 "$HERE/lib/mutants.py" list)
    echo "MUTANTS: killed=$killed survived=$survived invalid=$invalid"
    [ "$survived" = 0 ] && [ "$invalid" = 0 ] && [ "$killed" -gt 0 ] ;;
  *) echo "usage: run.sh controls|mutants [fragment]"; exit 2 ;;
esac
