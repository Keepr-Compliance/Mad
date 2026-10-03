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
# Output: PASS|label|detail or FAIL|label|detail; exit 1 on any FAIL or on a
# control that produced no checks.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="${MIG_OVERRIDE:-$REPO/supabase/migrations/20261003160000_backlog_3673_onboarding_completed_backfill.sql}"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
RB="${ROLLBACK_FILE:?set ROLLBACK_FILE}"; FULL_RB="${FULL_ROLLBACK_FILE:?set FULL_ROLLBACK_FILE}"
psql_in() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -"; }

# A rollback file as run inside the harness transaction: its own BEGIN/COMMIT
# stripped, the pasted id list replaced by the fixtures' pre-check list.
rb_body() {
  grep -viE '^\s*(begin|commit);\s*$' "$1" \
    | sed 's/^INSERT INTO r3673_ids .*-- @IDS.*$/INSERT INTO r3673_ids (id) SELECT id FROM t3673_pre;/'
}

build() { # $1 control file, $2 migration file, $3 data rollback file
  local ctl="$1" mig="$2" rb="$3"
  echo "BEGIN;"
  cat "$HERE/lib/harness.sql" "$HERE/lib/fixtures.sql"
  if ! grep -q -- '-- harness: baseline' "$ctl"; then
    cat "$mig"
    grep -q -- '-- harness: apply-twice' "$ctl" && cat "$mig"
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

run_one() { # $1 control, $2 migration, $3 data rollback; prints results, returns 1 on failure
  local out
  out="$(build "$1" "$2" "$3" | psql_in 2>&1)" || { echo "$out" | tail -3; echo "ERROR|$(basename "$1")|psql failed"; return 1; }
  echo "$out" | grep -E '^(PASS|FAIL)\|' || true
  local n; n="$(echo "$out" | sed -n 's/^CHECKS|//p')"
  if [ -z "$n" ] || [ "$n" = "0" ]; then echo "ERROR|$(basename "$1")|0 checks"; return 1; fi
  ! echo "$out" | grep -q '^FAIL|'
}

md5of() { (md5 -q "$1" 2>/dev/null || md5sum "$1" | cut -d' ' -f1); }
echo "FILES|migration $(basename "$MIG") md5=$(md5of "$MIG")|rollback md5=$(md5of "$RB")|full-rollback md5=$(md5of "$FULL_RB")"
echo "VENUE|$(echo "select version() || ' | users=' || (select count(*) from public.users) || ' | owner=' || (select tableowner from pg_tables where schemaname='public' and tablename='users');" | psql_in)"

mode="${1:-controls}"; frag="${2:-}"
case "$mode" in
  controls)
    rc=0
    for c in "$HERE"/controls/*${frag}*.sql; do
      echo "== $(basename "$c")"; run_one "$c" "$MIG" "$RB" || rc=1
    done
    exit $rc ;;
  mutants)
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    rc=0
    while IFS='|' read -r name targets; do
      [ -n "$frag" ] && [[ "$name" != *"$frag"* ]] && continue
      # raises unless the pattern occurs exactly once, so an unapplied mutant never counts
      python3 "$HERE/lib/mutants.py" apply "$name" "$MIG" "$RB" "$tmp/m.sql" "$tmp/rb.sql"
      changed="$( (diff "$MIG" "$tmp/m.sql"; diff "$RB" "$tmp/rb.sql") | grep -E '^[<>]' | head -1 | cut -c1-140 || true)"
      [ -n "$changed" ] || { echo "ERROR|$name|mutant changed nothing"; rc=1; continue; }
      echo "== $name  MUTATION APPLIED: $changed"
      red=0
      for t in $targets; do
        if run_one "$HERE/controls/$t.sql" "$tmp/m.sql" "$tmp/rb.sql" >"$tmp/out" 2>&1; then :; else red=1; grep -E '^(FAIL|ERROR)\|' "$tmp/out" | head -3; fi
      done
      if [ $red = 1 ]; then echo "KILLED|$name"; else echo "SURVIVED|$name"; rc=1; fi
    done < <(python3 "$HERE/lib/mutants.py" list)
    exit $rc ;;
  *) echo "usage: run.sh controls|mutants [fragment]"; exit 2 ;;
esac
