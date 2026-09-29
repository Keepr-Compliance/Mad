#!/usr/bin/env bash
# BACKLOG-3608 harness. Runs the backlog-3607 chain (3473..3547 prelude, the
# three 3596 files, the 3607 file), then the 3608 file (or a mutant of it),
# then one control, in ONE transaction that ends with ROLLBACK.
#
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh gate
#   bash run.sh controls [fragment]   3608 controls (e*) + every 3607 control
#                                     (d* and the 3596 c* it runs)
#   bash run.sh mutants  [fragment]   lib/mutants.py against their targets
#   G=/dev/null bash run.sh controls  the chain WITHOUT the 3608 file
#
# Marker in a control:
#   -- harness: pre-rows   builds one reviewed deal BEFORE the 3608 file and
#                          snapshots every status_history into t3608_h0.
#   -- harness: apply-twice  records the guard / UPDATE rule md5s after the
#                          3608 file (t3608.guard_md5, t3608.pol_md5), then
#                          runs the file again.
#   -- harness: rollback   runs rollback-3608.sql after the 3608 file.
# controls/c20-*.sql replaces 3596 C20 (the submitter branch changed).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
T07="$REPO/supabase/tests/backlog-3607"
T96="$REPO/supabase/tests/backlog-3596"
MIGDIR="$REPO/supabase/migrations"
T3477="$REPO/supabase/tests/backlog-3477"
LIB3473="$REPO/supabase/tests/backlog-3473/lib"
PRE=( "$MIGDIR/20260921101756_backlog_3473_feature_reads_honour_min_tier.sql" "$MIGDIR/20260924183422_backlog_3535_checklists_min_tier_individual.sql"
      "$MIGDIR/20260924190429_backlog_3474_save_checklist_template.sql" "$MIGDIR/20260924224113_backlog_3474_template_audit_fields.sql"
      "$MIGDIR/20260924234221_backlog_3476_several_checklists_per_submission.sql" "$MIGDIR/20260925073000_backlog_3477_submission_checklist_review.sql" )
MIG3473_2="$MIGDIR/20260921101757_backlog_3473_transaction_checklists.sql"
MIG3547="$MIGDIR/20260927120000_backlog_3547_submission_insert_pre_review.sql"
M96A="$MIGDIR/20260928120000_backlog_3596_broker_checklist_ticks.sql"
M96B="$MIGDIR/20260928130000_backlog_3596_review_refusals.sql"
M96C="$MIGDIR/20260928170000_backlog_3596_added_checklist_ticks.sql"
M07="$MIGDIR/20260929120000_backlog_3607_checklist_add_remove.sql"
GUARD="$MIGDIR/20260929130000_backlog_3608_status_history_client_appends.sql"
G="${G:-$GUARD}"
RB="$HERE/rollback-3608.sql"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20)
psql_in() { ssh "${SSH_OPTS[@]}" "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -tA -f -"; }
catalogue() {
  awk -v verify="$LIB3473/venue-catalogue-verify.sql" '
    $0 == "BEGIN;" || $0 == "COMMIT;" { next }
    $0 == "\\ir venue-catalogue-verify.sql" { while ((getline l < verify) > 0) print l; close(verify); next }
    { print }' "$LIB3473/venue-catalogue.sql"
}
run_control() {
  local control="$1" g="${2:-$G}" out rc
  set +e
  out=$( { echo "BEGIN;"; catalogue; cat "$MIG3473_2" "$LIB3473/fixtures.sql" "${PRE[@]}"
           cat "$T3477/lib/fixtures-3477.sql" "$MIG3547" "$T96/lib/fixtures-3596.sql" "$T07/lib/fixtures-3607.sql"
           cat "$M96A" "$M96B" "$M96C" "$M07"
           if grep -q '^-- harness: pre-rows' "$control"; then
             echo "SELECT pg_temp.build_v1('fixture-3608-pre');"
             echo "CREATE TEMP TABLE t3608_h0 AS SELECT id, status_history FROM public.transaction_submissions;"
           fi
           cat "$g"
           if grep -q '^-- harness: apply-twice' "$control"; then
             echo "SELECT set_config('t3608.guard_md5', (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_status_history_append_only()'::regprocedure), false);"
             echo "SELECT set_config('t3608.pol_md5', (SELECT md5(COALESCE(pg_get_expr(polqual, polrelid), '') || '|' || COALESCE(pg_get_expr(polwithcheck, polrelid), '')) FROM pg_policy WHERE polrelid = 'public.transaction_submissions'::regclass AND polname = 'transaction_submissions_update_public'), false);"
             cat "$g"
           fi
           if grep -q '^-- harness: rollback' "$control"; then cat "$RB"; fi
           cat "$control"
           echo "SELECT 'ASSERTIONS=' || current_setting('t3473.asserts');"; echo "ROLLBACK;"
         } | psql_in 2>&1 )
  rc=$?; set -e
  CONTROL_OUT="$out"
  local asserts; asserts=$(grep -o 'ASSERTIONS=[0-9]*' <<<"$out" | tail -1 | cut -d= -f2 || true)
  if [ $rc -eq 0 ] && [ -n "$asserts" ] && [ "$asserts" -gt 0 ]; then CONTROL_RESULT="GREEN"; CONTROL_DETAIL="$asserts assertions"
  elif [ $rc -eq 0 ]; then CONTROL_RESULT="VOID"; CONTROL_DETAIL="exit 0 but no assertion ran"
  else CONTROL_RESULT="RED"
    CONTROL_DETAIL="$(grep -m1 -E 'ERROR|FATAL' <<<"$out" | sed -E 's/^.*(ERROR|FATAL):[[:space:]]*//' | cut -c1-700 || true)"
    [ -n "$CONTROL_DETAIL" ] || CONTROL_DETAIL="exit $rc: $(tail -1 <<<"$out" | cut -c1-200)"
  fi
  CONTROL_DETAIL="$(sed -E 's/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/<id>/g' <<<"$CONTROL_DETAIL")"
}
# Controls: e* here; then 3607's set (its d*, and the 3596 c* it runs, a 3607
# copy replacing a 3596 control of the same number). c10 pins the 3477 guard
# md5, which this file changes on purpose: e05 is its 3608 copy.
ctl() { local t="$1" c
        for c in "$HERE"/controls/"$t"-*.sql "$T07"/controls/"$t"-*.sql; do [ -f "$c" ] && { echo "$c"; return; }; done
        for c in "$T96"/controls/"$t"-*.sql; do [ -f "$c" ] && echo "$c"; done; }
