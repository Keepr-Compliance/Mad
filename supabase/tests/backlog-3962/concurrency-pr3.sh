#!/usr/bin/env bash
# BACKLOG-3962 PR3a: two concurrent _domain_capture_switch calls, one free seat, on keepr-test.
# The fixture is COMMITTED (two sessions cannot see each other's uncommitted rows) and removed at
# the end. Session A takes the switch and holds its transaction 6 s; session B starts 2 s later.
#   bash concurrency-pr3.sh [base|C_no_lock|C_no_lock_no_fallback]
# A mutant mode installs the mutated _domain_capture_switch for the run and restores the
# migration's body afterwards (md5 printed both times).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-base}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
KT=~/.claude/bin/kt-sql
ID="md5('bl3962k:' || x)::uuid"
fn_only() {  # extract the CREATE FUNCTION public._domain_capture_switch block from a migration text
  python3 - "$1" <<'PY'
import sys
s=open(sys.argv[1]).read()
i=s.index('CREATE FUNCTION public._domain_capture_switch(')
j=s.index('$function$;', s.index('AS $function$', i)+13)+len('$function$;')
print(s[i:j].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1))
PY
}
md5() { $KT -c "select md5(prosrc) m from pg_proc where oid='public._domain_capture_switch(uuid)'::regprocedure"; }

if [ "$MODE" != base ]; then
  python3 "$HERE/compose.py" "$TMP/mut.sql" "$MODE" --mig-only || exit 2
  fn_only "$TMP/mut.sql" > "$TMP/fn.sql"; echo "md5 before: $(md5)"; $KT "$TMP/fn.sql" >/dev/null; echo "md5 mutant: $(md5)"
fi

cat > "$TMP/setup.sql" <<SQL
CREATE FUNCTION pg_temp.id(x text) RETURNS uuid LANGUAGE sql IMMUTABLE AS \$b\$ SELECT $ID \$b\$;
INSERT INTO auth.users (id, email, instance_id, aud, role, email_confirmed_at)
  SELECT pg_temp.id(k), e, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', now()
    FROM (VALUES ('adm','adm@corp-3962k.test'),('p1','p1@k-3962.test'),('p2','p2@k-3962.test')) v(k,e);
INSERT INTO public.users (id, email, oauth_provider, oauth_id)
  SELECT pg_temp.id(k), k || '@3962k', 'google', k || '3962k' FROM unnest(ARRAY['adm','p1','p2']) k ON CONFLICT DO NOTHING;
INSERT INTO auth.identities (provider_id, user_id, identity_data, provider)
  SELECT k || '-3962k', pg_temp.id(k), jsonb_build_object('sub', pg_temp.id(k)), 'email' FROM unnest(ARRAY['p1','p2']) k;
INSERT INTO public.organizations (id, name, slug, is_test, max_seats) VALUES (pg_temp.id('oK'), 'Capture K 3962', 'cap-k-3962', true, 2);
INSERT INTO public.organizations (id, name, slug, is_test, max_seats, personal_owner_user_id)
  SELECT pg_temp.id('po_' || k), 'Personal', 'po-' || k || '-3962k', true, 1, pg_temp.id(k) FROM unnest(ARRAY['p1','p2']) k;
INSERT INTO public.organization_members (organization_id, user_id, role, license_status)
  SELECT pg_temp.id('po_' || k), pg_temp.id(k), 'admin', 'active' FROM unnest(ARRAY['p1','p2']) k;
INSERT INTO public.organization_members (organization_id, user_id, role, license_status) VALUES (pg_temp.id('oK'), pg_temp.id('adm'), 'admin', 'active');
INSERT INTO public.domain_claims (id, organization_id, domain, token, status, verified_at, last_checked_at, last_check_result)
  VALUES (pg_temp.id('cK'), pg_temp.id('oK'), 'k-3962.test', 'keepr-domain-verification=' || substr(md5('k1') || md5('k2'), 1, 48),
          'verified', now(), now(), 'verified');
