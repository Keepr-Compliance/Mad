#!/usr/bin/env bash
# BACKLOG-3477 harness. Runs the SHIPPED migration
#   supabase/migrations/20260925073000_backlog_3477_submission_checklist_review.sql
# on a real Postgres, on top of the checklist migrations production already
# holds, and records what every control and every mutant did.
#
# Transport (same as backlog-3503): psql runs ON the venue, inside its
# container, and SQL is piped to it over SSH. Every file is concatenated on
# the client into one stream, so `\i` is never used.
#
#   SSH_HOST=<ssh alias>  PG_CONTAINER=<container name>  bash run.sh gate
#
# Neither value has a default; both are recorded on the backlog item.
#
# Every control runs in ONE transaction that this script opens and ends with
# ROLLBACK. The venue is schema-only (no rows); production's plan / feature
# catalogue is loaded INSIDE that transaction too (3473's venue-catalogue.sql
# with its own BEGIN/COMMIT removed), so nothing is ever committed. `gate`
# refuses unless public.users is empty and no checklist table exists, which
# production can never satisfy; run it again after a run to prove nothing
# leaked.
#
# Prelude, in the order production applied the files:
#   catalogue -> 3473 file 2 -> 3473 fixtures -> 3473 file 1 -> 3535 min-tier
#   -> 3474 save -> 3474 audit fields -> 3476 -> 3477 (or its mutant)
#   -> fixtures-3477 -> control
# 3473 file 3 is not in production's history and is not loaded.
#
#   bash run.sh gate | controls [name-fragment] | mutants [name-fragment]
#   MATRIX=1 bash run.sh mutants     every mutant against every control
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIGDIR="$REPO/supabase/migrations"
LIB3473="$REPO/supabase/tests/backlog-3473/lib"
MIG3473_1="$MIGDIR/20260921101756_backlog_3473_feature_reads_honour_min_tier.sql"
MIG3473_2="$MIGDIR/20260921101757_backlog_3473_transaction_checklists.sql"
MIG3535="$MIGDIR/20260924183422_backlog_3535_checklists_min_tier_individual.sql"
MIG3474_1="$MIGDIR/20260924190429_backlog_3474_save_checklist_template.sql"
MIG3474_2="$MIGDIR/20260924224113_backlog_3474_template_audit_fields.sql"
MIG3476="$MIGDIR/20260924234221_backlog_3476_several_checklists_per_submission.sql"
MIGRATION="$MIGDIR/20260925073000_backlog_3477_submission_checklist_review.sql"
# No apostrophe in either message: inside ${VAR:?word} bash pairs it with the
# next one (backlog-3503/run.sh records the measurement).
SSH_HOST="${SSH_HOST:?set SSH_HOST to the ssh alias of the test venue -- see the header}"
CONTAINER="${PG_CONTAINER:?set PG_CONTAINER to the postgres container name on that venue -- see the header}"

for f in "$MIG3473_1" "$MIG3473_2" "$MIG3535" "$MIG3474_1" "$MIG3474_2" "$MIG3476" "$MIGRATION" \
         "$LIB3473/fixtures.sql" "$LIB3473/venue-catalogue.sql" "$LIB3473/venue-catalogue-verify.sql"; do
  [ -f "$f" ] || { echo "missing: $f" >&2; exit 2; }
done

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20 -o ControlMaster=auto -o ControlPath=/tmp/.ssh-3477-%r@%h:%p -o ControlPersist=300)
psql_in() { ssh "${SSH_OPTS[@]}" "$SSH_HOST" \
  "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -tA -f -"; }

# The catalogue file commits on its own and pulls its verifier with \ir. Inline
# the verifier and drop exactly its two transaction lines, so the catalogue
# lands inside the control's transaction and is rolled back with it.
catalogue() {
  awk -v verify="$LIB3473/venue-catalogue-verify.sql" '
    $0 == "BEGIN;" || $0 == "COMMIT;" { next }
    $0 == "\\ir venue-catalogue-verify.sql" { while ((getline l < verify) > 0) print l; close(verify); next }
    { print }' "$LIB3473/venue-catalogue.sql"
}

gate() {
  local out
  out=$(printf "%s\n" \
    "select 'db=' || current_database() || ' user=' || current_user || ' server=' || current_setting('server_version');" \
    "select 'users_rows=' || count(*) from public.users;" \
    "select 'catalogue_rows=' || ((select count(*) from public.feature_definitions) + (select count(*) from public.plans));" \
    "select 'target_tables_absent=' || (to_regclass('public.submission_checklists') is null);" \
    "select 'target_functions_absent=' || (not exists (select 1 from pg_proc where proname in ('can_review_submission','snapshot_submission_checklists','set_submission_checklist_reviewer_check','add_submission_checklist_at_review','guard_status_history_append_only')));" \
    | psql_in)
  echo "$out"
  grep -q '^users_rows=0$' <<<"$out" || { echo "GATE FAIL: public.users is not empty -- refusing." >&2; exit 1; }
  grep -q '^catalogue_rows=0$' <<<"$out" || { echo "GATE FAIL: the catalogue is not empty (this harness loads its own)." >&2; exit 1; }
  grep -q '^target_tables_absent=true$' <<<"$out" || { echo "GATE FAIL: the checklist tables already exist." >&2; exit 1; }
  grep -q '^target_functions_absent=true$' <<<"$out" || { echo "GATE FAIL: a 3477 function already exists." >&2; exit 1; }
  grep -q 'user=postgres' <<<"$out" || { echo "GATE FAIL: not connected as postgres." >&2; exit 1; }
  echo "gate: OK"
}

