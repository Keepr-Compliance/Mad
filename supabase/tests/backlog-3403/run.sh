#!/usr/bin/env bash
# BACKLOG-3403 harness. Each control runs in ONE transaction that ends with
# ROLLBACK: fixtures -> fingerprint (t3403_before) -> the 3403 migration (or a
# mutant of it) -> the control.
#
#   bash run.sh prelude            load lib/parity-prelude.sql (once, committed) into a fresh local stack
#   bash run.sh controls [frag]    controls/*.sql
#   bash run.sh mutants  [frag]    lib/mutants.py against their target controls
#
# Venue: PG_CONTAINER (default supabase_db_keepr-test, i.e. `supabase start` in
# this repo); set SSH_HOST to reach a container on another machine.
#
# Control header tags:
#   -- harness: apply-twice   the migration runs twice; t3403_once holds the fingerprint after the first
#   -- harness: rollback      rollback-3403.sql runs after the migration, before the control
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
DRAFT="$REPO/supabase/migrations/20261004192647_backlog_3403_finalize_submission.sql"
DRAFT_RB="$HERE/rollback-3403.sql"
CONTAINER="${PG_CONTAINER:-supabase_db_keepr-test}"
psql_in() {
  if [ -n "${SSH_HOST:-}" ]; then
    ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -tA -q -f -"
  else
    docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -X -tA -q -f -
  fi
}
fp_fn() {
  echo "CREATE FUNCTION pg_temp.fp3403() RETURNS TABLE (k text, v text) LANGUAGE sql AS \$fp\$"
  grep -v '^--' "$HERE/lib/fp-3403.sql"
  echo "\$fp\$;"
}
# run_control <control> [draft] [rollback]
run_control() {
  local control="$1" d="${2:-$DRAFT}" drb="${3:-$DRAFT_RB}" out rc
  set +e
  out=$( { echo "BEGIN;"
           cat "$HERE/lib/fixtures-3403.sql"; fp_fn
           echo "CREATE TEMP TABLE t3403_before AS SELECT * FROM pg_temp.fp3403();"
           grep -q '^-- harness: no-migration' "$control" || cat "$d"
           if grep -q '^-- harness: apply-twice' "$control"; then
             echo "CREATE TEMP TABLE t3403_once AS SELECT * FROM pg_temp.fp3403();"; cat "$d"; fi
           if grep -q '^-- harness: rollback' "$control"; then cat "$drb"; fi
           cat "$control"
           echo "RESET ROLE;"
           echo "SELECT 'ASSERTIONS=' || current_setting('t3403.asserts');"; echo "ROLLBACK;"
         } | psql_in 2>&1 )
  rc=$?; set -e
  CONTROL_OUT="$out"
  local asserts; asserts=$(grep -o 'ASSERTIONS=[0-9]*' <<<"$out" | tail -1 | cut -d= -f2 || true)
  if [ $rc -eq 0 ] && [ -n "$asserts" ] && [ "$asserts" -gt 0 ]; then CONTROL_RESULT="GREEN"; CONTROL_DETAIL="$asserts assertions"
  elif [ $rc -eq 0 ]; then CONTROL_RESULT="VOID"; CONTROL_DETAIL="exit 0 but no assertion ran"
  else CONTROL_RESULT="RED"
    CONTROL_DETAIL="$(grep -m1 -E 'ERROR|FATAL' <<<"$out" | sed -E 's/^.*(ERROR|FATAL):[[:space:]]*//' | cut -c1-300 || true)"
    [ -n "$CONTROL_DETAIL" ] || CONTROL_DETAIL="exit $rc: $(tail -1 <<<"$out" | cut -c1-200)"
  fi
  CONTROL_DETAIL="$(sed -E 's/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/<id>/g' <<<"$CONTROL_DETAIL")"
}
ctl() { local t="$1" c; for c in "$HERE"/controls/"$t"-*.sql; do [ -f "$c" ] && echo "$c"; done; }
case "${1:-}" in
  prelude) psql_in < "$HERE/lib/parity-prelude.sql"; echo "prelude loaded" ;;
  controls)
    only="${2:-}"; fail=0; n=0
    for c in "$HERE"/controls/*.sql; do
      [ -n "$only" ] && [[ "$(basename "$c")" != *"$only"* ]] && continue
      run_control "$c"; n=$((n+1))
      printf '%-40s %-5s %s\n' "$(basename "$c" .sql)" "$CONTROL_RESULT" "$CONTROL_DETAIL"
      [ "$CONTROL_RESULT" = "GREEN" ] || { fail=$((fail+1)); [ -n "${VERBOSE:-}" ] && echo "$CONTROL_OUT" | tail -30; }
    done
    echo "controls: $((n-fail)) green / $n"; [ $n -gt 0 ] || exit 1; [ $fail -eq 0 ] || exit 1 ;;
  mutants)
    only="${2:-}"; total=0; missed=0; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    python3 "$HERE/lib/mutants.py" "$DRAFT" "$DRAFT_RB" "$tmp"
    for m in "$tmp"/*.sql; do
      name="$(basename "$m" .sql)"; [ -n "$only" ] && [[ "$name" != *"$only"* ]] && continue
      total=$((total+1)); targets="$(cat "$tmp/$name.targets")"; kind="$(cat "$tmp/$name.file")"; desc="$(cat "$tmp/$name.desc")"
      d="$DRAFT"; drb="$DRAFT_RB"
      case "$kind" in draft) base="$DRAFT"; d="$m" ;; rollback) base="$DRAFT_RB"; drb="$m" ;; *) echo "bad kind $kind" >&2; exit 1 ;; esac
      changed="$(diff "$base" "$m" | grep -c '^[<>]' || true)"
      [ "$changed" -gt 0 ] || { echo "$name: MUTATION NOT APPLIED" >&2; exit 1; }
      first="$(diff "$base" "$m" | grep -m1 '^>' | sed 's/^> *//' | cut -c1-110 || true)"
      run=(); for t in $targets; do while read -r c; do [ -n "$c" ] && run+=( "$c" ); done < <(ctl "$t"); done
      [ ${#run[@]} -gt 0 ] || { echo "$name: no control matches '$targets'" >&2; exit 1; }
      reds=(); greens=(); details=()
      for c in "${run[@]}"; do
        run_control "$c" "$d" "$drb"; cn="$(basename "$c" .sql | cut -d- -f1)"
        case "$CONTROL_RESULT" in RED) reds+=("$cn"); details+=("      $cn: $CONTROL_DETAIL") ;;
          VOID) echo "$name x $cn: VOID" >&2; exit 1 ;; *) greens+=("$cn") ;; esac
      done
      verdict="as expected"
      for t in $targets; do hit=""; for r in "${reds[@]:-}"; do [ "$r" = "$t" ] && hit=1; done
        [ -z "$hit" ] && { verdict="MISSED: $t stayed green"; missed=$((missed+1)); }; done
      printf '%s [%s] (%s) %s\n    MUTATION APPLIED: %s line(s); first: %s\n    RED: %s  green: %s\n' \
        "$name" "$verdict" "$kind" "$desc" "$changed" "$first" "${reds[*]:-none}" "${greens[*]:-none}"
      [ ${#details[@]} -gt 0 ] && printf '%s\n' "${details[@]}" | cut -c1-260
    done
    echo "mutants: $total run, $missed not as expected"; [ $total -gt 0 ] || exit 1; [ $missed -eq 0 ] || exit 1 ;;
  *) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
