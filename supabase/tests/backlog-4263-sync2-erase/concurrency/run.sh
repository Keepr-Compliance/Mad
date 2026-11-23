#!/bin/bash
# BACKLOG-4263 sync plan P3: two-session controls for the erase job. Venue: the test project through ~/.claude/bin/kt-sql.
# WRITTEN, NOT RUN. Needs E1 applied on the test project (the sessions call the committed functions) and the
# coordinator's go: setup COMMITS one fixture user (invented id, printed before anything is written) with one settings
# row, two deals, rows and one blob; the EXIT/INT/TERM trap deletes that user (rows cascade) and prints a residue
# count that must be 0. Each session itself ends in RAISE, so the sessions change nothing; only the fixture is
# committed and removed. lock_timeout 3 s in every session; holds are 2 s.
#
# Usage: run.sh attach   [single_statement_fence]   P3 condition 1: attach (A) versus orphan sweep (B)
#        run.sh c6g_skip [no_skip_locked]           C-6g (ii): a claim holds the settings row -> the batch skips the owner
#        run.sh c6g_wait [read_before_lock]         C-6g (i):  a batch holds the settings row -> the move waits for it
#
# attach:   A locks blob X FOR UPDATE as cloud_upsert_files does (/*FILE:lockblobs*/, 20261118110000), inserts a file
#           row with X, holds 2 s and COMMITS (the one session that commits: B must see the attach after its wait; the
#           trap removes that row with the fixture user). B (gated on A's hold) runs the live claim, which ends in
#           RAISE: its orphan arm locks X through _cloud_fence_unreferenced and must wait for A.
#           PASS: B waited (>= 1.5 s) and X is not fenced. Mutant single_statement_fence replaces the helper call in
#           B's own transaction with one UPDATE ... WHERE NOT EXISTS (file row): expected FAIL (X fenced although
#           referenced: the subquery reads the statement's snapshot, taken before A committed).
# c6g_skip: A takes the owner's settings row FOR UPDATE (what cloud_claim_install does), holds 2 s, RAISE. B (gated)
#           runs cloud_blob_erase_scrub(owner, live). PASS: B answers 'skipped' in < 1 s. Mutant no_skip_locked
#           (FOR SHARE without SKIP LOCKED, created in B's transaction): expected FAIL (B waits ~2 s, then scrubs).
# c6g_wait: A runs the scrub with a 2 s sleep inserted right after its settings lock (created in A's transaction),
#           RAISE. B (gated on A's sleep) moves the active computer (UPDATE ... SET active_install_id, what the claim
#           writes), RAISE. PASS: B waited >= 1.5 s (no move can land inside a batch). Mutant read_before_lock puts the
#           active-computer read and the sleep BEFORE the lock: expected FAIL (B does not wait; the batch then scrubs
#           with the computer it read before the move).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
K=~/.claude/bin/kt-sql
CASE="${1:-}"; MUT="${2:-}"
case "$CASE" in attach|c6g_skip|c6g_wait) ;; *) sed -n '2,27p' "$0"; exit 2 ;; esac
umask 077
tmp="$(mktemp -d)"
RUN="$(openssl rand -hex 8)"
U="$(python3 -c 'import uuid; print(uuid.uuid4())')"
I1="$(python3 -c 'import uuid; print(uuid.uuid4())')"; I2="$(python3 -c 'import uuid; print(uuid.uuid4())')"
echo "fixture user ${U} (invented; committed for this run, deleted by the trap)"
SETUP=0; VERDICT=FAIL
cleanup() {
  rc=$?; set +e; trap - EXIT INT TERM
  wait 2>/dev/null
  if [ "$SETUP" = 1 ]; then
    $K -c "SET session_replication_role = origin; DELETE FROM auth.users WHERE id = '${U}'" >/dev/null
    left="$($K -c "SELECT (SELECT count(*) FROM auth.users WHERE id = '${U}') + (SELECT count(*) FROM public.cloud_deals WHERE owner_user_id = '${U}') + (SELECT count(*) FROM public.cloud_blobs WHERE owner_user_id = '${U}') + (SELECT count(*) FROM public.cloud_autosave_settings WHERE user_id = '${U}') AS n" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["n"])')"
    if [ "$left" = "0" ]; then echo "residue check: fixture user ${U} and its rows gone (0)"; else echo "RESIDUE: ${left} rows of ${U} left" >&2; rc=1; fi
    $K -c "select extensions.pg_stat_statements_reset()" >/dev/null
  fi
  rm -rf "$tmp"; echo "${CASE} ${MUT:-pristine}: ${VERDICT}"
  [ "$VERDICT" = PASS ] || [ -n "$MUT" ] || rc=1
  exit $rc
}
trap cleanup EXIT; trap 'exit 130' INT TERM