# run_control <control> [mutated migration]
run_control() {
  local control="$1" mig="${2:-$MIGRATION}" out rc
  set +e
  out=$( { echo "BEGIN;"
           catalogue
           cat "$MIG3473_2"
           cat "$LIB3473/fixtures.sql"
           cat "$MIG3473_1" "$MIG3535" "$MIG3474_1" "$MIG3474_2" "$MIG3476"
           cat "$mig"
           cat "$HERE/lib/fixtures-3477.sql"
           if grep -q '^-- harness: apply-twice' "$control"; then
             echo "CREATE TEMP TABLE t3477_s1 AS SELECT * FROM pg_temp.snap3477();"
             cat "$mig"
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
    CONTROL_DETAIL="$(grep -m1 -E 'ERROR|FATAL' <<<"$out" | sed -E 's/^.*(ERROR|FATAL):[[:space:]]*//' | cut -c1-160)"
  fi
}

case "${1:-}" in
  gate) gate ;;

  controls)
    only="${2:-}"; fail=0; n=0
    for c in "$HERE"/controls/*.sql; do
      [ -n "$only" ] && [[ "$(basename "$c")" != *"$only"* ]] && continue
      run_control "$c"; n=$((n+1))
      printf '%-46s %-5s %s\n' "$(basename "$c" .sql)" "$CONTROL_RESULT" "$CONTROL_DETAIL"
      [ "$CONTROL_RESULT" = "GREEN" ] || { fail=$((fail+1)); [ -n "${VERBOSE:-}" ] && echo "$CONTROL_OUT"; }
    done
    echo "controls: $((n-fail)) green / $n"
    [ $n -gt 0 ] || { echo "controls: 0 controls found -- a failure" >&2; exit 1; }
    [ $fail -eq 0 ] || exit 1 ;;

  mutants)
    only="${2:-}"; total=0; missed=0
    shopt -s nullglob
    for m in "$HERE"/mutants/m*.sql; do
      [ -n "$only" ] && [[ "$(basename "$m")" != *"$only"* ]] && continue
      total=$((total+1))
      targets="$(grep -m1 '^-- targets:' "$m" | sed 's/^-- targets://' || true)"
      [ -n "$targets" ] || { echo "$(basename "$m"): no targets line" >&2; exit 1; }
      # Proof the mutation applied: the mutant differs from the shipped file.
      changed="$(diff <(grep -v '^-- ' "$MIGRATION") <(grep -v '^-- ' "$m") | grep -c '^[<>]' || true)"
      [ "$changed" -gt 0 ] || { echo "$(basename "$m"): MUTATION NOT APPLIED (identical to the shipped file)" >&2; exit 1; }
      first="$(diff <(grep -v '^-- ' "$MIGRATION") <(grep -v '^-- ' "$m") | grep -m1 '^>' | sed 's/^> *//' | cut -c1-110 || true)"
      [ -n "$first" ] || first="$(diff <(grep -v '^-- ' "$MIGRATION") <(grep -v '^-- ' "$m") | grep -m1 '^<' | sed 's/^< */removed: /' | cut -c1-110)"
      if [ -n "${MATRIX:-}" ]; then run=( "$HERE"/controls/*.sql ); else
        run=(); for t in $targets; do for c in "$HERE"/controls/"$t"-*.sql; do run+=( "$c" ); done; done
      fi
      [ ${#run[@]} -gt 0 ] || { echo "$(basename "$m"): no control matches '$targets'" >&2; exit 1; }
      reds=(); greens=(); details=()
      for c in "${run[@]}"; do
        run_control "$c" "$m"
        name="$(basename "$c" .sql | cut -d- -f1)"
        case "$CONTROL_RESULT" in
          RED)  reds+=("$name"); details+=("      $name: $CONTROL_DETAIL") ;;
          VOID) echo "$(basename "$m") x $name: VOID -- $CONTROL_DETAIL" >&2; exit 1 ;;
          *)    greens+=("$name") ;;
        esac
      done
      verdict="as expected"
      for t in $targets; do
        hit=""; for r in "${reds[@]:-}"; do [ "$r" = "$t" ] && hit=1; done
        [ -n "$hit" ] || { verdict="MISSED: $t stayed green"; missed=$((missed+1)); }
      done
      printf '%s  [%s]\n    MUTATION APPLIED: %s line(s) differ; first: %s\n    RED:   %s\n    green: %s\n' \
        "$(basename "$m" .sql)" "$verdict" "$changed" "$first" "${reds[*]:-none}" "${greens[*]:-none}"
      [ ${#details[@]} -gt 0 ] && printf '%s\n' "${details[@]}"
    done
    echo "mutants: $total run, $missed not as expected"
    [ $total -gt 0 ] || { echo "mutants: 0 mutants run -- a failure" >&2; exit 1; }
    [ $missed -eq 0 ] || exit 1 ;;

  *) sed -n '2,31p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
