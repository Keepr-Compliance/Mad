#!/usr/bin/env bash
# BACKLOG-3851 setup S14: two sessions bind the same Microsoft tenant to two organizations
# that have none. Expect one success and one tenant_in_use (never an uncaught 23505).
# Uses a THROWAWAY DATABASE (race3851s) cloned from the venue database, committed into,
# and dropped on every exit path. The venue database itself is never written.
#
#   SSH_HOST=<alias> PG_CONTAINER=<container> bash race.sh [NEW migration file]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
M="$REPO/supabase/migrations"
NEWF="${1:-$M/20261016054316_backlog_3851_setup_completes_invite.sql}"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
DB=race3851s
in_container() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i $CONTAINER bash -s"; }
q() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" "docker exec -i -e PGOPTIONS=-cclient_min_messages=warning $CONTAINER psql -U postgres -d $DB -v ON_ERROR_STOP=1 -X -q -tA -f -"; }
drop_db() {
  printf '%s\n' "psql -h 127.0.0.1 -U supabase_admin -X -q -d postgres -c \"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB'\" >/dev/null" \
                "psql -h 127.0.0.1 -U supabase_admin -X -q -d postgres -c 'DROP DATABASE IF EXISTS $DB'" | in_container
}
trap 'drop_db; echo "CLEANUP|$DB dropped"' EXIT
drop_db
printf '%s\n' "set -e" \
  "psql -h 127.0.0.1 -U supabase_admin -X -q -d postgres -c 'CREATE DATABASE $DB OWNER postgres'" \
  "pg_dump -h 127.0.0.1 -U supabase_admin postgres > /tmp/venue-3851s.sql" \
  "psql -h 127.0.0.1 -U supabase_admin -X -q -d $DB -f /tmp/venue-3851s.sql >/dev/null 2>&1 || true" \
  "rm -f /tmp/venue-3851s.sql" | in_container

id() { echo "md5('backlog-3917:$1')::uuid"; }
TID="md5('backlog-3851-tenant:t_r14')::uuid::text"
seed() {
  for u in u_r14a u_r14b; do
    echo "INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data, raw_app_meta_data) VALUES ($(id $u), '$u-3917@example.test', 'authenticated', 'authenticated', '{}', '{\"provider\":\"azure\"}');"
    echo "INSERT INTO public.users (id, email, oauth_provider, oauth_id) VALUES ($(id $u), '$u-3917@example.test', 'azure', 'oauth-$u');"
    echo "INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at) VALUES ('sub-$u', $(id $u), jsonb_build_object('sub', 'sub-$u', 'custom_claims', jsonb_build_object('tid', $TID)), 'azure', now(), now(), now());"
  done
  for o in a b; do
    echo "INSERT INTO public.organizations (id, name, slug, max_seats) VALUES ($(id org_r14$o), 'Happyhomey Test 3851 setup R14$o', 'happyhomey-test-3851-setup-r14$o', 5);"
    echo "INSERT INTO public.organization_members (organization_id, user_id, role, license_status, provisioned_by, joined_at) VALUES ($(id org_r14$o), $(id u_r14$o), 'admin', 'active', 'manual', now());"
  done
}
{ SSH_HOST="$SSH_HOST" PG_CONTAINER="$CONTAINER" PGDB="$DB" bash "$REPO/supabase/tests/backlog-3851/run.sh" emit \
    "$M/20261015152446_backlog_3851_license_model.sql" "$HERE/lib/pin-setup.sql" "$M/20261016100100_backlog_3851_paygo_revert.sql" "$NEWF"
  seed
  echo "SELECT 'SEEDED|' || md5(prosrc) FROM pg_proc WHERE oid = 'public.auto_provision_it_admin(text,text,text)'::regprocedure;"
  echo "COMMIT;"; } | q 2>&1 | grep -E 'PINS3851 OK|PINSETUP OK|SEEDED|ERROR' > "$HERE/.race-seed.$$" || true
sed 's/^/SETUP|/' "$HERE/.race-seed.$$"
grep -q '^SEEDED|' "$HERE/.race-seed.$$" || { echo "ERROR|setup failed"; rm -f "$HERE/.race-seed.$$"; exit 2; }
rm -f "$HERE/.race-seed.$$"

call() { # user, sleep-after seconds
  echo "BEGIN; SELECT set_config('request.jwt.claims', json_build_object('sub', $(id "$1"), 'role', 'authenticated')::text, true); SET LOCAL ROLE authenticated;
        SELECT 'RES|$1|' || public.auto_provision_it_admin($TID, '', '')::text; SELECT pg_sleep($2); COMMIT;"
}
outA="$(mktemp)"; outB="$(mktemp)"
call u_r14a 3 | q > "$outA" 2>&1 &
pa=$!
sleep 1
call u_r14b 0 | q > "$outB" 2>&1 || true
wait $pa || true
A="$(cat "$outA")"; B="$(cat "$outB")"; rm -f "$outA" "$outB"
echo "A|$(echo "$A" | tr '\n' ' ' | cut -c1-240)"; echo "B|$(echo "$B" | tr '\n' ' ' | cut -c1-240)"
held="$(echo "SELECT string_agg(o.slug, ',' ORDER BY o.slug) FROM public.organizations o WHERE lower(o.microsoft_tenant_id) = $TID;" | q)"
n=0; fail=0
chk() { n=$((n+1)); if [ "$2" = 1 ]; then echo "PASS|$1|$3"; else echo "FAIL|$1|$3"; fail=1; fi; }
chk "S14 first session binds" "$(echo "$A" | grep -q '"success": true' && echo 1 || echo 0)" ""
chk "S14 second session gets tenant_in_use" "$(echo "$B" | grep -q '"tenant_in_use"' && echo 1 || echo 0)" ""
chk "S14 no uncaught 23505" "$(echo "$B" | grep -qi 'duplicate key' && echo 0 || echo 1)" ""
chk "S14 exactly one org holds the tenant" "$([ "$held" = happyhomey-test-3851-setup-r14a ] && echo 1 || echo 0)" "$held"
echo "CHECKS|$n"
exit $fail
