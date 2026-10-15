#!/usr/bin/env bash
# BACKLOG-3851 two-session controls (c04, c12b, c14, c15). They need committed rows that
# two sessions can both see, so each run uses a THROWAWAY DATABASE cloned from the venue:
#   1. CREATE DATABASE race3851 + pg_dump of the venue database restored into it (as the
#      container's superuser over loopback). The venue database itself is never written.
#   2. In race3851, one transaction that COMMITS: the run.sh prelude (3946 stack, prod
#      bodies, pins = production today, fixtures) and M1 (or a mutant of it).
#   3. Two psql sessions run the scenario.
#   4. DROP DATABASE race3851 (trap, on every exit path).
#
#   SSH_HOST=<alias> PG_CONTAINER=<container> bash race.sh [scenario] [M1 file]
#   scenarios: c04r c04c c12b c14 c15 (default: all)
# Output: PASS|... / FAIL|... and CHECKS|<n>.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SCEN="${1:-all}"
M1F="${2:-$REPO/supabase/migrations/20261016100000_backlog_3851_license_model.sql}"
SSH_HOST="${SSH_HOST:?set SSH_HOST}"; CONTAINER="${PG_CONTAINER:?set PG_CONTAINER}"
DB=race3851
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
  "pg_dump -h 127.0.0.1 -U supabase_admin postgres > /tmp/venue-3851.sql" \
  "psql -h 127.0.0.1 -U supabase_admin -X -q -d $DB -f /tmp/venue-3851.sql >/dev/null 2>&1 || true" \
  "rm -f /tmp/venue-3851.sql" | in_container

# Prelude + M1, committed into the clone.
{ SSH_HOST="$SSH_HOST" PG_CONTAINER="$CONTAINER" PGDB="$DB" bash "$HERE/run.sh" emit "$M1F"; echo "SELECT 'SEEDED|' || md5(prosrc) FROM pg_proc WHERE proname = '_enforce_member_seat_limit';"; echo "COMMIT;"; } | q 2>&1 | grep -E 'PINS3851 OK|FIXTURES3851 OK|SEEDED|ERROR' > /tmp/race-seed.$$ || true
cat /tmp/race-seed.$$ | sed 's/^/SETUP|/'
grep -q '^SEEDED|' /tmp/race-seed.$$ || { echo "ERROR|setup failed"; rm -f /tmp/race-seed.$$; exit 2; }
rm -f /tmp/race-seed.$$
echo "SETUP|lockline|$(echo "SELECT CASE WHEN prosrc LIKE '%FOR NO KEY UPDATE%' THEN 'no_key_update' WHEN prosrc LIKE '%FOR UPDATE%' THEN 'for_update' ELSE 'none' END || ' count_before_lock=' || (strpos(prosrc, 'INTO v_used') < strpos(prosrc, 'FOR NO KEY UPDATE'))::text FROM pg_proc WHERE proname = '_enforce_member_seat_limit';" | q)"

id() { echo "md5('backlog-3917:$1')::uuid"; }
as_user() { echo "SELECT set_config('request.jwt.claims', json_build_object('sub', $(id "$1"), 'role', 'authenticated')::text, false); SET ROLE authenticated;"; }
n=0; fail=0
chk() { n=$((n+1)); if [ "$2" = 1 ]; then echo "PASS|$1|$3"; else echo "FAIL|$1|$3"; fail=1; fi; }
now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
# A seat-taking writer that does not pass through auto_provision_it_admin (which takes
# its own FOR UPDATE on the organization, BACKLOG-3096): a service-side invite INSERT.
ins_invite() { # org email
  echo "INSERT INTO public.organization_members (organization_id, invited_email, role, license_status, invitation_token, invitation_expires_at, provisioned_by) VALUES ($(id "$1"), '$2', 'agent', 'pending', 'tok-$2', now() + interval '3 days', 'invite');"
}
# o_org has max 20; make a dedicated two-seat org with one seat used.
echo "INSERT INTO public.organizations (id, name, slug, max_seats) VALUES ($(id r_org), 'Happyhomey Test 3851 R', 'happyhomey-test-3851-r', 2);
      INSERT INTO public.organization_members (organization_id, user_id, role, license_status, provisioned_by) VALUES ($(id r_org), $(id u_x3), 'admin', 'active', 'manual');" | q >/dev/null
