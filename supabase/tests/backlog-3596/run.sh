#!/usr/bin/env bash
# BACKLOG-3596 harness. Runs the SHIPPED migration
#   supabase/migrations/20260928120000_backlog_3596_broker_checklist_ticks.sql
# on a real Postgres, on top of the migrations production holds for these
# tables (the BACKLOG-3477 prelude, then BACKLOG-3547), and records what every
# control and every mutant did.
#
# Transport (same as backlog-3477 / 3547): psql runs ON the venue, inside its
# container, and SQL is piped to it over SSH. Every file is concatenated on
# the client into one stream, so `\i` is never used.
#
#   SSH_HOST=<ssh alias>  PG_CONTAINER=<container name>  bash run.sh gate
#
# Neither value has a default; neither is written to any file here.
#
# Every control runs in ONE transaction that ends with ROLLBACK. `gate` is
# backlog-3477's gate (schema-only venue, no checklist tables); run it again
# after a run to prove nothing leaked.
#
# Prelude:
#   3477 prelude (catalogue -> 3473 file 2 -> 3473 fixtures -> 3473 file 1
#   -> 3535 -> 3474 x2 -> 3476 -> 3477) -> 3477 fixtures -> 3547
#   -> lib/fixtures-3596.sql (helpers only)
#   -> [rollback controls: catalogue snapshot t3596_s0]
#   -> 3596 (or its mutant)
#   -> [rollback-refusals controls: snapshot t3596_r0]
#   -> the refusals file (or its mutant)
#   -> [apply-twice controls: snapshot t3596_s1, 3596 and the refusals file again]
#   -> [rollback controls: snapshot t3596_s2, rollback-refusals.sql, rollback.sql]
#   -> [rollback-refusals controls: rollback-refusals.sql (or its mutant)]
#   -> control
#
#   bash run.sh gate | controls [name-fragment] | mutants [name-fragment]
#   MATRIX=1 bash run.sh mutants [name-fragment]   every control, not just targets
#
# Mutants are defined in lib/mutants.py and generated here by EXACT-STRING
# replacement on the shipped file (or on rollback.sql). A replacement that
# does not match exactly once aborts the run (MUTATION NOT APPLIED); each
# applied mutant prints MUTATION APPLIED and its first changed line.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIGDIR="$REPO/supabase/migrations"
T3477="$REPO/supabase/tests/backlog-3477"
LIB3473="$REPO/supabase/tests/backlog-3473/lib"
MIG3473_1="$MIGDIR/20260921101756_backlog_3473_feature_reads_honour_min_tier.sql"
MIG3473_2="$MIGDIR/20260921101757_backlog_3473_transaction_checklists.sql"
MIG3535="$MIGDIR/20260924183422_backlog_3535_checklists_min_tier_individual.sql"
MIG3474_1="$MIGDIR/20260924190429_backlog_3474_save_checklist_template.sql"
MIG3474_2="$MIGDIR/20260924224113_backlog_3474_template_audit_fields.sql"
MIG3476="$MIGDIR/20260924234221_backlog_3476_several_checklists_per_submission.sql"
MIG3477="$MIGDIR/20260925073000_backlog_3477_submission_checklist_review.sql"
MIG3547="$MIGDIR/20260927120000_backlog_3547_submission_insert_pre_review.sql"
MIGRATION="$MIGDIR/20260928120000_backlog_3596_broker_checklist_ticks.sql"
ROLLBACK="$HERE/rollback.sql"
# The follow-up file (two refusals), applied after MIGRATION, and its rollback
# (run before ROLLBACK).
REFUSALS="$MIGDIR/20260928130000_backlog_3596_review_refusals.sql"
REFUSALS_RB="$HERE/rollback-refusals.sql"
SSH_HOST="${SSH_HOST:?set SSH_HOST to the ssh alias of the test venue -- see the header}"
CONTAINER="${PG_CONTAINER:?set PG_CONTAINER to the postgres container name on that venue -- see the header}"

for f in "$MIG3473_1" "$MIG3473_2" "$MIG3535" "$MIG3474_1" "$MIG3474_2" "$MIG3476" "$MIG3477" "$MIG3547" \
         "$MIGRATION" "$ROLLBACK" "$REFUSALS" "$REFUSALS_RB" "$LIB3473/fixtures.sql" "$LIB3473/venue-catalogue.sql" \
         "$LIB3473/venue-catalogue-verify.sql" "$T3477/lib/fixtures-3477.sql" "$HERE/lib/fixtures-3596.sql"; do
  [ -f "$f" ] || { echo "missing: $f" >&2; exit 2; }
done

