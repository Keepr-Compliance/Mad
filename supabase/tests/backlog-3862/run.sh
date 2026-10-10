#!/usr/bin/env bash
# BACKLOG-3862 harness. Each control runs in ONE transaction ending in
# ROLLBACK: helpers, fixtures (production's four pricing rows, transcribed),
# the migration (or a mutant), then the control. Nothing is committed.
#
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh controls
#   SSH_HOST=<ssh alias> PG_CONTAINER=<container> bash run.sh mutants
# SSH_HOST=local runs `docker exec` on this machine.
#
# Header tags: `-- harness: apply-twice` runs the migration twice.
# Per control: PASS (all checks pass), FAIL (a check failed), RAISED (the
# migration's own assertion aborted the run: counts as red), ERROR (any other
# psql failure, or zero checks: proves nothing). REFUSED_BY_INDEX: the
# table's partial unique index credit_pricing_tiers_active_band (one open band
# per scope/currency/min_units, present in production) rejected the write:
# also red, but the refusal came from the schema, not from these controls.
# mutants: every control must PASS on the real migration first. Each mutant is
# run twice: as written (the in-migration assertion may stop it) and with the
# DO block removed (+nodo: the external controls alone must catch it).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="$REPO/supabase/migrations/20261010130000_backlog_3862_flat_1499.sql"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
psql_in() {
  if [ "$SSH_HOST" = "local" ]; then docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -
  else ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -"; fi
}
build() { # $1 control, $2 migration ('-' = baseline: not applied)
  echo "BEGIN;"; cat "$HERE/lib_harness.sql" "$HERE/lib_fixtures.sql"
  if [ "$2" != "-" ]; then cat "$2"; grep -q -- '-- harness: apply-twice' "$1" && cat "$2"; fi
  cat "$1"
  echo "SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || '|' || label || '|' || coalesce(detail, '') FROM t3862_r ORDER BY seq;"
  echo "SELECT 'CHECKS|' || count(*) FROM t3862_r;"; echo "ROLLBACK;"
}
run_one() { # prints lines; echoes verdict on last line: PASS FAIL RAISED ERROR
  local out
  if ! out="$(build "$1" "$2" | psql_in 2>&1)"; then
    if echo "$out" | grep -q "3862: expected one open 1499 band"; then
      echo "$out" | grep -o "3862: expected[^\"]*" | head -1; echo "RAISED"; return; fi
    if echo "$out" | grep -q 'unique constraint "credit_pricing_tiers_active_band"'; then
      echo "$out" | grep -o 'duplicate key[^\n]*' | head -1; echo "REFUSED_BY_INDEX"; return; fi
    echo "$out" | grep -v '^$' | tail -6; echo "ERROR"; return; fi
  echo "$out" | grep -E '^(PASS|FAIL|QUOTE)\|' || true
  local n; n="$(echo "$out" | sed -n 's/^CHECKS|//p')"
  if [ -z "$n" ] || [ "$n" = "0" ]; then echo "ERROR"; return; fi
  if echo "$out" | grep -q '^FAIL|'; then echo "FAIL"; else echo "PASS"; fi
}
controls() { # $1 migration; prints CONTROL|name|verdict
  for c in "$HERE"/controls/*.sql; do
    local res; res="$(run_one "$c" "$1")"
    echo "$res" | sed '$d' | sed 's/^/    /'
    echo "CONTROL|$(basename "$c" .sql)|$(echo "$res" | tail -1)"
  done
}
case "${1:-}" in
  controls)
    out="$(controls "$MIG")"; echo "$out"
    p=$(echo "$out" | grep -c '^CONTROL|.*|PASS$' || true); t=$(echo "$out" | grep -c '^CONTROL|' || true)
    echo "CONTROLS: pass=$p of $t"; [ "$p" = "$t" ] && [ "$t" -gt 0 ] ;;
  mutants)
    base="$(controls "$MIG")"
    if echo "$base" | grep '^CONTROL|' | grep -qv '|PASS$'; then echo "$base"; echo "baseline not green; no mutants run"; exit 1; fi
    echo "baseline: all controls PASS"
    echo "== mutant: migration not applied"
    controls "-" | grep '^CONTROL|'
    for m in no_insert no_update reprice no_guard; do
      for v in "$m" "$m+nodo"; do
        python3 "$HERE/mutate.py" "$MIG" "$v" "$TMP/m.sql"
        echo "== mutant: $v  MUTATION APPLIED ($( { diff "$MIG" "$TMP/m.sql" || true; } | grep -c '^[<>]') lines changed)"
        { diff "$MIG" "$TMP/m.sql" || true; } | grep '^[<>]' | grep -v '^[<>] *$' | head -3 | sed 's/^/    /'
        controls "$TMP/m.sql" | grep '^CONTROL|'
      done
    done ;;
  *) echo "usage: run.sh controls|mutants"; exit 64 ;;
esac
