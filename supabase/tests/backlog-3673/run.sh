#!/usr/bin/env bash
# BACKLOG-3673 harness. Each control runs in ONE transaction that ends with
# ROLLBACK: harness helpers, fixtures (+ the pre-check list), the 3673
# migration (or a mutant of it), then the control. Nothing is ever committed.
#
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> \
#   ROLLBACK_FILE=<data rollback .sql> FULL_ROLLBACK_FILE=<full rollback .sql> \
#     bash run.sh controls [fragment]
#   ... bash run.sh mutants [fragment]
#
# The rollback SQL is not kept in the repo; it is posted with the apply packet
# on the backlog item and passed in by path. Its `-- @IDS` line is replaced
# here by the pre-check list the fixtures computed.
#
# Control header tags:
#   -- harness: baseline       the migration is NOT applied
#   -- harness: apply-twice    the migration runs twice
#   -- harness: rollback       ROLLBACK_FILE runs after the migration
#   -- harness: reapply        ...and then the migration runs again
#   -- harness: full-rollback  ...and then FULL_ROLLBACK_FILE runs
# Output: PASS|label|detail or FAIL|label|detail per check. A control that
# raises, or produces no checks, is ERROR (psql's error text is printed).
# `controls` ends with `CONTROLS: pass= fail= error=`; `mutants` first requires
# every control to PASS on the unmutated migration, then ends with
# `MUTANTS: killed= survived= invalid=` (verdict: lib/mutants.py classify).
# Exit 0 only when all controls pass / all mutants are KILLED.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="${MIG_OVERRIDE:-$REPO/supabase/migrations/20261003160000_backlog_3673_onboarding_completed_backfill.sql}"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
RB="${ROLLBACK_FILE:?set ROLLBACK_FILE}"; FULL_RB="${FULL_ROLLBACK_FILE:?set FULL_ROLLBACK_FILE}"
psql_in() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -"; }

# A rollback file as run inside the harness transaction: its own BEGIN/COMMIT
# stripped, the pasted id list replaced by the fixtures' pre-check list, and each
# `RAISE EXCEPTION '[full ]rollback verify: ...'` turned into a FAIL check with
# the same label. The conditions are untouched; only what happens when one is
# true changes. Any other raise in the file still aborts the run (ERROR).
rb_body() {
  grep -viE '^\s*(begin|commit);\s*$' "$1" \
    | sed -E "s/^INSERT INTO r3673_ids .*-- @IDS.*$/INSERT INTO r3673_ids (id) SELECT id FROM t3673_pre;/" \
    | sed -E "s/RAISE EXCEPTION '((full )?rollback verify: [^']*)';/PERFORM pg_temp.check('\1', false);/"
}

build() { # $1 control file, $2 migration file, $3 data rollback file
  local ctl="$1" mig="$2" rb="$3"
  echo "BEGIN;"
  cat "$HERE/lib/harness.sql" "$HERE/lib/fixtures.sql"
  if ! grep -q -- '-- harness: baseline' "$ctl"; then
    cat "$mig"
    if grep -q -- '-- harness: apply-twice' "$ctl"; then
      # The second apply runs inside a block so that the one expected refusal
      # (duplicate_object, 42710) is recorded as a FAIL check. Any other error
      # propagates and the run is ERROR.
      echo 'DO $apply2$ BEGIN'
      cat "$mig"
      echo "EXCEPTION WHEN duplicate_object THEN PERFORM pg_temp.check('apply-twice: second apply raised', false, SQLSTATE || ' ' || SQLERRM);"
      echo 'END $apply2$;'
    fi
    if grep -q -- '-- harness: rollback' "$ctl"; then
      rb_body "$rb"
      grep -q -- '-- harness: reapply' "$ctl" && cat "$mig"
      grep -q -- '-- harness: full-rollback' "$ctl" && rb_body "$FULL_RB"
    fi
  fi
  cat "$ctl"
  echo "SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '|' || label || '|' || coalesce(detail, '') FROM t3673_r ORDER BY seq;"
  echo "SELECT 'CHECKS|' || count(*) FROM t3673_r;"
  echo "ROLLBACK;"
}

run_one() { # $1 control, $2 migration, $3 data rollback; prints status lines;
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

# Every control (optionally filtered) against the unmutated migration; prints
# the CONTROLS tally; returns 0 only when every control PASSes.
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
echo "FILES|migration $(basename "$MIG") md5=$(md5of "$MIG")|rollback md5=$(md5of "$RB")|full-rollback md5=$(md5of "$FULL_RB")"
echo "VENUE|$(echo "select version() || ' | users=' || (select count(*) from public.users) || ' | owner=' || (select tableowner from pg_tables where schemaname='public' and tablename='users');" | psql_in)"

grep -q 'apply2\$' "$MIG" && { echo "ERROR|migration contains the \$apply2\$ tag build() uses"; exit 2; }

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
      echo "$verdict|$name"
      case "$verdict" in KILLED) killed=$((killed+1));; SURVIVED) survived=$((survived+1));; *) invalid=$((invalid+1));; esac
    done < <(python3 "$HERE/lib/mutants.py" list)
    echo "MUTANTS: killed=$killed survived=$survived invalid=$invalid"
    [ "$survived" = 0 ] && [ "$invalid" = 0 ] && [ "$killed" -gt 0 ] ;;
  *) echo "usage: run.sh controls|mutants [fragment]"; exit 2 ;;
esac
