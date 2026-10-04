#!/usr/bin/env bash
# BACKLOG-3726 harness. Each control runs in ONE transaction that ends with
# ROLLBACK: fixtures -> the 3726 migration (or a mutant of it) -> the control.
#
#   bash run.sh venue              fresh `supabase start` -> backlog-3403 prelude + the applied 3403 and 3725
#                                  files + pg_cron + FORCE RLS (as production); committed, once
#   bash run.sh controls [frag]    controls/*.sql
#   bash run.sh mutants  [frag]    lib/mutants.py against their target controls
#
# M3725 = path of the 3725 migration (default: supabase/migrations/20261004213050_backlog_3725_abandoned_at.sql).
# Venue: PG_CONTAINER (default supabase_db_keepr-test). Nothing here can reach production.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
DRAFT="$REPO/supabase/migrations/20261005120000_backlog_3726_submission_sweep.sql"
SCHED="$REPO/supabase/migrations/20261005120100_backlog_3726_submission_sweep_schedule.sql"
M3403="$REPO/supabase/migrations/20261004192647_backlog_3403_finalize_submission.sql"
M3725="${M3725:-$REPO/supabase/migrations/20261004213050_backlog_3725_abandoned_at.sql}"
CONTAINER="${PG_CONTAINER:-supabase_db_keepr-test}"
psql_in() { docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -X -tA -q -f -; }
run_control() {
  local control="$1" d="${2:-$DRAFT}" out rc
  set +e
  out=$( { echo "BEGIN;"; cat "$HERE/lib/fixtures-3726.sql"; cat "$d"
           if grep -q '^-- harness: apply-twice' "$control"; then
             echo "SELECT set_config('t3726.secret1', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'submission_sweep_secret'), true);"; cat "$d"; fi
           if grep -q '^-- harness: schedule' "$control"; then cat "$SCHED" "$SCHED"; fi
           if grep -q '^-- harness: rollback' "$control"; then cat "$SCHED" "$HERE/rollback-3726.sql"; fi
           cat "$control"
           echo "RESET ROLE;"; echo "SELECT 'ASSERTIONS=' || current_setting('t3726.asserts');"; echo "ROLLBACK;"
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
  venue)
    [ -f "$M3725" ] || { echo "3725 migration not found: $M3725 (set M3725)" >&2; exit 1; }
    psql_in < "$REPO/supabase/tests/backlog-3403/lib/parity-prelude.sql"
    psql_in < "$M3403"; psql_in < "$M3725"
    echo "CREATE EXTENSION IF NOT EXISTS pg_cron; ALTER TABLE public.transaction_submissions FORCE ROW LEVEL SECURITY;" | psql_in
    echo "venue ready (3403 + 3725 applied; 3725 md5 $(md5 -q "$M3725" 2>/dev/null || md5sum "$M3725" | cut -d' ' -f1))" ;;
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
    python3 "$HERE/lib/mutants.py" "$DRAFT" "$tmp"
    for m in "$tmp"/*.sql; do
      name="$(basename "$m" .sql)"; [ -n "$only" ] && [[ "$name" != *"$only"* ]] && continue
      total=$((total+1)); targets="$(cat "$tmp/$name.targets")"; desc="$(cat "$tmp/$name.desc")"; want="$(cat "$tmp/$name.want")"
      changed="$(diff "$DRAFT" "$m" | grep -c '^[<>]' || true)"
      [ "$changed" -gt 0 ] || { echo "$name: MUTATION NOT APPLIED" >&2; exit 1; }
      first="$(diff "$DRAFT" "$m" | grep -m1 '^>' | sed 's/^> *//' | cut -c1-110 || true)"
      reds=(); greens=(); details=()
      for c in "$HERE"/controls/*.sql; do
        run_control "$c" "$m"; cn="$(basename "$c" .sql | cut -d- -f1)"
        case "$CONTROL_RESULT" in RED) reds+=("$cn"); details+=("      $cn: $CONTROL_DETAIL") ;;
          VOID) echo "$name x $cn: VOID" >&2; exit 1 ;; *) greens+=("$cn") ;; esac
      done
      verdict="as expected"
      if [ "$want" = "red" ]; then
        for t in $targets; do hit=""; for r in "${reds[@]:-}"; do [ "$r" = "$t" ] && hit=1; done
          [ -z "$hit" ] && { verdict="MISSED: $t stayed green"; missed=$((missed+1)); }; done
      else
        [ ${#reds[@]} -eq 0 ] || { verdict="NOT EQUIVALENT: ${reds[*]} red"; missed=$((missed+1)); }
      fi
      printf '%s [%s] (want %s) %s\n    MUTATION APPLIED: %s line(s); first: %s\n    RED: %s\n' \
        "$name" "$verdict" "$want" "$desc" "$changed" "$first" "${reds[*]:-none}"
      [ ${#details[@]} -gt 0 ] && printf '%s\n' "${details[@]}" | cut -c1-240
    done
    echo "mutants: $total run, $missed not as expected"; [ $total -gt 0 ] || exit 1; [ $missed -eq 0 ] || exit 1 ;;
  *) sed -n '2,13p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
