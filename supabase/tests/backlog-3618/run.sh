#!/usr/bin/env bash
# BACKLOG-3618 harness. Loads every checklist migration production runs (the
# backlog-3607 prelude plus 20260921101758 and 20260925044046, then the three
# 3596 files and the 3607 file), records the catalogue fingerprint, applies the
# 3618 file (or a mutant of it), then runs ONE control, in ONE transaction that
# ends with ROLLBACK.
#
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh controls [fragment]
#   SSH_HOST=... PG_CONTAINER=... bash run.sh mutants  [fragment]
#   SSH_HOST=... PG_CONTAINER=... bash run.sh regression [fragment]
#
#   controls    controls/e*.sql (this file's controls)
#   mutants     lib/mutants.py against their target controls
#   regression  the 3607 controls (d*) and the 3596 controls (c*) on top of the
#               3618 file, minus the ones that snapshot or roll back their own
#               files (c21 c22 c25 c30 d14 d15): 3618 re-creates the add and
#               snapshot bodies, so their behaviour is re-proved here.
#
# Control header tags:
#   -- harness: apply-twice     the 3618 file runs twice before the control
#   -- harness: rollback-3618   the control's text up to the line
#                               `-- @@ROLLBACK@@` runs, then rollback-3618.sql,
#                               then the rest of the control
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIGDIR="$REPO/supabase/migrations"
T3473="$REPO/supabase/tests/backlog-3473/lib"
T3477="$REPO/supabase/tests/backlog-3477/lib"
T96="$REPO/supabase/tests/backlog-3596"
T07="$REPO/supabase/tests/backlog-3607"
PRE=( "$MIGDIR/20260921101756_backlog_3473_feature_reads_honour_min_tier.sql"
      "$MIGDIR/20260921101758_backlog_3473_retire_unused_org_columns.sql"
      "$MIGDIR/20260924183422_backlog_3535_checklists_min_tier_individual.sql"
      "$MIGDIR/20260924190429_backlog_3474_save_checklist_template.sql"
      "$MIGDIR/20260924224113_backlog_3474_template_audit_fields.sql"
      "$MIGDIR/20260924234221_backlog_3476_several_checklists_per_submission.sql"
      "$MIGDIR/20260925044046_backlog_3535_solo_checklists.sql"
      "$MIGDIR/20260925073000_backlog_3477_submission_checklist_review.sql" )
MIG3473_2="$MIGDIR/20260921101757_backlog_3473_transaction_checklists.sql"
MIG3547="$MIGDIR/20260927120000_backlog_3547_submission_insert_pre_review.sql"
M96=( "$MIGDIR/20260928120000_backlog_3596_broker_checklist_ticks.sql"
      "$MIGDIR/20260928130000_backlog_3596_review_refusals.sql"
      "$MIGDIR/20260928170000_backlog_3596_added_checklist_ticks.sql" )
