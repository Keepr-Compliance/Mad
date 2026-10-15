#!/usr/bin/env bash
# BACKLOG-3538 harness. Each control runs in ONE transaction that ends with
# ROLLBACK, in this order:
#   3679 helpers + 3538 helpers, 3679 fixtures + 3538 fixtures (no guard yet),
#   the 3679 migration, preconditions.sql (C-2; a failure = ERROR),
#   fingerprint fp_before, the 3538 migration (or a mutant of it), the control.
# Nothing is ever committed.
#
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh precheck
#   SSH_HOST=... PG_CONTAINER=... bash run.sh controls [fragment]
#   SSH_HOST=... PG_CONTAINER=... bash run.sh mutants  [fragment]
#
# Controls: this directory's k11-k16 plus backlog-3679's k02-k08 and k99, run
# unchanged on top of the 3538 file. backlog-3679's k01 (baseline = before 3679),
# k09 and k10 (apply-twice / rollback of 3679 against a pre-3679 fingerprint) are
# not run here; k15 and k16 cover apply-twice and rollback of the 3538 file.
#
# Control header tags:
#   -- harness: apply-twice  the 3538 file runs twice (second apply inside a block,
#                            so a raise is recorded as a FAIL check)
#   -- harness: rollback     rollback-3538.sql runs after the 3538 file
# Output: PASS|label|detail, FAIL|label|detail, or ERROR|control|reason (psql
# failed, or the control produced no checks).
#
# controls: CONTROLS: pass=X fail=Y error=Z (per control file); exit 0 only when every control PASSes.
# mutants:  runs every control against the unmutated file first and stops unless all PASS.
#   Then per mutant: KILLED (>=1 assertion FAIL, no ERROR), SURVIVED (all PASS),
#   EXPECTED SURVIVOR (all PASS, and mutants.py marks it held by review),
#   INVALID (any ERROR). Ends with
#   MUTANTS: killed=X survived=Y expected_survivor=E invalid=Z
#   exit 0 only when survived=0 and invalid=0.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
T3679="$REPO/supabase/tests/backlog-3679"
MIG3679="$REPO/supabase/migrations/20261003061523_backlog_3679_invite_accept_policy.sql"
MIG="${MIG_OVERRIDE:-$REPO/supabase/migrations/20261007210000_backlog_3538_invite_accept_hardening.sql}"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
psql_in() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -"; }

CONTROLS_3679="k02-admin-actions-work k03-invitee-callback-accepts k04-invitee-attacks-refused k05-other-user-refused k06-expired-and-case k07-definer-and-service-paths k08-auth-users-stays-closed k99-organization-unchanged"

ctl_path() { # $1 control name -> path
  if [ -e "$HERE/controls/$1.sql" ]; then echo "$HERE/controls/$1.sql"
  elif [ -e "$T3679/controls/$1.sql" ]; then echo "$T3679/controls/$1.sql"
  else echo "ERROR|no control named $1" >&2; return 1; fi
}

all_controls() {
  local c
  for c in $CONTROLS_3679; do echo "$c"; done
  for c in "$HERE"/controls/*.sql; do basename "$c" .sql; done
}

build() { # $1 control file, $2 3538 migration file
  local ctl="$1" mig="$2"
  echo "BEGIN;"
  cat "$T3679/lib/harness.sql" "$HERE/lib/harness-3538.sql" "$T3679/lib/fixtures.sql" "$HERE/lib/fixtures-3538.sql" "$MIG3679" "$HERE/lib/preconditions.sql"
  echo "SELECT set_config('t3538.fp_before', pg_temp.fp3538(), true) IS NULL;"
  cat "$mig"
  if grep -q -- '-- harness: apply-twice' "$ctl"; then
    echo 'DO $apply2$ BEGIN'
    cat "$mig"
    echo "EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.check('apply-twice: second apply raised', false, SQLSTATE || ' ' || SQLERRM);"
    echo 'END $apply2$;'
  fi
  if grep -q -- '-- harness: rollback' "$ctl"; then
    # rollback-3538.sql carries its own BEGIN/COMMIT for production use; strip them here.
    grep -viE '^\s*(begin|commit);\s*$' "$HERE/rollback-3538.sql"
  fi
  cat "$ctl"
  echo "SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '|' || label || '|' || coalesce(detail, '') FROM t3679_r ORDER BY seq;"
  echo "SELECT 'CHECKS|' || count(*) FROM t3679_r;"
  echo "ROLLBACK;"
}

run_one() { # $1 control file, $2 migration; prints status lines; returns 0 PASS, 1 FAIL, 2 ERROR
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

run_controls() { # $1 fragment
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
    # C-3: read-only catalogue check of the venue before any run.
    echo "select 'link_trigger_on_auth_users=' || count(*) from pg_trigger where tgrelid='auth.users'::regclass and tgname='on_auth_user_created_link_invitations';
          select 'claim_pending_invite=' || (to_regprocedure('public.claim_pending_invite()') is not null);
          select 'handle_new_user_invitation_link=' || (to_regprocedure('public.handle_new_user_invitation_link()') is not null);" | psql_in ;;
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
      # raises unless every pattern occurs exactly once, so an unapplied mutant never counts
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