used_r() { echo "SELECT count(*) FROM public.organization_members WHERE organization_id = $(id r_org) AND license_status IN ('active','pending');" | q; }

if [ "$SCEN" = all ] || [ "$SCEN" = c04r ]; then
  # A takes the last seat and holds the transaction; B (lock_timeout 1s) must time out
  # on the organization lock; after A rolls back, B succeeds.
  { echo "BEGIN;"; ins_invite r_org a1-3851@example.test; echo "SELECT pg_sleep(4); ROLLBACK;"; } | q >/dev/null 2>&1 &
  ap=$!; sleep 1.5
  t0=$(now_ms); b="$( { echo "SET lock_timeout = '1s';"; ins_invite r_org b1-3851@example.test; } | q 2>&1 || true)"; t1=$(now_ms)
  wait $ap || true
  [[ "$b" == *"lock timeout"* ]] && chk "c04r B times out on the organization lock while A holds the last seat" 1 "$((t1-t0))ms" || chk "c04r B times out on the organization lock while A holds the last seat" 0 "$((t1-t0))ms $b"
  b2="$(ins_invite r_org b2-3851@example.test | q 2>&1 || true)"
  [ -z "$b2" ] && chk "c04r after A rolls back, B takes the seat" 1 "" || chk "c04r after A rolls back, B takes the seat" 0 "$b2"
  u="$(used_r)"; [ "$u" = 2 ] && chk "c04r seats used = max" 1 "$u/2" || chk "c04r seats used = max" 0 "$u/2"
  echo "DELETE FROM public.organization_members WHERE organization_id = $(id r_org) AND invited_email LIKE 'b%-3851@example.test';" | q >/dev/null
fi

if [ "$SCEN" = all ] || [ "$SCEN" = c04c ]; then
  # A takes the last seat, sleeps 4 s, COMMITS. B starts 1.5 s later, blocks, then must be
  # refused with seat_limit_reached (counted after the lock).
  { echo "BEGIN;"; ins_invite r_org a2-3851@example.test; echo "SELECT pg_sleep(4); COMMIT;"; } | q >/dev/null 2>&1 &
  ap=$!; sleep 1.5
  t0=$(now_ms); b="$(ins_invite r_org b3-3851@example.test | q 2>&1 || true)"; t1=$(now_ms)
  wait $ap || true
  [ $((t1-t0)) -ge 1500 ] && chk "c04c B blocked until A commits" 1 "$((t1-t0))ms" || chk "c04c B blocked until A commits" 0 "$((t1-t0))ms"
  [[ "$b" == *"seat_limit_reached"* ]] && chk "c04c B refused seat_limit_reached after A commits" 1 "" || chk "c04c B refused seat_limit_reached after A commits" 0 "${b:-<B inserted>}"
  u="$(used_r)"; [ "$u" = 2 ] && chk "c04c seats used = max" 1 "$u/2" || chk "c04c seats used = max" 0 "$u/2"
  echo "DELETE FROM public.organization_members WHERE organization_id = $(id r_org) AND (invited_email LIKE 'a%-3851@example.test' OR invited_email LIKE 'b%-3851@example.test');" | q >/dev/null
fi