INSERT INTO public.domain_capture_switches (id, organization_id, claim_id, user_id, email_at_start, attestation, switch_at, notice_delivered, notice_sent_at)
  SELECT pg_temp.id('s_' || k), pg_temp.id('oK'), pg_temp.id('cK'), pg_temp.id(k), k || '@k-3962.test', 'email_confirmed',
         now() - interval '1 minute', true, now() - interval '14 days' FROM unnest(ARRAY['p1','p2']) k;
SELECT 'setup ok' AS r;
SQL
session() {  # $1 = switch key, $2 = sleep before, $3 = sleep after
cat <<SQL
CREATE TEMP TABLE out3962 (r text, t0 text, t1 text) ON COMMIT DROP;
GRANT ALL ON out3962 TO service_role;
SELECT pg_sleep($2);
INSERT INTO out3962 VALUES (NULL, clock_timestamp()::text, NULL);
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true), set_config('request.jwt.claim.role', 'service_role', true);
SET LOCAL ROLE service_role;
UPDATE out3962 SET r = public._domain_capture_switch(md5('bl3962k:s_$1')::uuid)::text;
UPDATE out3962 SET t1 = clock_timestamp()::text;
RESET ROLE;
SELECT pg_sleep($3);
SELECT t0 AS called_at, t1 AS returned_at, r FROM out3962;
SQL
}
cat > "$TMP/cleanup.sql" <<SQL
CREATE FUNCTION pg_temp.id(x text) RETURNS uuid LANGUAGE sql IMMUTABLE AS \$b\$ SELECT $ID \$b\$;
DELETE FROM public.billing_outbox WHERE user_id IN (pg_temp.id('p1'), pg_temp.id('p2'));
DELETE FROM public.domain_capture_switches WHERE organization_id = pg_temp.id('oK');
DELETE FROM public.organization_members WHERE organization_id IN (pg_temp.id('oK'), pg_temp.id('po_p1'), pg_temp.id('po_p2'));
DELETE FROM public.domain_claims WHERE id = pg_temp.id('cK');
DELETE FROM public.organizations WHERE id IN (pg_temp.id('oK'), pg_temp.id('po_p1'), pg_temp.id('po_p2'));
DELETE FROM auth.identities WHERE user_id IN (pg_temp.id('p1'), pg_temp.id('p2'));
DELETE FROM public.users WHERE id IN (pg_temp.id('adm'), pg_temp.id('p1'), pg_temp.id('p2'));
DELETE FROM auth.users WHERE id IN (pg_temp.id('adm'), pg_temp.id('p1'), pg_temp.id('p2'));
SELECT (SELECT count(*) FROM auth.users WHERE email LIKE '%3962k.test' OR email LIKE '%@k-3962.test') AS users_left,
       (SELECT count(*) FROM public.organizations WHERE slug LIKE '%3962k' OR slug = 'cap-k-3962') AS orgs_left;
SQL
$KT "$TMP/cleanup.sql" >/dev/null 2>&1   # leftovers from an aborted run
$KT "$TMP/setup.sql"
session p1 0 6 > "$TMP/a.sql"; session p2 2 0 > "$TMP/b.sql"
$KT "$TMP/a.sql" > "$TMP/a.out" 2>&1 & PA=$!
$KT "$TMP/b.sql" > "$TMP/b.out" 2>&1 & PB=$!
wait $PA; wait $PB
echo "A: $(cat "$TMP/a.out")"; echo "B: $(cat "$TMP/b.out")"
$KT -c "select m.user_id = md5('bl3962k:p1')::uuid as is_p1, m.license_status, m.provisioned_by from public.organization_members m where m.organization_id = md5('bl3962k:oK')::uuid and m.provisioned_by = 'domain_capture' order by 1 desc"
$KT -c "select user_id = md5('bl3962k:p1')::uuid as is_p1, status, license_status from public.domain_capture_switches where organization_id = md5('bl3962k:oK')::uuid order by 1 desc"
echo "cleanup: $($KT "$TMP/cleanup.sql")"
if [ "$MODE" != base ]; then
  python3 "$HERE/compose.py" "$TMP/base.sql" pr3 --mig-only; fn_only "$TMP/base.sql" > "$TMP/fn0.sql"; $KT "$TMP/fn0.sql" >/dev/null; echo "md5 restored: $(md5)"
fi