# ---- setup (COMMITS): user, settings (active I1), deal on I1 and on I2, rows of I2, one unreferenced old blob X
cat > "$tmp/setup.sql" <<SQL
SET LOCAL lock_timeout = '3s';
SET LOCAL session_replication_role = replica;
INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES ('${U}', 'p4263c-${RUN}@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now());
SET LOCAL session_replication_role = origin;
INSERT INTO public.cloud_autosave_settings (user_id, enabled, notice_version, accepted_at, enabled_at, active_install_id, active_since)
VALUES ('${U}', true, 1, now(), now(), '${I1}', now());
INSERT INTO public.cloud_deals (owner_user_id, source_install_id, local_transaction_id, content_hash)
VALUES ('${U}', '${I1}', 'c-${RUN}-1', encode(sha256('d1-${RUN}'::bytea), 'hex')),
       ('${U}', '${I2}', 'c-${RUN}-2', encode(sha256('d2-${RUN}'::bytea), 'hex'));
INSERT INTO public.cloud_deal_messages (owner_user_id, cloud_deal_id, channel_kind, local_message_id, subject, body_text, content_hash)
SELECT '${U}', d.id, 'email', 'm-' || n, 'Fixture', 'Fixture', encode(sha256(('m-${RUN}-' || n)::bytea), 'hex')
  FROM public.cloud_deals d, generate_series(1, 3) n WHERE d.owner_user_id = '${U}' AND d.source_install_id = '${I2}';
INSERT INTO public.cloud_blobs (owner_user_id, sha256, size_bytes, storage_path, created_at, uploaded_at, id)
SELECT '${U}', encode(sha256('x-${RUN}'::bytea), 'hex'), 10, '${U}/' || g, now() - interval '3 days', now() - interval '3 days', g
  FROM (SELECT gen_random_uuid() AS g) s;
SELECT 'setup ok' AS r;
SQL
SETUP=1
$K "$tmp/setup.sql" > "$tmp/setup.out"; echo "setup: $(cat "$tmp/setup.out")"
X="$($K -c "SELECT id FROM public.cloud_blobs WHERE owner_user_id = '${U}'" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')"
D1="$($K -c "SELECT id FROM public.cloud_deals WHERE owner_user_id = '${U}' AND source_install_id = '${I1}'" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')"

SVC="SELECT set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true), set_config('request.jwt.claim.role', 'service_role', true);"
GATE="DO \$g\$ DECLARE i integer := 0; BEGIN WHILE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event = 'PgSleep' AND query LIKE '%p_hold:' || '${RUN}*/%') LOOP i := i + 1; IF i > 200 THEN RAISE EXCEPTION 'P_GATE_TIMEOUT'; END IF; PERFORM pg_sleep(0.1); END LOOP; END \$g\$;"
E1="${root}/supabase/migrations/20261123110000_backlog_4263_cloud_blob_erase.sql"
fn() { python3 - "$E1" "$1" <<'PY'
import sys
t = open(sys.argv[1]).read(); n = sys.argv[2]
s = 'CREATE OR REPLACE FUNCTION public.%s(' % n
assert t.count(s) == 1
i = t.index(s); j = t.index('$f$;', t.index('AS $f$', i)) + 4
print(t[i:j])
PY
}
mutate() {  # mutate <function> <old> <new>: prints the mutated CREATE, refuses when old does not match exactly once
  python3 - "$(fn "$1")" "$2" "$3" <<'PY'
import sys
u, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
n = u.count(old)
if n != 1:
    sys.exit('MUTATION NOT APPLIED: matched %d times: %r' % (n, old[:100]))
sys.stderr.write('MUTATION APPLIED\n  - %s\n  + %s\n' % (old.strip()[:140], new.strip()[:140]))
print(u.replace(old, new))
PY
}

case "$CASE" in
attach)
  # A commits its attach (see header); the trap removes the row with the user.
  cat > "$tmp/a.sql" <<SQL
