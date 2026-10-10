#!/usr/bin/env bash
# BACKLOG-3882 lock probe: does auto_provision_it_admin still hold the
# organizations row FOR UPDATE until commit (the BACKLOG-3096 race guard)?
#
# Session A, in one transaction that is ROLLED BACK: harness, fixtures, the
# migration (or a mutant), then a matching caller provisions into org_r, then
# sleeps. Session B, while A sleeps: SELECT ... FOR SHARE NOWAIT on org_r.
# FOR SHARE conflicts with FOR UPDATE but not with the KEY SHARE lock the
# membership INSERT's foreign key takes, so B fails with 55P03 only when the
# function took FOR UPDATE.
#
# org_r must be visible to B, so it is the ONE committed row: inserted before
# A starts and deleted on exit (trap). Nothing else is committed.
#
#   SSH_HOST=<alias> PG_CONTAINER=<container> bash race.sh [migration-file]
# Output: PASS|... or FAIL|... lines and CHECKS|n, like run.sh.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MIG="${1:-$REPO/supabase/migrations/20261010165424_backlog_3882_tenant_from_identity.sql}"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
psql_in() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER psql -U postgres -v ON_ERROR_STOP=1 -X -q -tA -f -"; }
ORG="md5('backlog-3882:org_r')::uuid"; TID="md5('backlog-3882:t_r')::uuid::text"

cleanup() { echo "DELETE FROM public.organizations WHERE id = $ORG;" | psql_in >/dev/null; }
trap cleanup EXIT
echo "INSERT INTO public.organizations (id, name, slug, microsoft_tenant_id, plan, max_seats)
      VALUES ($ORG, 'Fixture Org R 3882', 'fixture-org-r-3882', $TID, 'trial', 10);" | psql_in

tmp="$(mktemp -d)"
{
  echo "BEGIN;"
  cat "$HERE/lib/harness.sql" "$HERE/lib/fixtures.sql"
  echo "SELECT pg_temp.mk_azure('u_r', pg_temp.tid('t_r'));"
  cat "$MIG"
  echo "SELECT 'A|' || pg_temp.provision(pg_temp.id('u_r'), pg_temp.tid('t_r'));"
  echo "SELECT pg_sleep(8);"
  echo "ROLLBACK;"
} | psql_in >"$tmp/a" 2>&1 &
apid=$!
sleep 5
b="$(echo "SET lock_timeout = '1s'; SELECT 'B|got the row' FROM public.organizations WHERE id = $ORG FOR SHARE NOWAIT;" | psql_in 2>&1 || true)"
wait $apid || true
a="$(grep '^A|' "$tmp/a" || cat "$tmp/a")"
rm -rf "$tmp"

n=0; fail=0
chk() { n=$((n+1)); if [ "$2" = 1 ]; then echo "PASS|$1|$3"; else echo "FAIL|$1|$3"; fail=1; fi; }
[[ "$a" == *'"role": "admin"'* ]] && chk "race A provisioned as admin (transaction open)" 1 "$a" || chk "race A provisioned as admin (transaction open)" 0 "$a"
[[ "$b" == *"could not obtain lock"* ]] && chk "race B cannot lock org_r while A is open (FOR UPDATE held)" 1 "$b" || chk "race B cannot lock org_r while A is open (FOR UPDATE held)" 0 "$b"
echo "CHECKS|$n"
