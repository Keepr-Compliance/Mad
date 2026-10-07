#!/usr/bin/env bash
# BACKLOG-3759 harness. Each control runs in ONE transaction that ends with
# ROLLBACK: harness helpers, fixtures, the 3759 migration (or a mutant of it),
# then the control. Nothing is ever committed.
#
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh controls [fragment]
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh mutants  [fragment]
#
# The venue must be at the production schema (ledger head 20261004232511);
# c0 asserts it and prints the ledger max.
#
# Control header tags:
#   -- harness: baseline     the migration is NOT applied
#   -- harness: apply-twice  the migration runs a second time inside EXECUTE;
#                            any error is a FAIL check
#   -- harness: rollback     rollback-3759.sql runs after the migration
#   -- harness: drift        the transaction_submissions read rule's USING is
#                            altered first, then the migration runs inside
#                            EXECUTE and its error is kept in t3759_drift
# The migration's post-check raises ('3759 post-check: ...') are run as FAIL
# checks labelled 'migration post-check: ...' (conditions untouched). In
# `mutants` those labels do not count towards a kill: a control must see it.
# Output: PASS|label|detail or FAIL|label|detail per check. A control that
# raises, or produces no checks, is ERROR (psql's error text is printed).
# `controls` ends with `CONTROLS: pass= fail= error=`; `mutants` first requires
# every control to PASS on the unmutated migration, then ends with
# `MUTANTS: killed= survived= invalid=` (verdict: lib/mutants.py classify).
# Exit 0 only when all controls pass / all mutants are KILLED.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="${MIG_OVERRIDE:-$REPO/supabase/migrations/20261008120000_backlog_3759_function_grants.sql}"
RB="$HERE/rollback-3759.sql"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
psql_in() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -"; }

# The migration as the harness runs it: post-check raises become FAIL checks.
mig_body() {
  sed -E "s/RAISE EXCEPTION '3759 post-check: ([^']*)';/PERFORM pg_temp.check('migration post-check: \1', false);/" "$1"
}
# The migration inside EXECUTE; on error, $2 (SQL using SQLERRM) runs instead.
mig_exec() {
  echo 'DO $wrap3759$ BEGIN'
  echo 'EXECUTE $mig3759$'
  mig_body "$1"
  echo '$mig3759$;'
  echo "$3"
  echo "EXCEPTION WHEN OTHERS THEN $2"
  echo 'END $wrap3759$;'
}
rb_body() { grep -viE '^\s*(begin|commit);\s*$' "$1"; }

build() { # $1 control file, $2 migration file, $3 rollback file
  local ctl="$1" mig="$2" rb="$3"
  echo "BEGIN;"
  cat "$HERE/lib/harness.sql" "$HERE/lib/fixtures.sql"
  if grep -q -- '-- harness: drift' "$ctl"; then
    echo "ALTER POLICY transaction_submissions_select_public ON public.transaction_submissions USING (submitted_by = (SELECT auth.uid()));"
    echo "CREATE TEMP TABLE t3759_drift (err text) ON COMMIT DROP;"
    mig_exec "$mig" "INSERT INTO t3759_drift VALUES (SQLERRM);" "INSERT INTO t3759_drift VALUES (NULL);"
  elif ! grep -q -- '-- harness: baseline' "$ctl"; then
    mig_body "$mig"
    if grep -q -- '-- harness: apply-twice' "$ctl"; then
      mig_exec "$mig" "PERFORM pg_temp.check('apply-twice: second apply raised', false, SQLSTATE || ' ' || SQLERRM);" ""
    fi
    grep -q -- '-- harness: rollback' "$ctl" && rb_body "$rb"
  fi
  cat "$ctl"
  echo "SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '|' || label || '|' || coalesce(detail, '') FROM t3759_r ORDER BY seq;"
  echo "SELECT 'CHECKS|' || count(*) FROM t3759_r;"
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
echo "FILES|migration $(basename "$MIG") md5=$(md5of "$MIG")|rollback md5=$(md5of "$RB")"
echo "VENUE|$(echo "select version() || ' | ledger max=' || (select max(version) from supabase_migrations.schema_migrations) || ' rows=' || (select count(*) from supabase_migrations.schema_migrations);" | psql_in)"
grep -qE 'wrap3759|mig3759' "$MIG" && { echo "ERROR|migration contains a dollar tag build() uses"; exit 2; }

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
      # raises unless the pattern occurs exactly once, so an unapplied mutant never counts
      python3 "$HERE/lib/mutants.py" apply "$name" "$MIG" "$RB" "$tmp/m.sql" "$tmp/rb.sql"
      changed="$( (diff "$MIG" "$tmp/m.sql"; diff "$RB" "$tmp/rb.sql") | grep -E '^[<>]' | head -2 | cut -c1-140 | tr '\n' ' ' || true)"
      if [ -z "$changed" ]; then echo "INVALID|$name|mutant changed nothing"; invalid=$((invalid+1)); continue; fi
      echo "== $name  MUTATION APPLIED: $changed"
      : >"$tmp/status"
      for t in $targets; do
        run_one "$HERE/controls/$t.sql" "$tmp/m.sql" "$tmp/rb.sql" >"$tmp/out" 2>&1 || true
        # the migration's own post-check does not count as a kill
        grep -E '^(PASS|FAIL|ERROR)\|' "$tmp/out" | grep -v '|migration post-check:' >>"$tmp/status" || true
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
