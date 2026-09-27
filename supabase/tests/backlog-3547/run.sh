#!/usr/bin/env bash
# BACKLOG-3547 harness. Runs the SHIPPED migration
#   supabase/migrations/20260927120000_backlog_3547_submission_insert_pre_review.sql
# on a real Postgres, on top of the BACKLOG-3477 prelude (which is itself the
# checklist migrations production holds), and records what every control and
# every mutant did.
#
# Transport (same as backlog-3477 / backlog-3503): psql runs ON the venue,
# inside its container, and SQL is piped to it over SSH. Every file is
# concatenated on the client into one stream, so `\i` is never used.
#
#   SSH_HOST=<ssh alias>  PG_CONTAINER=<container name>  bash run.sh gate
#
# Neither value has a default; both are recorded on the backlog item.
#
# Every control runs in ONE transaction that ends with ROLLBACK. `gate` is
# backlog-3477's gate (schema-only venue, no checklist tables); run it again
# after a run to prove nothing leaked.
#
# Prelude:
#   3477 prelude (catalogue -> 3473 file 2 -> 3473 fixtures -> 3473 file 1
#   -> 3535 -> 3474 x2 -> 3476 -> 3477) -> 3477 fixtures
#   -> lib/widen-commission.sql -> 3547 (or its mutant) -> control
#
#   bash run.sh gate | baseline | controls [name-fragment] | mutants [name-fragment]
#
# Mutants are generated here by EXACT-STRING replacement on the shipped file.
# A replacement that matches nothing aborts the run (MUTATION NOT APPLIED);
# each applied mutant prints MUTATION APPLIED and its mutated line.
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
MIGRATION="$MIGDIR/20260927120000_backlog_3547_submission_insert_pre_review.sql"
SSH_HOST="${SSH_HOST:?set SSH_HOST to the ssh alias of the test venue -- see the header}"
CONTAINER="${PG_CONTAINER:?set PG_CONTAINER to the postgres container name on that venue -- see the header}"

for f in "$MIG3473_1" "$MIG3473_2" "$MIG3535" "$MIG3474_1" "$MIG3474_2" "$MIG3476" "$MIG3477" "$MIGRATION" \
         "$LIB3473/fixtures.sql" "$LIB3473/venue-catalogue.sql" "$LIB3473/venue-catalogue-verify.sql" \
         "$T3477/lib/fixtures-3477.sql" "$HERE/lib/widen-commission.sql"; do
  [ -f "$f" ] || { echo "missing: $f" >&2; exit 2; }
done

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20 -o ControlMaster=auto -o ControlPath=/tmp/.ssh-3547-%r@%h:%p -o ControlPersist=300)
psql_in() { ssh "${SSH_OPTS[@]}" "$SSH_HOST" \
  "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -tA -f -"; }

catalogue() {
  awk -v verify="$LIB3473/venue-catalogue-verify.sql" '
    $0 == "BEGIN;" || $0 == "COMMIT;" { next }
    $0 == "\\ir venue-catalogue-verify.sql" { while ((getline l < verify) > 0) print l; close(verify); next }
    { print }' "$LIB3473/venue-catalogue.sql"
}

# run_control <control> [mutated migration]
run_control() {
  local control="$1" mig="${2:-$MIGRATION}" out rc
  set +e
  out=$( { echo "BEGIN;"
           catalogue
           cat "$MIG3473_2"
           cat "$LIB3473/fixtures.sql"
           cat "$MIG3473_1" "$MIG3535" "$MIG3474_1" "$MIG3474_2" "$MIG3476" "$MIG3477"
           cat "$T3477/lib/fixtures-3477.sql"
           cat "$HERE/lib/widen-commission.sql"
           cat "$mig"
           if grep -q '^-- harness: apply-twice' "$control"; then
             echo "CREATE TEMP TABLE t3547_s1 AS SELECT policyname, cmd, roles::text AS roles, coalesce(qual,'') AS qual, coalesce(with_check,'') AS wc FROM pg_policies WHERE schemaname = 'public' AND tablename = 'transaction_submissions';"
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

# Mutants live in lib/mutants.txt, one record per mutant:
#   name <TAB> controls expected to red <TAB> exact old text <TAB> new text
# A record starts on a line beginning "m<digits>-"; its old/new text may span
# lines.
MUTANTS_FILE="$HERE/lib/mutants.txt"

case "${1:-}" in
  gate) SSH_HOST="$SSH_HOST" PG_CONTAINER="$CONTAINER" bash "$T3477/run.sh" gate ;;

  # baseline: every control against the policy as it stands WITHOUT this
  # migration (the 3477 prelude's policy). Shows which controls see the defect.
  baseline)
    empty="$(mktemp)"; trap 'rm -f "$empty"' EXIT
    echo "-- baseline: 3547 migration not applied" > "$empty"
    for c in "$HERE"/controls/*.sql; do
      run_control "$c" "$empty"
      printf '%-46s %-5s %s\n' "$(basename "$c" .sql)" "$CONTROL_RESULT" "$CONTROL_DETAIL"
    done ;;

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
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    python3 - "$MIGRATION" "$tmp" "$MUTANTS_FILE" <<'PY'
import re, sys, pathlib
src = pathlib.Path(sys.argv[1]).read_text()
out = pathlib.Path(sys.argv[2])
recs = re.split(r'\n(?=m\d+-)', pathlib.Path(sys.argv[3]).read_text().strip("\n"))
for r in recs:
    name, targets, old, new = r.split("\t", 3)
    if src.count(old) != 1:
        sys.exit(f"{name}: MUTATION NOT APPLIED (old text matched {src.count(old)} times)")
    (out / f"{name}.sql").write_text(src.replace(old, new, 1))
    (out / f"{name}.targets").write_text(targets)
PY
    for m in "$tmp"/m*.sql; do
      name="$(basename "$m" .sql)"
      [ -n "$only" ] && [[ "$name" != *"$only"* ]] && continue
      total=$((total+1))
      targets="$(cat "$tmp/$name.targets")"
      changed="$(diff "$MIGRATION" "$m" | grep -c '^[<>]' || true)"
      [ "$changed" -gt 0 ] || { echo "$name: MUTATION NOT APPLIED (identical to the shipped file)" >&2; exit 1; }
      first="$(diff "$MIGRATION" "$m" | grep -m1 '^>' | sed 's/^> *//' | cut -c1-110 || true)"
      [ -n "$first" ] || first="removed: $(diff "$MIGRATION" "$m" | grep -m1 '^<' | sed 's/^< *//' | cut -c1-100 || true)"
      reds=(); greens=(); details=()
      for c in "$HERE"/controls/*.sql; do
        run_control "$c" "$m"
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
      printf '%s  [%s]\n    MUTATION APPLIED: %s line(s) differ; first: %s\n    RED:   %s\n    green: %s\n' \
        "$name" "$verdict" "$changed" "$first" "${reds[*]:-none}" "${greens[*]:-none}"
      [ ${#details[@]} -gt 0 ] && printf '%s\n' "${details[@]}"
    done
    echo "mutants: $total run, $missed not as expected"
    [ $total -gt 0 ] || { echo "mutants: 0 mutants run -- a failure" >&2; exit 1; }
    [ $missed -eq 0 ] || exit 1 ;;

  *) sed -n '2,29p' "${BASH_SOURCE[0]}"; exit 2 ;;
esac
