#!/usr/bin/env bash
# BACKLOG-3843 harness. Each control runs in ONE transaction that ends with
# ROLLBACK, in this order:
#   3679 + 3538 + 3843 helpers, 3679 + 3538 + 3843 fixtures (no guard yet),
#   the 3679 migration, 3538 preconditions, the 3538 migration,
#   3843 preconditions (starting guard = production's), fingerprint fp_before,
#   the 3843 migration (or a mutant of it), the control.
# Nothing is ever committed.
#
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh precheck
#   SSH_HOST=... PG_CONTAINER=... bash run.sh controls [fragment]
#   SSH_HOST=... PG_CONTAINER=... bash run.sh mutants  [fragment]
#
# Controls: this directory's k21-k31, plus (K10) backlog-3679 k03-k08, k99 and
# backlog-3538 k11-k14 run unchanged on top of the 3843 file. backlog-3679 k02 is
# not re-run: its "admin Deactivate succeeds" check is the behaviour 3843 removes
# (k26 asserts the opposite; k27 re-runs k02's other admin writes).
#
# Output and verdicts: as backlog-3538/run.sh.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
T3679="$REPO/supabase/tests/backlog-3679"
T3538="$REPO/supabase/tests/backlog-3538"
MIG3679="$REPO/supabase/migrations/20261003061523_backlog_3679_invite_accept_policy.sql"
MIG3538="$REPO/supabase/migrations/20261007210000_backlog_3538_invite_accept_hardening.sql"
MIG="${MIG_OVERRIDE:-$REPO/supabase/migrations/20261010150116_backlog_3843_org_member_client_write_lockdown.sql}"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
psql_in() {
  if [ "$SSH_HOST" = local ]; then docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -
  else ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -"; fi
}

CONTROLS_PRIOR="k03-invitee-callback-accepts k04-invitee-attacks-refused k05-other-user-refused k06-expired-and-case k07-definer-and-service-paths k08-auth-users-stays-closed k99-organization-unchanged k11-accept-pins-joined-at k12-anon-cannot-claim k13-link-function-dropped k14-other-writers-keep-joined-at"

ctl_path() {
  local d
  for d in "$HERE" "$T3538" "$T3679"; do
    if [ -e "$d/controls/$1.sql" ]; then echo "$d/controls/$1.sql"; return 0; fi
  done
  echo "ERROR|no control named $1" >&2; return 1
}