M07="$MIGDIR/20260929120000_backlog_3607_checklist_add_remove.sql"
DRAFT="$MIGDIR/20261001120000_backlog_3618_agent_checklist_templates.sql"
DRAFT_RB="$HERE/rollback-3618.sql"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20)
psql_in() { ssh "${SSH_OPTS[@]}" "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -tA -f -"; }
catalogue() {
  awk -v verify="$T3473/venue-catalogue-verify.sql" '
    $0 == "BEGIN;" || $0 == "COMMIT;" { next }
    $0 == "\\ir venue-catalogue-verify.sql" { while ((getline l < verify) > 0) print l; close(verify); next }
    { print }' "$T3473/venue-catalogue.sql"
}
prelude() {
  catalogue
  cat "$MIG3473_2" "$T3473/fixtures.sql" "${PRE[@]}"
  cat "$T3477/fixtures-3477.sql" "$MIG3547" "$T96/lib/fixtures-3596.sql" "$T07/lib/fixtures-3607.sql"
  cat "${M96[@]}" "$M07"
  cat "$HERE/lib/fixtures-3618.sql"
  echo "CREATE FUNCTION pg_temp.fp3618() RETURNS TABLE (k text, v text) LANGUAGE sql AS \$fp\$"
  grep -v '^--' "$HERE/lib/fp-3618.sql"
  echo "\$fp\$;"
  cat "$HERE/lib/hunks-3618.sql"
  echo "CREATE TEMP TABLE t3618_before AS SELECT * FROM pg_temp.fp3618();"
}
# run_control <control> [draft] [draft rollback]
run_control() {
  local control="$1" d="${2:-$DRAFT}" drb="${3:-$DRAFT_RB}" out rc
  set +e
  out=$( { echo "BEGIN;"; prelude
           cat "$d"
           if grep -q '^-- harness: apply-twice' "$control"; then
             echo "CREATE TEMP TABLE t3618_once AS SELECT * FROM pg_temp.fp3618();"; cat "$d"; fi
           if grep -q '^-- harness: rollback-3618' "$control"; then
             grep -q '^-- @@ROLLBACK@@$' "$control" || { echo "SELECT 1/0 AS missing_rollback_marker;"; }
             sed '/^-- @@ROLLBACK@@$/,$d' "$control"; cat "$drb"; sed '1,/^-- @@ROLLBACK@@$/d' "$control"
           else cat "$control"; fi
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
ctl() { local t="$1" c; for c in "$HERE"/controls/"$t"-*.sql; do [ -f "$c" ] && echo "$c"; done; }
regression_controls() {
  for c in "$T07"/controls/d*.sql; do n="$(basename "$c" | cut -d- -f1)"
    case "$n" in d14|d15) ;; *) echo "$c" ;; esac; done
  for c in "$T96"/controls/c*.sql; do n="$(basename "$c" | cut -d- -f1)"
    case "$n" in c21|c22|c25|c30) ;; *)
      if ls "$T07"/controls/"$n"-*.sql >/dev/null 2>&1; then ls "$T07"/controls/"$n"-*.sql; else echo "$c"; fi ;; esac; done
}
run_set() {
  local only="$1" fail=0 n=0 c
  while read -r c; do
    [ -n "$only" ] && [[ "$(basename "$c")" != *"$only"* ]] && continue
    run_control "$c"; n=$((n+1))
    printf '%-40s %-5s %s\n' "$(basename "$c" .sql)" "$CONTROL_RESULT" "$CONTROL_DETAIL"
    [ "$CONTROL_RESULT" = "GREEN" ] || { fail=$((fail+1)); [ -n "${VERBOSE:-}" ] && echo "$CONTROL_OUT" | tail -30; }
  done
  echo "controls: $((n-fail)) green / $n"; [ $n -gt 0 ] || exit 1; [ $fail -eq 0 ] || exit 1
}
case "${1:-}" in
  controls) ls "$HERE"/controls/e*.sql | run_set "${2:-}" ;;
  regression) regression_controls | run_set "${2:-}" ;;
  mutants)
    only="${2:-}"; total=0; missed=0; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    python3 "$HERE/lib/mutants.py" "$DRAFT" "$DRAFT_RB" "$tmp"
    for m in "$tmp"/n*.sql; do
      name="$(basename "$m" .sql)"; [ -n "$only" ] && [[ "$name" != *"$only"* ]] && continue
      total=$((total+1)); targets="$(cat "$tmp/$name.targets")"; kind="$(cat "$tmp/$name.file")"
      want="$(cat "$tmp/$name.want")"
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
        if [ "$want" = red ] && [ -z "$hit" ]; then verdict="MISSED: $t stayed green"; missed=$((missed+1)); fi
        if [ "$want" = green ] && [ -n "$hit" ]; then verdict="UNEXPECTED RED: $t"; missed=$((missed+1)); fi; done
      printf '%s [want %s: %s] (%s)\n    MUTATION APPLIED: %s line(s); first: %s\n    RED: %s  green: %s\n' \
        "$name" "$want" "$verdict" "$kind" "$changed" "$first" "${reds[*]:-none}" "${greens[*]:-none}"
      [ ${#details[@]} -gt 0 ] && printf '%s\n' "${details[@]}" | cut -c1-260
    done
    echo "mutants: $total run, $missed not as expected"; [ $total -gt 0 ] || exit 1; [ $missed -eq 0 ] || exit 1 ;;
  *) sed -n '2,24p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