# No ControlMaster: on the recording machine the multiplexed master could not
# get a signature from the ssh agent, while plain connections could.
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20)
psql_in() { ssh "${SSH_OPTS[@]}" "$SSH_HOST" \
  "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -tA -f -"; }

catalogue() {
  awk -v verify="$LIB3473/venue-catalogue-verify.sql" '
    $0 == "BEGIN;" || $0 == "COMMIT;" { next }
    $0 == "\\ir venue-catalogue-verify.sql" { while ((getline l < verify) > 0) print l; close(verify); next }
    { print }' "$LIB3473/venue-catalogue.sql"
}

# run_control <control> [migration] [rollback] [refusals] [refusals rollback]
run_control() {
  local control="$1" mig="${2:-$MIGRATION}" rb="${3:-$ROLLBACK}" mig2="${4:-$REFUSALS}" rb2="${5:-$REFUSALS_RB}" out rc
  set +e
  out=$( { echo "BEGIN;"
           catalogue
           cat "$MIG3473_2"
           cat "$LIB3473/fixtures.sql"
           cat "$MIG3473_1" "$MIG3535" "$MIG3474_1" "$MIG3474_2" "$MIG3476" "$MIG3477"
           cat "$T3477/lib/fixtures-3477.sql"
           cat "$MIG3547"
           cat "$HERE/lib/fixtures-3596.sql"
           if grep -q '^-- harness: rollback$' "$control"; then
             echo "CREATE TEMP TABLE t3596_s0 AS SELECT * FROM pg_temp.snap3596();"
           fi
           cat "$mig"
           if grep -q '^-- harness: rollback-refusals' "$control"; then
             echo "CREATE TEMP TABLE t3596_r0 AS SELECT * FROM pg_temp.snap3596();"
           fi
           cat "$mig2"
           if grep -q '^-- harness: apply-twice' "$control"; then
             echo "CREATE TEMP TABLE t3596_s1 AS SELECT * FROM pg_temp.snap3596();"
             cat "$mig" "$mig2"
           fi
           if grep -q '^-- harness: rollback$' "$control"; then
             echo "CREATE TEMP TABLE t3596_s2 AS SELECT * FROM pg_temp.snap3596();"
             cat "$rb2" "$rb"
           fi
           if grep -q '^-- harness: rollback-refusals' "$control"; then
             echo "CREATE TEMP TABLE t3596_r1 AS SELECT * FROM pg_temp.snap3596();"
             cat "$rb2"
           fi
           cat "$control"
           echo "SELECT 'ASSERTIONS=' || current_setting('t3473.asserts');"
           echo "ROLLBACK;"
         } | psql_in 2>&1 )
  rc=$?
  set -e
  CONTROL_OUT="$out"
  local asserts
  asserts=$(grep -o 'ASSERTIONS=[0-9]*' <<<"$out" | tail -1 | cut -d= -f2 || true)
  if [ $rc -eq 0 ] && [ -n "$asserts" ] && [ "$asserts" -gt 0 ]; then
    CONTROL_RESULT="GREEN"; CONTROL_DETAIL="$asserts assertions"
  elif [ $rc -eq 0 ]; then
    CONTROL_RESULT="VOID"; CONTROL_DETAIL="exit 0 but no assertion ran"
  else
    CONTROL_RESULT="RED"
    CONTROL_DETAIL="$(grep -m1 -E 'ERROR|FATAL' <<<"$out" | sed -E 's/^.*(ERROR|FATAL):[[:space:]]*//' | cut -c1-160 || true)"
    [ -n "$CONTROL_DETAIL" ] || CONTROL_DETAIL="exit $rc, no ERROR line: $(tail -1 <<<"$out" | cut -c1-140)"
  fi
  # Recorded output is committed to a PUBLIC repo: no record id in it, even an
  # invented one or one a control generated.
  CONTROL_DETAIL="$(sed -E 's/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/<id>/g' <<<"$CONTROL_DETAIL")"
}