if [ "$SCEN" = all ] || [ "$SCEN" = c15 ]; then
  # While a seat writer holds the organization lock, a foreign-key child insert that
  # references the organization (a non-seat member row) completes without waiting.
  { echo "BEGIN;"; ins_invite r_org a3-3851@example.test; echo "SELECT pg_sleep(4); ROLLBACK;"; } | q >/dev/null 2>&1 &
  ap=$!; sleep 1.5
  t0=$(now_ms)
  c="$(echo "SET lock_timeout = '1s'; INSERT INTO public.organization_members (organization_id, user_id, role, license_status, provisioned_by) VALUES ($(id r_org), $(id u_x4), 'agent', 'suspended', 'manual');" | q 2>&1 || true)"
  t1=$(now_ms); wait $ap || true
  [ -z "$c" ] && [ $((t1-t0)) -lt 1000 ] && chk "c15 FK child insert completes while the seat lock is held" 1 "$((t1-t0))ms" || chk "c15 FK child insert completes while the seat lock is held" 0 "$((t1-t0))ms ${c}"
  echo "DELETE FROM public.organization_members WHERE organization_id = $(id r_org) AND user_id = $(id u_x4);" | q >/dev/null
fi

if [ "$SCEN" = all ] || [ "$SCEN" = c12b ]; then
  # White-glove w_org (max 2, two live invites, no claimed member). Two claimed IdP-origin
  # rows written concurrently: exactly one gets the first-member seat; the other is
  # written 'unassigned'. Limit stays max_seats + 1.
  ins_claimed() { echo "INSERT INTO public.organization_members (organization_id, user_id, role, license_status, provisioned_by, joined_at) VALUES ($(id w_org), $(id "$1"), 'admin', 'active', 'scim', now());"; }
  { echo "BEGIN;"; ins_claimed u_w1; echo "SELECT pg_sleep(4); COMMIT;"; } | q >/dev/null 2>&1 &
  ap=$!; sleep 1.5
  b="$(ins_claimed u_w2 | q 2>&1 || true)"; wait $ap || true
  st="$(echo "SELECT string_agg(license_status, ',' ORDER BY license_status) FROM public.organization_members WHERE organization_id = $(id w_org) AND user_id IS NOT NULL;" | q)"
  [ "$st" = "active,unassigned" ] && chk "c12b two concurrent first-claimed IdP rows: one active, one unassigned" 1 "$st" || chk "c12b two concurrent first-claimed IdP rows: one active, one unassigned" 0 "${st} ${b}"
  echo "DELETE FROM public.organization_members WHERE organization_id = $(id w_org) AND user_id IS NOT NULL;" | q >/dev/null
fi

if [ "$SCEN" = all ] || [ "$SCEN" = c14 ]; then
  # m2_org has two admins. Each unassigns the other at the same time: exactly one succeeds,
  # and the organization keeps an access-granting manager.
  { as_user u_m1; echo "BEGIN; SELECT 'A|' || public.set_member_license($(id m2_a2), 'unassign')::text; SELECT pg_sleep(3); COMMIT;"; } | q > /tmp/c14a.$$ 2>&1 &
  ap=$!; sleep 1
  b="$( { as_user u_m2; echo "SELECT 'B|' || public.set_member_license($(id m2_a1), 'unassign')::text;"; } | q 2>&1 || true)"
  wait $ap || true; a="$(grep '^A|' /tmp/c14a.$$ || cat /tmp/c14a.$$)"; rm -f /tmp/c14a.$$
  ok=0; [[ "$a" == *'"success": true'* ]] && ok=$((ok+1)); [[ "$b" == *'"success": true'* ]] && ok=$((ok+1))
  sa="$(echo "$a" | grep -oE '"(success|error)": [a-z_"]+' | tr '\n' ' ')"; sb="$(echo "$b" | grep -oE '"(success|error)": [a-z_"]+' | tr '\n' ' ')"
  [ "$ok" = 1 ] && chk "c14 exactly one of two mutual unassigns succeeds" 1 "A: $sa B: $sb" || chk "c14 exactly one of two mutual unassigns succeeds" 0 "A: $sa B: $sb"
  mg="$(echo "SELECT count(*) FROM public.organization_members WHERE organization_id = $(id m2_org) AND role IN ('broker','admin','it_admin') AND license_status = 'active';" | q)"
  [ "$mg" -ge 1 ] && chk "c14 organization keeps an access-granting manager" 1 "$mg" || chk "c14 organization keeps an access-granting manager" 0 "$mg"
fi

echo "CHECKS|$n"
[ "$fail" = 0 ] && [ "$n" -gt 0 ]
