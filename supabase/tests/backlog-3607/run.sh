#!/usr/bin/env bash
# BACKLOG-3607 harness. Runs the backlog-3596
# prelude and its three shipped files, then the 3607 file (or a mutant of
# it), then one control, in ONE transaction that ends with ROLLBACK.
#
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh gate
#   bash run.sh controls [fragment]      3607 controls (d*) + 3596 controls (c*)
#   bash run.sh mutants  [fragment]      lib/mutants.py against their targets
#
# 3596 controls that snapshot/roll back the 3596 files (c21, c22, c25, c30)
# are not run on top of 3607: their catalogue counts are about those files.
# d14 is this file's rollback control.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
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
DRAFT="$MIGDIR/20260929120000_backlog_3607_checklist_add_remove.sql"
DRAFT_RB="$HERE/rollback-3607.sql"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20)
psql_in() { ssh "${SSH_OPTS[@]}" "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -tA -f -"; }
catalogue() {
  awk -v verify="$LIB3473/venue-catalogue-verify.sql" '
    $0 == "BEGIN;" || $0 == "COMMIT;" { next }
    $0 == "\\ir venue-catalogue-verify.sql" { while ((getline l < verify) > 0) print l; close(verify); next }
    { print }' "$LIB3473/venue-catalogue.sql"
}
# run_control <control> [draft] [draft rollback] [3596 refusals] [3596 added]
run_control() {
  local control="$1" d="${2:-$DRAFT}" drb="${3:-$DRAFT_RB}" m96b="${4:-$M96B}" m96c="${5:-$M96C}" out rc
  set +e
  out=$( { echo "BEGIN;"; catalogue; cat "$MIG3473_2" "$LIB3473/fixtures.sql" "${PRE[@]}"
           cat "$T3477/lib/fixtures-3477.sql" "$MIG3547" "$T96/lib/fixtures-3596.sql" "$HERE/lib/fixtures-3607.sql"
           cat "$M96A" "$m96b" "$m96c"
           if grep -q '^-- harness: rollback-3607' "$control"; then echo "CREATE TEMP TABLE t3607_s0 AS SELECT * FROM pg_temp.snap3607();"; fi
           cat "$d"
           if grep -q '^-- harness: apply-twice' "$control"; then echo "CREATE TEMP TABLE t3607_s1 AS SELECT * FROM pg_temp.snap3607();"; cat "$d"; fi
           if grep -q '^-- harness: rollback-3607' "$control"; then echo "CREATE TEMP TABLE t3607_s1 AS SELECT * FROM pg_temp.snap3607();"; cat "$drb"; fi
           cat "$control"
           echo "SELECT 'ASSERTIONS=' || current_setting('t3473.asserts');"; echo "ROLLBACK;"
         } | psql_in 2>&1 )
  rc=$?; set -e
  CONTROL_OUT="$out"
  local asserts; asserts=$(grep -o 'ASSERTIONS=[0-9]*' <<<"$out" | tail -1 | cut -d= -f2 || true)
  if [ $rc -eq 0 ] && [ -n "$asserts" ] && [ "$asserts" -gt 0 ]; then CONTROL_RESULT="GREEN"; CONTROL_DETAIL="$asserts assertions"
  elif [ $rc -eq 0 ]; then CONTROL_RESULT="VOID"; CONTROL_DETAIL="exit 0 but no assertion ran"
  else CONTROL_RESULT="RED"
    CONTROL_DETAIL="$(grep -m1 -E 'ERROR|FATAL' <<<"$out" | sed -E 's/^.*(ERROR|FATAL):[[:space:]]*//' | cut -c1-400 || true)"
    [ -n "$CONTROL_DETAIL" ] || CONTROL_DETAIL="exit $rc: $(tail -1 <<<"$out" | cut -c1-200)"
  fi
  CONTROL_DETAIL="$(sed -E 's/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/<id>/g' <<<"$CONTROL_DETAIL")"
}
# A 3607 copy of a 3596 control (same number) replaces it: c05, c08, c19
# change ON PURPOSE (plan rev 2).
ctl() { local t="$1" c; for c in "$HERE"/controls/"$t"-*.sql; do [ -f "$c" ] && { echo "$c"; return; }; done
        for c in "$T96"/controls/"$t"-*.sql; do [ -f "$c" ] && echo "$c"; done; }
all_controls() {
  for c in "$HERE"/controls/d*.sql; do echo "$c"; done
  for c in "$T96"/controls/c*.sql; do n="$(basename "$c" | cut -d- -f1)"
    case "$n" in c21|c22|c25|c30) ;; *) ctl "$n" ;; esac; done
}
case "${1:-}" in
  gate) bash "$T96/run.sh" gate ;;
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
    python3 "$HERE/lib/mutants.py" "$DRAFT" "$DRAFT_RB" "$M96B" "$M96C" "$tmp"
    for m in "$tmp"/[mn]*.sql; do
      name="$(basename "$m" .sql)"; [ -n "$only" ] && [[ "$name" != *"$only"* ]] && continue
      total=$((total+1)); targets="$(cat "$tmp/$name.targets")"; kind="$(cat "$tmp/$name.file")"
      d="$DRAFT"; drb="$DRAFT_RB"; b="$M96B"; c3="$M96C"
      case "$kind" in draft) base="$DRAFT"; d="$m" ;; draft-rollback) base="$DRAFT_RB"; drb="$m" ;;
        refusals) base="$M96B"; b="$m" ;; added) base="$M96C"; c3="$m" ;; *) echo "bad kind $kind" >&2; exit 1 ;; esac
      changed="$(diff "$base" "$m" | grep -c '^[<>]' || true)"
      [ "$changed" -gt 0 ] || { echo "$name: MUTATION NOT APPLIED" >&2; exit 1; }
      first="$(diff "$base" "$m" | grep -m1 '^>' | sed 's/^> *//' | cut -c1-100 || true)"
      run=(); for t in $targets; do while read -r c; do [ -n "$c" ] && run+=( "$c" ); done < <(ctl "$t"); done
      [ ${#run[@]} -gt 0 ] || { echo "$name: no control matches '$targets'" >&2; exit 1; }
      reds=(); greens=(); details=()
      for c in "${run[@]}"; do
        run_control "$c" "$d" "$drb" "$b" "$c3"; cn="$(basename "$c" .sql | cut -d- -f1)"
        case "$CONTROL_RESULT" in RED) reds+=("$cn"); details+=("      $cn: $CONTROL_DETAIL") ;;
          VOID) echo "$name x $cn: VOID" >&2; exit 1 ;; *) greens+=("$cn") ;; esac
      done
      verdict="as expected"
      for t in $targets; do hit=""; for r in "${reds[@]:-}"; do [ "$r" = "$t" ] && hit=1; done
        [ -n "$hit" ] || { verdict="MISSED: $t stayed green"; missed=$((missed+1)); }; done
      printf '%s [%s] (%s)\n    MUTATION APPLIED: %s line(s); first: %s\n    RED: %s  green: %s\n' \
        "$name" "$verdict" "$kind" "$changed" "$first" "${reds[*]:-none}" "${greens[*]:-none}"
      [ ${#details[@]} -gt 0 ] && printf '%s\n' "${details[@]}" | cut -c1-260
    done
    echo "mutants: $total run, $missed not as expected"; [ $total -gt 0 ] || exit 1; [ $missed -eq 0 ] || exit 1 ;;
  *) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
