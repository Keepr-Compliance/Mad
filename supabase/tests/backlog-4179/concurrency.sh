#!/usr/bin/env bash
# BACKLOG-4179 G3 + G5: forced two-session interleaves on keepr-test, against the COMMITTED guard.
#   bash concurrency.sh [base|M_no_lock]
# Two concurrent kt-sql calls are two database backends (distinct pg_backend_pid, overlapping
# windows; checked by every run below). Fixtures are COMMITTED (one session cannot see the other's
# uncommitted rows) under keys bl4179c:, and removed at the end; the leftover count is printed.
#
# G3: S1 accepts the invitation at A and holds its transaction 8 s. S2 starts 3 s later and accepts
#     the invitation at B: it must WAIT on the person lock (an observer at +5 s finds S2's pid in
#     pg_locks, advisory, not granted), then get P0001 already_placed when S1 commits.
# G5: S1 accepts an invitation at B for a solo Agent with a due domain-capture move to K. S2 runs
#     the move (_domain_capture_switch) 3 s later: its eligibility read passes (S1 not committed),
#     its insert waits on the person lock, then the guard refuses and the switch re-raises. A third
#     run afterwards cancels the move as not_eligible.
# M_no_lock installs the mutant function (no advisory lock) for the run and restores the
# migration's body afterwards (md5 printed before, during and after).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-base}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
KT=~/.claude/bin/kt-sql
STATS="SET LOCAL pg_stat_statements.track = 'none';"