all_controls() {
  local c
  for c in "$HERE"/controls/*.sql; do basename "$c" .sql; done
  for c in $CONTROLS_PRIOR; do echo "$c"; done
}

build() { # $1 control file, $2 3843 migration file
  local ctl="$1" mig="$2"
  echo "BEGIN;"
  cat "$T3679/lib/harness.sql" "$T3538/lib/harness-3538.sql" "$HERE/lib/harness-3843.sql" \
      "$T3679/lib/fixtures.sql" "$T3538/lib/fixtures-3538.sql" "$HERE/lib/fixtures-3843.sql" \
      "$MIG3679" "$T3538/lib/preconditions.sql" "$MIG3538" "$HERE/lib/preconditions-3843.sql"
  echo "SELECT set_config('t3843.fp_before', pg_temp.fp3843(), true) IS NULL;"
  cat "$mig"
  if grep -q -- '-- harness: apply-twice' "$ctl"; then
    echo 'DO $apply2$ BEGIN'
    cat "$mig"
    echo "EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.check('apply-twice: second apply raised', false, SQLSTATE || ' ' || SQLERRM);"
    echo 'END $apply2$;'
  fi
  if grep -q -- '-- harness: rollback' "$ctl"; then
    grep -viE '^\s*(begin|commit);\s*$' "$HERE/rollback-3843.sql"
  fi
  cat "$ctl"
  echo "SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '|' || label || '|' || coalesce(detail, '') FROM t3679_r ORDER BY seq;"
  echo "SELECT 'CHECKS|' || count(*) FROM t3679_r;"
  echo "ROLLBACK;"
}

run_one() {
  local out
  if ! out="$(build "$1" "$2" | psql_in 2>&1)"; then
    echo "$out" | tail -3; echo "ERROR|$(basename "$1")|psql failed"; return 2
  fi
  echo "$out" | grep -E '^(PASS|FAIL)\|' || true
  local n; n="$(echo "$out" | sed -n 's/^CHECKS|//p')"
  if [ -z "$n" ] || [ "$n" = "0" ]; then echo "ERROR|$(basename "$1")|0 checks"; return 2; fi
  if echo "$out" | grep -q '^FAIL|'; then return 1; fi
  return 0
}

run_controls() {
  local pass=0 fail=0 err=0 rc c
  for c in $(all_controls); do
    [[ "$c" == *"$1"* ]] || continue
    echo "== $c"
    rc=0; run_one "$(ctl_path "$c")" "$MIG" || rc=$?
    case $rc in 0) pass=$((pass+1));; 1) fail=$((fail+1));; *) err=$((err+1));; esac
  done
  echo "CONTROLS: pass=$pass fail=$fail error=$err"
  [ "$fail" = 0 ] && [ "$err" = 0 ] && [ "$pass" -gt 0 ]
}

grep -q 'apply2\$' "$MIG" && { echo "ERROR|migration contains the \$apply2\$ tag build() uses"; exit 2; }

mode="${1:-controls}"; frag="${2:-}"
case "$mode" in
  precheck)
    echo "select 'guard_md5=' || md5(pg_get_functiondef('public.guard_invite_acceptance()'::regprocedure));
          select 'org_guard=' || count(*) from pg_trigger where tgrelid='public.organizations'::regclass and tgname='guard_organization_client_update';
          select 'max_migration=' || max(version) from supabase_migrations.schema_migrations;" | psql_in ;;
  controls)
    run_controls "$frag" || exit 1 ;;
  mutants)
    echo "-- baseline: every control against the unmutated migration"
    if ! run_controls ""; then
      echo "MUTANTS: aborted - baseline controls did not all PASS; no mutant was run"
      exit 1
    fi
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    killed=0; survived=0; expected=0; invalid=0
    while IFS='|' read -r name exp targets; do
      [ -n "$frag" ] && [[ "$name" != *"$frag"* ]] && continue
      python3 "$HERE/lib/mutants.py" apply "$name" "$MIG" "$tmp/m.sql"
      changed="$(diff "$MIG" "$tmp/m.sql" | grep '^[<>]' | head -2 | tr '\n' ' ' | cut -c1-160 || true)"
      if [ -z "$changed" ]; then echo "INVALID|$name|mutant changed nothing"; invalid=$((invalid+1)); continue; fi
      echo "== $name  MUTATION APPLIED: $changed"
      : >"$tmp/status"
      for t in $targets; do
        run_one "$(ctl_path "$t")" "$tmp/m.sql" >"$tmp/out" 2>&1 || true
        grep -E '^(PASS|FAIL|ERROR)\|' "$tmp/out" >>"$tmp/status" || true
        grep -E '^(FAIL|ERROR)\|' "$tmp/out" | head -4 || true
      done
      verdict="$(python3 "$HERE/lib/mutants.py" classify <"$tmp/status")"
      if [ "$verdict" = SURVIVED ] && [ "$exp" = survivor ]; then verdict="EXPECTED SURVIVOR"; fi
      echo "$verdict|$name"
      case "$verdict" in KILLED) killed=$((killed+1));; SURVIVED) survived=$((survived+1));;
        "EXPECTED SURVIVOR") expected=$((expected+1));; *) invalid=$((invalid+1));; esac
    done < <(python3 "$HERE/lib/mutants.py" list)
    echo "MUTANTS: killed=$killed survived=$survived expected_survivor=$expected invalid=$invalid"
    [ "$survived" = 0 ] && [ "$invalid" = 0 ] && [ "$killed" -gt 0 ] ;;
  *) echo "usage: run.sh precheck|controls|mutants [fragment]"; exit 2 ;;
esac