SET LOCAL lock_timeout = '3s';
SELECT 1 FROM public.cloud_blobs b WHERE b.id = '${X}' AND b.owner_user_id = '${U}' AND b.purge_requested_at IS NULL ORDER BY b.id FOR UPDATE;
INSERT INTO public.cloud_deal_files (owner_user_id, cloud_deal_id, local_attachment_id, blob_id, filename, content_hash)
VALUES ('${U}', '${D1}', 'att-${RUN}', '${X}', 'a.pdf', encode(sha256('f-${RUN}'::bytea), 'hex'));
SELECT pg_sleep(2) /*p_hold:${RUN}*/ AS hold;
SQL
  PRE=""
  if [ "$MUT" = single_statement_fence ]; then
    PRE="$(mutate cloud_blob_erase_claim '      v_n_orphan := v_n_orphan + public._cloud_fence_unreferenced(r.owner, r.ids);          /*ORPHAN:fence*/' \
      '      UPDATE public.cloud_blobs b SET purge_requested_at = now() WHERE b.id = ANY (r.ids) AND b.owner_user_id = r.owner AND b.purge_requested_at IS NULL AND NOT EXISTS (SELECT 1 FROM public.cloud_deal_files f WHERE f.blob_id = b.id);')"
  elif [ -n "$MUT" ]; then echo "unknown mutant $MUT"; exit 2; fi
  { echo "SET LOCAL lock_timeout = '3s';"; [ -n "$PRE" ] && printf '%s\n' "$PRE"; echo "$GATE"; echo "$SVC";
    echo "DO \$b\$ DECLARE t0 timestamptz := clock_timestamp(); r jsonb; BEGIN r := public.cloud_blob_erase_claim(false, 1000, 20000);"
    echo "RAISE EXCEPTION 'P_B %', json_build_object('waited_s', extract(epoch FROM clock_timestamp() - t0), 'fenced', (SELECT purge_requested_at IS NOT NULL FROM public.cloud_blobs WHERE id = '${X}'));"
    echo "END \$b\$;"; } > "$tmp/b.sql"
  ;;
c6g_skip)
  echo "SET LOCAL lock_timeout = '3s'; SELECT 1 FROM public.cloud_autosave_settings WHERE user_id = '${U}' FOR UPDATE; SELECT pg_sleep(2) /*p_hold:${RUN}*/ AS hold; DO \$a\$ BEGIN RAISE EXCEPTION 'P_A done'; END \$a\$;" > "$tmp/a.sql"
  PRE=""
  if [ "$MUT" = no_skip_locked ]; then
    PRE="$(mutate cloud_blob_erase_scrub '       FOR SHARE SKIP LOCKED;                                                                /*SCRUB:settings_lock*/' '       FOR SHARE;')"
  elif [ -n "$MUT" ]; then echo "unknown mutant $MUT"; exit 2; fi
  { echo "SET LOCAL lock_timeout = '3s';"; [ -n "$PRE" ] && printf '%s\n' "$PRE"; echo "$GATE"; echo "$SVC";
    echo "UPDATE public.cloud_release_switches SET one_computer = true;"
    echo "DO \$b\$ DECLARE t0 timestamptz := clock_timestamp(); run uuid; r jsonb; BEGIN"
    echo "INSERT INTO public.cloud_blob_erase_runs (mode) VALUES ('live') RETURNING id INTO run;"
    echo "r := public.cloud_blob_erase_scrub(run, '${U}', false, 1000);"
    echo "RAISE EXCEPTION 'P_B %', json_build_object('waited_s', extract(epoch FROM clock_timestamp() - t0), 'answer', r); END \$b\$;"; } > "$tmp/b.sql"
  ;;