fn_only() {  # the CREATE FUNCTION public._one_brokerage_per_member block of a composed migration
  python3 - "$1" <<'PY'
import sys
s = open(sys.argv[1]).read()
i = s.index('CREATE FUNCTION public._one_brokerage_per_member(')
j = s.index('$function$;', s.index('AS $function$', i) + 13) + len('$function$;')
print(s[i:j].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION', 1))
PY
}
md5() { $KT -c "select md5(prosrc) m from pg_proc where oid='public._one_brokerage_per_member()'::regprocedure"; }

restore() {  # always runs on exit once a mutant was installed: the migration's body back, md5 checked
  python3 "$HERE/compose.py" "$TMP/base.sql" base --mig-only >/dev/null; fn_only "$TMP/base.sql" > "$TMP/fn0.sql"
  $KT "$TMP/fn0.sql" >/dev/null; local now; now="$(md5)"; echo "md5 restored: $now"
  [ "$now" = "$MD5_BEFORE" ] || echo "RESTORE FAILED: md5 differs from before"
}

cat > "$TMP/prelude.sql" <<'SQL'
CREATE FUNCTION pg_temp.id(x text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $b$ SELECT md5('bl4179c:' || x)::uuid $b$;
CREATE FUNCTION pg_temp.as_user(u uuid, r text) RETURNS void LANGUAGE plpgsql AS $b$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', r)::text, true);
  PERFORM set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
  PERFORM set_config('request.jwt.claim.role', r, true);
END $b$;
-- Run q as role r; returns {"ok": value} or the error as PostgREST relays it (code/message/details/hint).
CREATE FUNCTION pg_temp.try(u uuid, r text, q text) RETURNS jsonb LANGUAGE plpgsql AS $b$
DECLARE v text; c text; m text; d text; h text;
BEGIN
  PERFORM pg_temp.as_user(u, r);
  EXECUTE format('SET LOCAL ROLE %I', r);
  EXECUTE q INTO v;
  RESET ROLE;
  RETURN jsonb_build_object('ok', v);
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS c = RETURNED_SQLSTATE, m = MESSAGE_TEXT, d = PG_EXCEPTION_DETAIL, h = PG_EXCEPTION_HINT;
  RETURN jsonb_build_object('code', c, 'message', m, 'details', nullif(d, ''), 'hint', nullif(h, ''));
END $b$;
SQL

cat > "$TMP/cleanup.sql" <<SQL
$STATS
$(cat "$TMP/prelude.sql")
DELETE FROM public.billing_outbox WHERE user_id IN (pg_temp.id('g3'), pg_temp.id('g5'));
DELETE FROM public.domain_capture_switches WHERE organization_id = pg_temp.id('oK');
DELETE FROM public.organization_members WHERE organization_id IN
  (pg_temp.id('oA'), pg_temp.id('oB'), pg_temp.id('oB5'), pg_temp.id('oK'), pg_temp.id('po_g5'));
DELETE FROM public.domain_claims WHERE id = pg_temp.id('cK');
-- The member change-log trigger's audit rows (no foreign key, so the deletes above leave them).
DELETE FROM public.billing_change_log WHERE organization_id IN
  (pg_temp.id('oA'), pg_temp.id('oB'), pg_temp.id('oB5'), pg_temp.id('oK'), pg_temp.id('po_g5'));
DELETE FROM public.organizations WHERE id IN
  (pg_temp.id('oA'), pg_temp.id('oB'), pg_temp.id('oB5'), pg_temp.id('oK'), pg_temp.id('po_g5'));
DELETE FROM public.licenses WHERE user_id IN (pg_temp.id('g3'), pg_temp.id('g5'));
DELETE FROM auth.identities WHERE user_id IN (pg_temp.id('g3'), pg_temp.id('g5'));
DELETE FROM public.users WHERE id IN (pg_temp.id('g3'), pg_temp.id('g5'));
DELETE FROM auth.users WHERE id IN (pg_temp.id('g3'), pg_temp.id('g5'));
SELECT (SELECT count(*) FROM auth.users WHERE email LIKE '%@c-4179.test') AS users_left,
       (SELECT count(*) FROM public.organizations WHERE slug LIKE '%-4179c') AS orgs_left,
       (SELECT count(*) FROM public.billing_change_log WHERE organization_id IN
          (pg_temp.id('oA'), pg_temp.id('oB'), pg_temp.id('oB5'), pg_temp.id('oK'), pg_temp.id('po_g5'))) AS change_log_left;
SQL

cat > "$TMP/setup.sql" <<SQL
$STATS
$(cat "$TMP/prelude.sql")
INSERT INTO auth.users (id, email, instance_id, aud, role, email_confirmed_at)
  SELECT pg_temp.id(k), k || '@c-4179.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', now()
    FROM unnest(ARRAY['g3', 'g5']) k;
INSERT INTO public.users (id, email, oauth_provider, oauth_id)
  SELECT pg_temp.id(k), k || '@c-4179.test', 'google', k || '4179c' FROM unnest(ARRAY['g3', 'g5']) k ON CONFLICT DO NOTHING;
INSERT INTO auth.identities (provider_id, user_id, identity_data, provider)
  SELECT k || '-pid-4179c', pg_temp.id(k), jsonb_build_object('sub', pg_temp.id(k), 'email', k || '@c-4179.test'), 'email'
    FROM unnest(ARRAY['g3', 'g5']) k;
INSERT INTO public.organizations (id, name, slug, is_test, max_seats) VALUES
  (pg_temp.id('oA'), 'Race A 4179', 'race-a-4179c', true, 10),
  (pg_temp.id('oB'), 'Race B 4179', 'race-b-4179c', true, 10),
  (pg_temp.id('oB5'), 'Race B5 4179', 'race-b5-4179c', true, 10),
  (pg_temp.id('oK'), 'Race K 4179', 'race-k-4179c', true, 10);
-- g5 is a solo Agent: personal organization + membership + licence.
INSERT INTO public.licenses (user_id, license_key, license_type, status) VALUES (pg_temp.id('g5'), 'lk-4179c-g5', 'individual', 'active');
INSERT INTO public.organizations (id, name, slug, is_test, max_seats, personal_owner_user_id)
  VALUES (pg_temp.id('po_g5'), 'Personal', 'po-g5-4179c', true, 1, pg_temp.id('g5'));
INSERT INTO public.organization_members (organization_id, user_id, role, license_status) VALUES (pg_temp.id('po_g5'), pg_temp.id('g5'), 'admin', 'active');
-- Invitations: g3 at A and at B; g5 at B5.
INSERT INTO public.organization_members (organization_id, user_id, role, license_status, invited_email, invitation_token, invitation_expires_at) VALUES
  (pg_temp.id('oA'), NULL, 'agent', 'pending', 'g3@c-4179.test', 'tok4179c-g3-a', now() + interval '7 days'),
  (pg_temp.id('oB'), NULL, 'agent', 'pending', 'g3@c-4179.test', 'tok4179c-g3-b', now() + interval '7 days'),
  (pg_temp.id('oB5'), NULL, 'agent', 'pending', 'g5@c-4179.test', 'tok4179c-g5-b5', now() + interval '7 days');
-- K: a verified, freshly checked claim on c-4179.test and a due move for g5 (notice delivered).
INSERT INTO public.domain_claims (id, organization_id, domain, token, status, verified_at, last_checked_at, last_check_result)
  VALUES (pg_temp.id('cK'), pg_temp.id('oK'), 'c-4179.test', 'keepr-domain-verification=' || substr(md5('c4179') || md5('d4179'), 1, 48),
          'verified', now() - interval '20 days', now(), 'verified');
INSERT INTO public.domain_capture_switches (id, organization_id, claim_id, user_id, email_at_start, attestation, status, switch_at, notice_delivered, notice_sent_at)
  VALUES (pg_temp.id('sK'), pg_temp.id('oK'), pg_temp.id('cK'), pg_temp.id('g5'), 'g5@c-4179.test', 'email_confirmed', 'scheduled',
          now() - interval '1 minute', true, now() - interval '14 days');
SELECT 'setup ok' AS r;
SQL

# $1 = sleep before, $2 = role, $3 = user key ('' = none), $4 = SQL, $5 = sleep after
session() {
cat <<SQL
$STATS
$(cat "$TMP/prelude.sql")
SELECT pg_sleep($1);
SELECT pg_backend_pid() AS pid, clock_timestamp()::text AS called_at,
       pg_temp.try($( [ -n "$3" ] && echo "pg_temp.id('$3')" || echo NULL ), '$2', \$q\$$4\$q\$) AS r,
       clock_timestamp()::text AS returned_at, pg_sleep($5)::text AS held, clock_timestamp()::text AS committed_at;
SQL
}
observer() {
cat <<SQL
$STATS
SELECT pg_sleep($1);
SELECT clock_timestamp()::text AS at,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('pid', l.pid, 'granted', l.granted) ORDER BY l.granted, l.pid), '[]'::jsonb)
     FROM pg_locks l WHERE l.locktype = 'advisory' AND l.objid = (hashtextextended(md5('bl4179c:$2')::uuid::text, 3364) & 4294967295)::oid
                       AND l.classid = ((hashtextextended(md5('bl4179c:$2')::uuid::text, 3364) >> 32) & 4294967295)::oid) AS person_lock;
