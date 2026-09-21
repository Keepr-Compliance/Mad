#!/usr/bin/env bash
# BACKLOG-3473 harness: prove the three checklist migrations on a real
# Postgres + PostgREST stack.
#
#   supabase/tests/backlog-3473/run.sh '<postgres url>' <command> [arg]
#
# The URL is always explicit -- never --linked, never read from the environment
# -- and must point at loopback or a Tailscale address (100.64.0.0/10). Anything
# else is refused, so this can never be aimed at production. It must connect as
# the venue's `postgres` role; the gate checks that.
#
# Scope of the min-tier rule the controls expect: T3473_SCOPE=all (default) or
# T3473_SCOPE=narrow. Declared, never detected from the migration, so a wrong
# scope in the migration turns controls red instead of changing what they expect.
#
# Commands, in the order the README runs them:
#   gate          venue gate: role, server >= 14, catalog fingerprint vs production.
#                 The three read functions must match production exactly (never
#                 accepted), because teardown restores them from lib/rpc-before.sql.
#   apply-prod    C21 (K3 order), ONE transaction, rolled back:
#                 files 1->2->3, toggle team x transaction_checklists, S1,
#                 files 1->2->3 again, S2, S1 = S2 both ways
#   apply-prod-mutants   every mutants/a*.sql (a whole-file replacement) through
#                 apply-prod; each must go RED
#   controls      every controls/*.sql in its own rolled-back transaction
#   mutants       every mutants/m*.sql and f*.sql against the controls named on its
#                 `-- targets:` line (MATRIX=1: against every control)
#   apply         COMMITTED apply of files 1 and 2 (never 3) for the PostgREST probe,
#                 each in one transaction, then NOTIFY pgrst
#   probe-seed    postgrest/seed.sql (committed)
#   probe         node postgrest/probe.mjs (needs SUPABASE_URL, SUPABASE_JWT_SECRET)
#   probe-mutant  C22 mutant: REVOKE SELECT on checklist_templates from authenticated
#                 (committed), probe must go RED, GRANT restored
#   probe-cleanup postgrest/cleanup.sql
#   teardown      lib/teardown.sql: restore the three read functions verbatim,
#                 drop everything files 1 and 2 add, re-hash, remove history rows
#   (then `gate` again: it must re-match)
#
# On a SCHEMA-ONLY venue (the NAS stack holds no rows), bracket the whole run:
#   catalogue-seed      FIRST: lib/venue-catalogue.sql commits production's plan /
#                       feature catalogue (refuses unless the 4 tables are empty;
#                       re-hashes against production)
#   catalogue-teardown  LAST, after the re-gate: removes exactly that set again
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG1="$REPO/supabase/migrations/20260921101756_backlog_3473_feature_reads_honour_min_tier.sql"
MIG2="$REPO/supabase/migrations/20260921101757_backlog_3473_transaction_checklists.sql"
MIG3="$REPO/supabase/migrations/20260921101758_backlog_3473_retire_unused_org_columns.sql"
STAMP1="20260921101756"
STAMP2="20260921101757"
PSQL="${PSQL:-$(command -v psql || echo /opt/homebrew/opt/libpq/bin/psql)}"
SCOPE="${T3473_SCOPE:-all}"
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-15}"

URL="${1:-}"; CMD="${2:-}"; ARG="${3:-}"
if [ -z "$URL" ] || [ -z "$CMD" ]; then
  sed -n '2,43p' "${BASH_SOURCE[0]}"; exit 2
fi
if [ "$SCOPE" != "all" ] && [ "$SCOPE" != "narrow" ]; then
  echo "T3473_SCOPE must be 'all' or 'narrow', got '$SCOPE'" >&2; exit 2
fi