all_controls() {
  for c in "$HERE"/controls/e*.sql; do echo "$c"; done
  [ -n "${ONLY_E:-}" ] && return
  for c in "$T07"/controls/d*.sql; do case "$(basename "$c")" in d14-*|d15-*) ;; *) echo "$c" ;; esac; done
  for c in "$T96"/controls/c*.sql; do n="$(basename "$c" | cut -d- -f1)"
    case "$n" in c10|c21|c22|c25|c30) ;; *) ctl "$n" ;; esac; done
}
case "${1:-}" in
  gate) bash "$T96/run.sh" gate ;;
  probe) run_control "$HERE/probes/p90-probe.sql"; echo "$CONTROL_DETAIL" ;;
  one) run_control "$2" "${3:-$G}"; echo "$CONTROL_RESULT $CONTROL_DETAIL"; grep -E 'NOTICE' <<<"$CONTROL_OUT" | tail -40 || true ;;
  controls)
    only="${2:-}"; fail=0; n=0
    while read -r c; do
      [ -n "$only" ] && [[ "$(basename "$c")" != *"$only"* ]] && continue
      run_control "$c"; n=$((n+1))
      printf '%-40s %-5s %s\n' "$(basename "$c" .sql)" "$CONTROL_RESULT" "$CONTROL_DETAIL"
      [ "$CONTROL_RESULT" = "GREEN" ] || fail=$((fail+1))
    done < <(all_controls)
    echo "controls: $((n-fail)) green / $n"; [ $n -gt 0 ] || exit 1; [ $fail -eq 0 ] || exit 1 ;;
  mutants)
    only="${2:-}"; total=0; missed=0; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    python3 "$HERE/lib/mutants.py" "$GUARD" "$tmp"
    for m in "$tmp"/k*.sql; do
      name="$(basename "$m" .sql)"; [ -n "$only" ] && [[ "$name" != *"$only"* ]] && continue
      total=$((total+1)); targets="$(cat "$tmp/$name.targets")"
      changed="$(diff "$GUARD" "$m" | grep -c '^[<>]' || true)"
      [ "$changed" -gt 0 ] || { echo "$name: MUTATION NOT APPLIED" >&2; exit 1; }
      first="$(diff "$GUARD" "$m" | grep -m1 '^>' | sed 's/^> *//' | cut -c1-110 || true)"
      [ -n "$first" ] || first="removed: $(diff "$GUARD" "$m" | grep -m1 '^<' | sed 's/^< *//' | cut -c1-100 || true)"
      run=(); for t in $targets; do while read -r c; do [ -n "$c" ] && run+=( "$c" ); done < <(ctl "$t"); done
      [ ${#run[@]} -gt 0 ] || { echo "$name: no control matches '$targets'" >&2; exit 1; }
      reds=(); greens=(); details=()
      for c in "${run[@]}"; do
        run_control "$c" "$m"; cn="$(basename "$c" .sql | cut -d- -f1)"
        case "$CONTROL_RESULT" in RED) reds+=("$cn"); details+=("      $cn: $CONTROL_DETAIL") ;;
          VOID) echo "$name x $cn: VOID" >&2; exit 1 ;; *) greens+=("$cn") ;; esac
      done
      verdict="as expected"
      for t in $targets; do hit=""; for r in "${reds[@]:-}"; do [ "$r" = "$t" ] && hit=1; done
        [ -n "$hit" ] || { verdict="MISSED: $t stayed green"; missed=$((missed+1)); }; done
      printf '%s [%s]\n    MUTATION APPLIED: %s line(s); first: %s\n    RED: %s  green: %s\n' \
        "$name" "$verdict" "$changed" "$first" "${reds[*]:-none}" "${greens[*]:-none}"
      [ ${#details[@]} -gt 0 ] && printf '%s\n' "${details[@]}" | cut -c1-260
    done
    echo "mutants: $total run, $missed not as expected"; [ $total -gt 0 ] || exit 1; [ $missed -eq 0 ] || exit 1 ;;
  *) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