SQL
}

run_pair() {  # $1 label, $2 user key, $3 S1 file, $4 S2 file
  observer 5 "$2" > "$TMP/obs.sql"
  $KT "$3" > "$TMP/s1.out" 2>&1 & P1=$!
  $KT "$4" > "$TMP/s2.out" 2>&1 & P2=$!
  $KT "$TMP/obs.sql" > "$TMP/obs.out" 2>&1 & P3=$!
  wait $P1; wait $P2; wait $P3
  echo "$1 S1: $(cat "$TMP/s1.out")"
  echo "$1 S2: $(cat "$TMP/s2.out")"
  echo "$1 observer: $(cat "$TMP/obs.out")"
}

$KT "$TMP/cleanup.sql" >/dev/null 2>&1   # leftovers from an aborted run
echo "setup: $($KT "$TMP/setup.sql")"

# The mutant is installed only for the two races (shortest window); restore() runs on any exit.
if [ "$MODE" != base ]; then
  python3 "$HERE/compose.py" "$TMP/mut.sql" "$MODE" --mig-only || exit 2
  fn_only "$TMP/mut.sql" > "$TMP/fn.sql"
  MD5_BEFORE="$(md5)"; echo "md5 before: $MD5_BEFORE"
  trap 'restore; rm -rf "$TMP"' EXIT INT TERM
  $KT "$TMP/fn.sql" >/dev/null; echo "md5 mutant: $(md5)"
fi

# ---- G3: accept at A (held) vs accept at B --------------------------------------------------------
session 0 authenticated g3 "SELECT public.accept_invitation('tok4179c-g3-a')::text" 8 > "$TMP/g3a.sql"
session 3 authenticated g3 "SELECT public.accept_invitation('tok4179c-g3-b')::text" 0 > "$TMP/g3b.sql"
run_pair G3 g3 "$TMP/g3a.sql" "$TMP/g3b.sql"
echo "G3 rows: $($KT -c "select o.slug, m.license_status from public.organization_members m join public.organizations o on o.id = m.organization_id where m.user_id = md5('bl4179c:g3')::uuid order by 1")"

# ---- G5: accept at B5 (held) vs the domain-capture move to K -------------------------------------
session 0 authenticated g5 "SELECT public.accept_invitation('tok4179c-g5-b5')::text" 8 > "$TMP/g5a.sql"
session 3 service_role "" "SELECT public._domain_capture_switch(md5('bl4179c:sK')::uuid)::text" 0 > "$TMP/g5b.sql"
run_pair G5 g5 "$TMP/g5a.sql" "$TMP/g5b.sql"
echo "G5 switch after race: $($KT -c "select status, reason from public.domain_capture_switches where id = md5('bl4179c:sK')::uuid")"
session 0 service_role "" "SELECT public._domain_capture_switch(md5('bl4179c:sK')::uuid)::text" 0 > "$TMP/g5c.sql"
echo "G5 next run: $($KT "$TMP/g5c.sql")"
echo "G5 switch after next run: $($KT -c "select status, reason from public.domain_capture_switches where id = md5('bl4179c:sK')::uuid")"
echo "G5 rows: $($KT -c "select o.slug, m.license_status from public.organization_members m join public.organizations o on o.id = m.organization_id where m.user_id = md5('bl4179c:g5')::uuid order by 1")"

if [ "$MODE" != base ]; then restore; trap 'rm -rf "$TMP"' EXIT INT TERM; fi
echo "cleanup: $($KT "$TMP/cleanup.sql")"
$KT -c "select extensions.pg_stat_statements_reset()" >/dev/null 2>&1 || echo "pg_stat_statements_reset failed"
