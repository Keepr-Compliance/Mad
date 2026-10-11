#!/usr/bin/env bash
# BACKLOG-3845 harness. Each control runs in ONE transaction ending in ROLLBACK:
#   version check + helpers, fixtures, fingerprint 'pre', the 3845 migration
#   (or a mutant, or nothing for `baseline`), post-apply data step, optionally a
#   second apply and the rollback file, then the control. Nothing is committed.
#
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh controls [fragment]
#   SSH_HOST=... PG_CONTAINER=... bash run.sh mutants  [fragment]
#   SSH_HOST=... PG_CONTAINER=... bash run.sh baseline [fragment]   # pre-3845 code
#
# Header tags in a control file:
#   -- harness: apply-twice              apply the migration a second time (step apply2)
#   -- harness: rollback                 run rollback-3845.sql after the migration (step rollback)
#   -- harness: pre-rollback: <SQL line> run just before the rollback
#   -- harness: pre-apply: <SQL line>    run just before the pre-apply fingerprint
#   -- harness: expect-raise             do not add the "migration applied" check
# The corpus (corpus/paid_through.json) is available as current_setting('t3845.corpus')
# and the migration's own object list as current_setting('t3845.objects').
# controls: exit 0 only when every control PASSes. mutants: baseline controls
# first, then KILLED / SURVIVED / INVALID per mutant; exit 0 only when every
# mutant is KILLED. baseline: report only (exit 0 when it ran).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="${MIG_OVERRIDE:-$REPO/supabase/migrations/20261011100000_backlog_3845_billing_foundation.sql}"
RB="${RB_OVERRIDE:-$HERE/rollback-3845.sql}"
CORPUS="$HERE/corpus/paid_through.json"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
psql_in() {
  if [ "$SSH_HOST" = local ]; then docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -
  else ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -"; fi
}

# Every public function / table the (unmutated) migration creates.
OBJECTS="$(grep -oE 'CREATE (OR REPLACE )?FUNCTION public\.[a-z_0-9]+|CREATE TABLE IF NOT EXISTS public\.[a-z_0-9]+' \
  "$REPO/supabase/migrations/20261011100000_backlog_3845_billing_foundation.sql" | sed 's/.*public\.//' | sort -u | paste -sd, -)"

step() { # $1 step name, $2 file (BEGIN/COMMIT lines stripped)
  echo "SELECT pg_temp.run_step('$1', \$h3845\$"
  grep -viE '^\s*(begin|commit);\s*$' "$2"
  echo "\$h3845\$);"
}

build() { # $1 control, $2 migration, $3 rollback
  local ctl="$1" mig="$2" rb="$3"
  echo "BEGIN;"
  echo "SET LOCAL TimeZone = 'UTC';"
  cat "$HERE/lib/harness.sql"
  echo "SELECT set_config('t3845.corpus', \$cj\$$(cat "$CORPUS")\$cj\$, true) IS NULL;"
  echo "SELECT set_config('t3845.objects', '$OBJECTS', true) IS NULL;"
  cat "$HERE/lib/fixtures.sql"
  sed -n 's/^-- harness: pre-apply: //p' "$ctl"
  echo "SELECT pg_temp.snap('pre');"
  step apply1 "$mig"
  cat "$HERE/lib/post-apply.sql"
  echo "SELECT pg_temp.snap('after1');"
  if grep -q -- '-- harness: apply-twice' "$ctl"; then
    step apply2 "$mig"; echo "SELECT pg_temp.snap('after2');"
  fi
  sed -n 's/^-- harness: pre-rollback: //p' "$ctl"
  if grep -q -- '-- harness: rollback' "$ctl"; then
    step rollback "$rb"; echo "SELECT pg_temp.snap('after_rb');"
  fi
  if ! grep -q -- '-- harness: expect-raise' "$ctl"; then
    echo "SELECT pg_temp.check('migration applied', pg_temp.step_ok('apply1'), pg_temp.step_err('apply1'));"
  fi
  cat "$ctl"
  echo "SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '|' || label || '|' || coalesce(detail, '') FROM t3845_r ORDER BY seq;"
  echo "SELECT 'CHECKS|' || count(*) FROM t3845_r;"
  echo "ROLLBACK;"
}