c6g_wait)
  if [ "$MUT" = read_before_lock ]; then
    PRE="$(mutate cloud_blob_erase_scrub "  ELSE
    SELECT true, s.active_install_id INTO v_found, v_active
      FROM public.cloud_autosave_settings s WHERE s.user_id = p_owner
       FOR SHARE SKIP LOCKED;                                                                /*SCRUB:settings_lock*/" "  ELSE
    SELECT s.active_install_id INTO v_active FROM public.cloud_autosave_settings s WHERE s.user_id = p_owner;
    PERFORM pg_sleep(2) /*p_hold:${RUN}*/;
    SELECT true INTO v_found
      FROM public.cloud_autosave_settings s WHERE s.user_id = p_owner
       FOR SHARE SKIP LOCKED;                                                                /*SCRUB:settings_lock*/")"
  elif [ -z "$MUT" ]; then
    PRE="$(mutate cloud_blob_erase_scrub '       FOR SHARE SKIP LOCKED;                                                                /*SCRUB:settings_lock*/' \
      "       FOR SHARE SKIP LOCKED;
    PERFORM pg_sleep(2) /*p_hold:${RUN}*/;")"
  else echo "unknown mutant $MUT"; exit 2; fi
  { echo "SET LOCAL lock_timeout = '3s';"; printf '%s\n' "$PRE"; echo "$SVC";
    echo "UPDATE public.cloud_release_switches SET one_computer = true;"
    echo "DO \$a\$ DECLARE run uuid; r jsonb; BEGIN INSERT INTO public.cloud_blob_erase_runs (mode) VALUES ('live') RETURNING id INTO run;"
    echo "r := public.cloud_blob_erase_scrub(run, '${U}', false, 1000); RAISE EXCEPTION 'P_A %', r; END \$a\$;"; } > "$tmp/a.sql"
  { echo "SET LOCAL lock_timeout = '3s';"; echo "$GATE";
    echo "DO \$b\$ DECLARE t0 timestamptz := clock_timestamp(); BEGIN"
    echo "UPDATE public.cloud_autosave_settings SET active_install_id = '${I2}', active_since = now() WHERE user_id = '${U}';"
    echo "RAISE EXCEPTION 'P_B %', json_build_object('waited_s', extract(epoch FROM clock_timestamp() - t0)); END \$b\$;"; } > "$tmp/b.sql"
  ;;
esac

( $K "$tmp/a.sql" > "$tmp/a.out" 2>&1 || true ) & pa=$!
sleep 1
( $K "$tmp/b.sql" > "$tmp/b.out" 2>&1 || true ) & pb=$!
wait $pa $pb
echo "a: $(head -c 1500 "$tmp/a.out")"; echo "b: $(head -c 1500 "$tmp/b.out")"
VERDICT="$(python3 - "$CASE" "$tmp/b.out" <<'PY'
import json, re, sys
case, raw = sys.argv[1], open(sys.argv[2]).read()
m = re.search(r'P_B (\{.*?\})', raw)
if not m:
    print('FAIL'); sys.exit()
b = json.loads(m.group(1))
if case == 'attach':
    ok = b['waited_s'] >= 1.5 and b['fenced'] is False
elif case == 'c6g_skip':
    ok = b['waited_s'] < 1.0 and b['answer'].get('state') == 'skipped'
else:
    ok = b['waited_s'] >= 1.5
print('PASS' if ok else 'FAIL')
PY
)"