case "${1:-}" in
  # gate: backlog-3477's gate checks, over this script's transport. Refuses
  # unless the venue is schema-only (no users, no catalogue rows) and has no
  # checklist table or 3477 function -- which production can never satisfy.
  gate)
    out=$(printf "%s\n" \
      "select 'db=' || current_database() || ' user=' || current_user || ' server=' || current_setting('server_version');" \
      "select 'users_rows=' || count(*) from public.users;" \
      "select 'catalogue_rows=' || ((select count(*) from public.feature_definitions) + (select count(*) from public.plans));" \
      "select 'target_tables_absent=' || (to_regclass('public.submission_checklists') is null);" \
      "select 'target_functions_absent=' || (not exists (select 1 from pg_proc where proname in ('can_review_submission','snapshot_submission_checklists','set_submission_checklist_reviewer_check','add_submission_checklist_at_review','guard_status_history_append_only','carry_submission_checklist_reviews')));" \
      | psql_in)
    echo "$out"
    for want in '^users_rows=0$' '^catalogue_rows=0$' '^target_tables_absent=true$' '^target_functions_absent=true$' 'user=postgres'; do
      grep -q "$want" <<<"$out" || { echo "GATE FAIL: $want not met -- refusing." >&2; exit 1; }
    done
    echo "gate: OK" ;;

  controls)
    only="${2:-}"; fail=0; n=0
    for c in "$HERE"/controls/*.sql; do
      [ -n "$only" ] && [[ "$(basename "$c")" != *"$only"* ]] && continue
      run_control "$c"; n=$((n+1))
      printf '%-44s %-5s %s\n' "$(basename "$c" .sql)" "$CONTROL_RESULT" "$CONTROL_DETAIL"
      [ "$CONTROL_RESULT" = "GREEN" ] || { fail=$((fail+1)); [ -n "${VERBOSE:-}" ] && echo "$CONTROL_OUT"; }
    done
    echo "controls: $((n-fail)) green / $n"
    [ $n -gt 0 ] || { echo "controls: 0 controls found -- a failure" >&2; exit 1; }
    [ $fail -eq 0 ] || exit 1 ;;

  mutants)
    only="${2:-}"; total=0; missed=0
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    python3 "$HERE/lib/mutants.py" "$MIGRATION" "$ROLLBACK" "$REFUSALS" "$REFUSALS_RB" "$tmp"
    for m in "$tmp"/m*.sql; do
      name="$(basename "$m" .sql)"
      [ -n "$only" ] && [[ "$name" != *"$only"* ]] && continue
      total=$((total+1))
      targets="$(cat "$tmp/$name.targets")"
      kind="$(cat "$tmp/$name.file")"
      mig="$MIGRATION"; rb="$ROLLBACK"; mig2="$REFUSALS"; rb2="$REFUSALS_RB"
      case "$kind" in
        migration)         base="$MIGRATION";   mig="$m" ;;
        rollback)          base="$ROLLBACK";    rb="$m" ;;
        refusals)          base="$REFUSALS";    mig2="$m" ;;
        refusals-rollback) base="$REFUSALS_RB"; rb2="$m" ;;
        *) echo "$name: unknown kind '$kind'" >&2; exit 1 ;;
      esac
      changed="$(diff "$base" "$m" | grep -c '^[<>]' || true)"
      [ "$changed" -gt 0 ] || { echo "$name: MUTATION NOT APPLIED (identical to the shipped file)" >&2; exit 1; }
      first="$(diff "$base" "$m" | grep -m1 '^>' | sed 's/^> *//' | cut -c1-110 || true)"
      [ -n "$first" ] || first="removed: $(diff "$base" "$m" | grep -m1 '^<' | sed 's/^< *//' | cut -c1-100 || true)"
      if [ -n "${MATRIX:-}" ]; then run=( "$HERE"/controls/*.sql ); else
        run=(); for t in $targets; do for c in "$HERE"/controls/"$t"-*.sql; do run+=( "$c" ); done; done
      fi
      [ ${#run[@]} -gt 0 ] || { echo "$name: no control matches '$targets'" >&2; exit 1; }
      reds=(); greens=(); details=()
      for c in "${run[@]}"; do
        run_control "$c" "$mig" "$rb" "$mig2" "$rb2"
        cn="$(basename "$c" .sql | cut -d- -f1)"
        case "$CONTROL_RESULT" in
          RED)  reds+=("$cn"); details+=("      $cn: $CONTROL_DETAIL") ;;
          VOID) echo "$name x $cn: VOID -- $CONTROL_DETAIL" >&2; exit 1 ;;
          *)    greens+=("$cn") ;;
        esac
      done
      verdict="as expected"
      for t in $targets; do
        hit=""; for r in "${reds[@]:-}"; do [ "$r" = "$t" ] && hit=1; done
        [ -n "$hit" ] || { verdict="MISSED: $t stayed green"; missed=$((missed+1)); }
      done
      printf '%s  [%s]  (%s)\n    MUTATION APPLIED: %s line(s) differ; first: %s\n    RED:   %s\n    green: %s\n' \
        "$name" "$verdict" "$kind" "$changed" "$first" "${reds[*]:-none}" "${greens[*]:-none}"
      [ ${#details[@]} -gt 0 ] && printf '%s\n' "${details[@]}"
    done
    echo "mutants: $total run, $missed not as expected"
    [ $total -gt 0 ] || { echo "mutants: 0 mutants run -- a failure" >&2; exit 1; }
    [ $missed -eq 0 ] || exit 1 ;;

  *) sed -n '2,39p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