run_one() { # prints status lines; returns 0 PASS, 1 FAIL, 2 ERROR
  local out
  if ! out="$(build "$1" "$2" "$3" | psql_in 2>&1)"; then
    echo "$out" | tail -3; echo "ERROR|$(basename "$1")|psql failed"; return 2
  fi
  echo "$out" | grep -E '^(PASS|FAIL)\|' || true
  local n; n="$(echo "$out" | sed -n 's/^CHECKS|//p')"
  if [ -z "$n" ] || [ "$n" = "0" ]; then echo "ERROR|$(basename "$1")|0 checks"; return 2; fi
  if echo "$out" | grep -q '^FAIL|'; then return 1; fi
  return 0
}

ctl_path() { ls "$HERE"/controls/"$1"-*.sql | head -1; }

run_controls() { # $1 fragment, $2 migration
  local pass=0 fail=0 err=0 rc c
  for c in "$HERE"/controls/*.sql; do
    [[ "$(basename "$c")" == *"$1"* ]] || continue
    echo "== $(basename "$c" .sql)"
    rc=0; run_one "$c" "$2" "$RB" || rc=$?
    case $rc in 0) pass=$((pass+1));; 1) fail=$((fail+1));; *) err=$((err+1));; esac
  done
  echo "CONTROLS: pass=$pass fail=$fail error=$err"
  [ "$fail" = 0 ] && [ "$err" = 0 ] && [ "$pass" -gt 0 ]
}

for f in "$MIG" "$RB"; do grep -q 'h3845\$' "$f" && { echo "ERROR|$f contains the \$h3845\$ tag"; exit 2; }; done
grep -q 'cj\$' "$CORPUS" && { echo "ERROR|corpus contains the \$cj\$ tag"; exit 2; }

mode="${1:-controls}"; frag="${2:-}"
case "$mode" in
  controls) run_controls "$frag" "$MIG" || exit 1 ;;
  baseline)
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    echo "-- no migration applied" >"$tmp/empty.sql"
    run_controls "$frag" "$tmp/empty.sql" || true ;;
  mutants)
    echo "-- baseline: every control against the unmutated files"
    run_controls "" "$MIG" || { echo "MUTANTS: aborted - baseline not all PASS"; exit 1; }
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    killed=0; survived=0; invalid=0
    while IFS='|' read -r name file targets; do
      [ -n "$frag" ] && [[ "$name" != *"$frag"* ]] && continue
      if [ "$file" = rb ]; then src="$RB"; else src="$MIG"; fi
      if ! python3 "$HERE/lib/mutants.py" apply "$name" "$src" "$tmp/m.sql"; then
        echo "INVALID|$name|mutant did not apply"; invalid=$((invalid+1)); continue
      fi
      changed="$(diff "$src" "$tmp/m.sql" | grep '^[<>]' | head -3 | tr '\n' ' ' | cut -c1-240 || true)"
      if [ -z "$changed" ]; then echo "INVALID|$name|mutant changed nothing"; invalid=$((invalid+1)); continue; fi
      echo "== $name  MUTATION APPLIED ($file): $changed"
      if [ "$file" = rb ]; then m="$MIG"; r="$tmp/m.sql"; else m="$tmp/m.sql"; r="$RB"; fi
      : >"$tmp/status"
      for t in $targets; do
        run_one "$(ctl_path "$t")" "$m" "$r" >"$tmp/out" 2>&1 || true
        grep -E '^(PASS|FAIL|ERROR)\|' "$tmp/out" | sed "s/^\([A-Z]*\)|/\1|[$t] /" >>"$tmp/status" || true
        grep -E '^(FAIL|ERROR)\|' "$tmp/out" | sed "s/^/  [$t] /" | head -4 || true
      done
      verdict="$(python3 "$HERE/lib/mutants.py" classify <"$tmp/status")"
      echo "$verdict|$name"
      case "$verdict" in KILLED) killed=$((killed+1));; SURVIVED) survived=$((survived+1));; *) invalid=$((invalid+1));; esac
    done < <(python3 "$HERE/lib/mutants.py" list)
    echo "MUTANTS: killed=$killed survived=$survived invalid=$invalid"
    [ "$survived" = 0 ] && [ "$invalid" = 0 ] && [ "$killed" -gt 0 ] ;;
  *) echo "usage: run.sh controls|mutants|baseline [fragment]"; exit 2 ;;
esac