host="$(sed -E 's#^[a-z]+://([^@/]*@)?(\[[^]]+\]|[^:/?]+).*#\2#' <<<"$URL")"
if ! [[ "$host" =~ ^(127\.0\.0\.1|localhost|::1|\[::1\])$ ]] \
   && ! [[ "$host" =~ ^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
  echo "REFUSING: host '$host' is neither loopback nor a Tailscale address." >&2
  exit 2
fi

q() { "$PSQL" "$URL" -v ON_ERROR_STOP=1 -X -q "$@"; }

# run_control <control> [mutant] [file-3 path]
# Sets CONTROL_RESULT (GREEN | RED | VOID), CONTROL_DETAIL, CONTROL_OUT.
run_control() {
  local control="$1" mutant="${2:-}" mig3="${3:-$MIG3}" out rc skip3=""
  grep -q '^-- harness: without-file3' "$control" && skip3=1
  set +e
  out=$(
    {
      echo "BEGIN;"
      echo "\\i $MIG2"
      echo "\\i $HERE/lib/fixtures.sql"
      echo "CREATE TEMP TABLE t3473_rpc_before AS SELECT * FROM pg_temp.rpc_snapshot();"
      echo "\\i $MIG1"
      [ -z "$skip3" ] && echo "\\i $mig3"
      [ -n "$mutant" ] && echo "\\i $mutant"
      [ -n "$skip3" ] && echo "\\set mig3_sql \`cat '$mig3'\`"
      echo "\\i $control"
      echo "SELECT 'ASSERTIONS=' || current_setting('t3473.asserts');"
      echo "ROLLBACK;"
    } | "$PSQL" "$URL" -v ON_ERROR_STOP=1 -X -tA -v scope="$SCOPE" 2>&1
  )
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
    CONTROL_DETAIL="$(grep -m1 -E 'ERROR|FATAL' <<<"$out" | sed -E 's/^.*(ERROR|FATAL):[[:space:]]*//' | cut -c1-200)"
  fi
}

# apply_prod <file1> <file2> <file3>: prints S1/S2 diff counts; exit 0 only when equal.
apply_prod() {
  local f1="$1" f2="$2" f3="$3"
  {
    echo "BEGIN;"
    echo "\\i $HERE/lib/catalog-snapshot.sql"
    echo "\\i $f1"
    echo "\\i $f2"
    echo "\\i $f3"
    # K3: the admin toggle lands AFTER apply 1 and BEFORE S1.
    echo "DO \$toggle\$ DECLARE n integer; BEGIN"
    echo "  UPDATE public.plan_features SET enabled = true"
    echo "   WHERE plan_id = (SELECT id FROM public.plans WHERE slug = 'team')"
    echo "     AND feature_id = (SELECT id FROM public.feature_definitions WHERE key = 'transaction_checklists');"
    echo "  GET DIAGNOSTICS n = ROW_COUNT;"
    echo "  IF n <> 1 THEN RAISE EXCEPTION 'apply-prod: the toggle updated % row(s), expected 1', n; END IF;"
    echo "END \$toggle\$;"
    echo "CREATE TEMP TABLE t3473_s1 AS SELECT * FROM pg_temp.catalog_snapshot();"
    echo "\\i $f1"
    echo "\\i $f2"
    echo "\\i $f3"
    echo "CREATE TEMP TABLE t3473_s2 AS SELECT * FROM pg_temp.catalog_snapshot();"
    echo "SELECT 'S1_ROWS=' || (SELECT count(*) FROM t3473_s1)"
    echo "    || ' ONLY_IN_S1=' || (SELECT count(*) FROM (SELECT * FROM t3473_s1 EXCEPT SELECT * FROM t3473_s2) d)"
    echo "    || ' ONLY_IN_S2=' || (SELECT count(*) FROM (SELECT * FROM t3473_s2 EXCEPT SELECT * FROM t3473_s1) d);"
    echo "SELECT 'DIFF ' || side || ' ' || k || ' ' || v"
    echo "  FROM (SELECT 'S1' AS side, * FROM (SELECT * FROM t3473_s1 EXCEPT SELECT * FROM t3473_s2) a"
    echo "        UNION ALL SELECT 'S2', * FROM (SELECT * FROM t3473_s2 EXCEPT SELECT * FROM t3473_s1) b) d LIMIT 20;"
    echo "ROLLBACK;"
  } | "$PSQL" "$URL" -v ON_ERROR_STOP=1 -X -tA 2>&1
}

case "$CMD" in
  gate)
    echo "== venue gate (declared scope: $SCOPE) =="
    q -tA -c "select 'connected_as=' || current_user || ' rolsuper=' || (select rolsuper from pg_roles where rolname = current_user) || ' bypassrls=' || (select rolbypassrls from pg_roles where rolname = current_user) || ' server=' || current_setting('server_version')"
    who=$(q -tA -c "select current_user")
    [ "$who" = "postgres" ] || { echo "GATE FAIL: must connect as postgres, got $who" >&2; exit 1; }
    major=$(q -tA -c "select current_setting('server_version_num')::int / 10000")
    [ "$major" -ge 14 ] || { echo "GATE FAIL: server major $major < 14 (CREATE OR REPLACE TRIGGER needs 14)" >&2; exit 1; }
    actual="$(q -tA -f "$HERE/lib/gate-catalog.sql" | LC_ALL=C sort)"
    fail=0; accepted=0; matched=0
    while IFS='|' read -r key val; do
      [ -z "$key" ] && continue
      [[ "$key" == \#* ]] && continue
      # Exact key match. awk exits 0 when the key is absent, so a key missing on
      # the venue is reported as <missing> instead of killing the script under
      # `set -e -o pipefail` (a grep here did exactly that, silently).
      got="$(awk -v k="$key" 'index($0, k "|") == 1 { print substr($0, length(k) + 2); exit }' <<<"$actual")"
      if [ "$got" = "$val" ]; then
        matched=$((matched+1))
      elif [[ "$key" =~ ^fn:(check_feature_access|get_org_features|broker_get_org_features)$ ]]; then
        echo "MISMATCH  $key  venue=${got:-<missing>}  production=$val  -- never accepted: teardown restores production's body"
        fail=$((fail+1))
      elif grep -qF "$key|$got|" "$HERE/lib/gate-accepted.txt"; then
        reason="$(grep -F "$key|$got|" "$HERE/lib/gate-accepted.txt" | head -1 | cut -d'|' -f3-)"
        echo "ACCEPTED  $key  venue=$got  production=$val  -- $reason"
        accepted=$((accepted+1))
      else
        echo "MISMATCH  $key  venue=${got:-<missing>}  production=$val"
        fail=$((fail+1))
      fi
    done < "$HERE/lib/gate-expected.txt"
    echo "gate: matched=$matched accepted=$accepted mismatched=$fail"
    [ $fail -eq 0 ] || exit 1
    ;;

  apply-prod)
    out="$(apply_prod "$MIG1" "$MIG2" "$MIG3")" || { echo "$out" | grep -m3 -E 'ERROR|FATAL'; echo "apply-prod: RED (an apply failed)"; exit 1; }
    line="$(grep -m1 '^S1_ROWS=' <<<"$out")"
    echo "$line"
    if [[ "$line" =~ S1_ROWS=([0-9]+)\ ONLY_IN_S1=0\ ONLY_IN_S2=0 ]] && [ "${BASH_REMATCH[1]}" -gt 0 ]; then
      echo "apply-prod: GREEN (second apply of 1->2->3 is a no-op; the admin toggle survived)"
    else
      grep '^DIFF ' <<<"$out" || true
      echo "apply-prod: RED"; exit 1
    fi
    ;;

  apply-prod-mutants)
    fail=0
    for m in "$HERE"/mutants/a*.sql; do
      which="$(grep -m1 -o '^-- replaces-file: [123]' "$m" | awk '{print $3}')"
      f1="$MIG1"; f2="$MIG2"; f3="$MIG3"
      case "$which" in 1) orig="$MIG1"; f1="$m" ;; 2) orig="$MIG2"; f2="$m" ;; 3) orig="$MIG3"; f3="$m" ;;
        *) echo "$(basename "$m"): no replaces-file line" >&2; exit 1 ;; esac
      changed="$(diff <(grep -v '^-- ' "$orig") <(grep -v '^-- ' "$m") | grep -c '^[<>]' || true)"
      [ "$changed" -gt 0 ] || { echo "$(basename "$m"): MUTATION NOT APPLIED (identical to file $which)" >&2; exit 1; }
      echo "$(basename "$m")"
      echo "    MUTATION APPLIED: file $which, $changed line(s) differ: $(diff <(grep -v '^-- ' "$orig") <(grep -v '^-- ' "$m") | grep -m1 '^[<>]' | cut -c1-120)"
      set +e; out="$(apply_prod "$f1" "$f2" "$f3")"; rc=$?; set -e
      line="$(grep -m1 '^S1_ROWS=' <<<"$out" || true)"
      if [ $rc -ne 0 ] || ! [[ "$line" =~ ONLY_IN_S1=0\ ONLY_IN_S2=0 ]]; then
        echo "    RED: exit $rc; ${line:-no snapshot}; $(grep -m1 -E 'ERROR' <<<"$out" | cut -c1-160)"
      else
        echo "    GREEN -- the apply-twice control did NOT see this mutant"; fail=$((fail+1))
      fi
    done
    [ $fail -eq 0 ] || exit 1
    ;;

  controls)
    fail=0; n=0
    for c in "$HERE"/controls/*.sql; do
      run_control "$c"
      n=$((n+1))
      printf '%-52s %-5s %s\n' "$(basename "$c")" "$CONTROL_RESULT" "$CONTROL_DETAIL"
      [ "$CONTROL_RESULT" = "GREEN" ] || { fail=$((fail+1)); [ -n "${VERBOSE:-}" ] && echo "$CONTROL_OUT"; }
    done
    echo "controls: $((n-fail)) green / $n (scope=$SCOPE)"
    [ $n -gt 0 ] || { echo "controls: 0 controls found -- a failure" >&2; exit 1; }
    [ $fail -eq 0 ] || exit 1
    ;;

  mutants)
    shopt -s nullglob
    all_controls=( "$HERE"/controls/*.sql )
    missed=0; total=0
    for m in "$HERE"/mutants/m*.sql "$HERE"/mutants/f*.sql; do
      [ -n "$ARG" ] && [[ "$(basename "$m")" != $ARG* ]] && continue
      total=$((total+1))
      # Optional header lines: `|| true`, or a missing line exits the script
      # silently under `set -e -o pipefail` (measured: 0 mutants run, exit 1).
      targets="$(grep -m1 '^-- targets:' "$m" | sed 's/^-- targets://' || true)"
      if [ "$SCOPE" = "narrow" ] && grep -q '^-- targets-narrow:' "$m"; then
        targets="$(grep -m1 '^-- targets-narrow:' "$m" | sed 's/^-- targets-narrow://')"
      fi
      want="$(grep -m1 '^-- expect:' "$m" | awk '{print $3}' || true)"; want="${want:-red}"
      scopes="$(grep -m1 '^-- scopes:' "$m" | sed 's/^-- scopes://' || true)"
      if [ -n "$scopes" ] && ! grep -qw "$SCOPE" <<<"$scopes"; then
        echo "$(basename "$m"): skipped (applies to scope(s)$scopes; declared $SCOPE)"; continue
      fi
      mutant_sql="$m"; mig3="$MIG3"
      if grep -q '^-- replaces-file: 3' "$m"; then
        mutant_sql=""; mig3="$m"
        changed="$(diff <(grep -v '^-- ' "$MIG3") <(grep -v '^-- ' "$m") | grep -c '^[<>]' || true)"
        [ "$changed" -gt 0 ] || { echo "$(basename "$m"): MUTATION NOT APPLIED" >&2; exit 1; }
      fi
      if [ -n "${MATRIX:-}" ]; then run=( "${all_controls[@]}" ); else
        run=(); for t in $targets; do for c in "$HERE"/controls/"$t"-*.sql; do run+=( "$c" ); done; done
      fi
      [ ${#run[@]} -gt 0 ] || { echo "$(basename "$m"): no control matches targets '$targets'" >&2; exit 1; }
      reds=(); greens=(); details=(); applied=""
      for c in "${run[@]}"; do
        run_control "$c" "$mutant_sql" "$mig3"
        a=$(grep -m1 -o 'MUTATION APPLIED: .*' <<<"$CONTROL_OUT" || true)
        [ -z "$mutant_sql" ] && a="MUTATION APPLIED: file 3 replaced ($changed line(s) differ)"
        [ -n "$a" ] && applied="$a"
        if grep -q 'MUTATION NOT APPLIED' <<<"$CONTROL_OUT"; then
          echo "$(basename "$m"): MUTATION NOT APPLIED -- result void" >&2; exit 1
        fi
        name="$(basename "$c" .sql | cut -d- -f1)"
        if [ "$CONTROL_RESULT" = "RED" ]; then
          [ -n "$a" ] || { echo "$(basename "$m") x $(basename "$c"): RED WITHOUT PROOF -- $CONTROL_DETAIL" >&2; exit 1; }
          reds+=("$name"); details+=("      $name: $CONTROL_DETAIL")
        elif [ "$CONTROL_RESULT" = "VOID" ]; then
          echo "$(basename "$m") x $(basename "$c"): VOID -- $CONTROL_DETAIL" >&2; exit 1
        else
          greens+=("$name")
        fi
      done
      [ -n "$applied" ] || { echo "$(basename "$m"): no MUTATION APPLIED line" >&2; exit 1; }
      verdict="as expected"
      for t in $targets; do
        hit=""; for r in "${reds[@]:-}"; do [ "$r" = "$t" ] && hit=1; done
        if [ "$want" = "red" ] && [ -z "$hit" ]; then verdict="MISSED: $t stayed green"; missed=$((missed+1)); fi
        if [ "$want" = "green" ] && [ -n "$hit" ]; then verdict="UNEXPECTED RED: $t"; missed=$((missed+1)); fi
      done
      printf '%s  [want %s: %s]\n    %s\n    RED:   %s\n    green: %s\n' "$(basename "$m")" "$want" "$verdict" \
        "${applied:0:160}" "${reds[*]:-none}" "${greens[*]:-none}"
      [ ${#details[@]} -gt 0 ] && printf '%s\n' "${details[@]}"
    done
    echo "mutants: $total run, $missed not as expected (scope=$SCOPE)"
    [ $total -gt 0 ] || { echo "mutants: 0 mutants run -- a failure" >&2; exit 1; }
    [ $missed -eq 0 ] || exit 1
    ;;

  apply)
    q -1 -f "$MIG1"
    q -c "insert into supabase_migrations.schema_migrations (version, name) values ('$STAMP1', 'backlog_3473_feature_reads_honour_min_tier') on conflict do nothing"
    q -1 -f "$MIG2"
    q -c "insert into supabase_migrations.schema_migrations (version, name) values ('$STAMP2', 'backlog_3473_transaction_checklists') on conflict do nothing"
    q -c "NOTIFY pgrst, 'reload schema'"
    echo "apply: files 1 and 2 committed; file 3 NOT applied; PostgREST schema reload requested"
    ;;

  probe-seed)
    q -f "$HERE/postgrest/seed.sql"
    echo "probe-seed: done"
    ;;

  probe)
    node "$HERE/postgrest/probe.mjs"
    ;;

  probe-mutant)
    q -c "REVOKE SELECT ON public.checklist_templates FROM authenticated"
    q -c "NOTIFY pgrst, 'reload schema'"
    echo "MUTATION APPLIED: $(q -tA -c "select 'authenticated SELECT on checklist_templates = ' || has_table_privilege('authenticated', 'public.checklist_templates', 'SELECT')")"
    sleep 2
    set +e; node "$HERE/postgrest/probe.mjs" --expect-red; rc=$?; set -e
    q -c "GRANT SELECT ON public.checklist_templates TO authenticated"
    q -c "NOTIFY pgrst, 'reload schema'"
    echo "restored: $(q -tA -c "select 'authenticated SELECT on checklist_templates = ' || has_table_privilege('authenticated', 'public.checklist_templates', 'SELECT')")"
    [ $rc -eq 0 ] || { echo "probe-mutant: the probe did NOT go red under the mutant"; exit 1; }
    echo "probe-mutant: the probe went RED as required"
    ;;

  probe-cleanup)
    q -f "$HERE/postgrest/cleanup.sql"
    echo "probe-cleanup: done"
    ;;

  teardown)
    q -f "$HERE/lib/teardown.sql"
    echo "teardown: done -- run 'gate' again; it must re-match"
    ;;

  catalogue-seed)
    q -f "$HERE/lib/venue-catalogue.sql"
    echo "catalogue-seed: production's catalogue committed to the venue (re-hashed equal)"
    ;;

  catalogue-teardown)
    q -f "$HERE/lib/venue-catalogue-teardown.sql"
    echo "catalogue-teardown: the four catalogue tables are empty again"
    ;;

  *)
    echo "unknown command: $CMD" >&2; exit 2 ;;
esac
