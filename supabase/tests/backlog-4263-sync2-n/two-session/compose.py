#!/usr/bin/env python3
"""BACKLOG-4263 P11 two-session control: an approve whose transaction began BEFORE T-N's (dry-run database only).

`python3 -I compose.py <outdir> <mode> <run-id> <user-id> <org-id> <member-id> <client-id> <request-id>` writes the calls
run.sh sends (each starts with the test-database guard), and prints MUTATION APPLIED lines in mode 'mutant'.
  mode 'pristine': T-N and its rollback exactly as in the repository.
  mode 'mutant':   T-N as it was before the expiry fix (the trigger writes now() and skips requests whose expiry time
                   has passed by its own clock), with the rollback that matches it (the trigger body md5 it checks and its
                   post-check). Every replacement must match exactly once, or nothing is written.
`python3 -I compose.py --check` composes both modes with placeholder ids into a temporary folder (offline_check.py).
"""
import hashlib
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
# the repository the migration and the rollback file are read from (a guarded copy of this folder sets T4263N_REPO)
REPO = os.environ.get('T4263N_REPO') or os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
T_PATH = 'supabase/migrations/20261123150000_backlog_4263_ai_approval_notice_2.sql'
RB_PATH = 'supabase/tests/backlog-4263-sync2-n/rollback-20261123150000.sql'
T_VERSION, T_LEDGER = '20261123150000', 'backlog_4263_ai_approval_notice_2'
# The dry-run database's marker: md5 of the id of one auth.users row there, given as T4263N_MARKER_MD5 (no default, so
# nothing in the repository makes this control runnable by omission). The hosted test project's marker is refused here
# and inside every call; it is written as two pieces so no text in this folder contains it whole.
HOSTED_MARKER = '53a38518' + '7695375e2e8695625a20a77a'
MARKER_RE = re.compile(r'^[0-9a-f]{32}$')
EXPIRE_FN = 'public._mcp_notice_change_expires_requests()'
md5 = lambda s: hashlib.md5(s.encode('utf-8')).hexdigest()
rd = lambda p: open(os.path.join(REPO, p), encoding='utf-8').read()
UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')

# the text before the expiry fix, statement by statement (each must match exactly once)
TN_MUTANT = [
    ("       SET expires_at = '-infinity'                                                          /*EXPIRE:value*/",
     "       SET expires_at = now()                                                                /*EXPIRE:value*/"),
    ("     WHERE r.status = 'pending' AND r.expires_at > '-infinity';                              /*EXPIRE:pending*/",
     "     WHERE r.status = 'pending' AND r.expires_at > now();                                    /*EXPIRE:pending*/"),
    ("                                WHERE q.status = 'pending' AND q.expires_at > '-infinity') ELSE 0 END)",
     "                                WHERE q.status = 'pending' AND q.expires_at > now()) ELSE 0 END)"),
]
RB_MUTANT_POST = [
    ("WHERE q.status = 'pending' AND q.expires_at > '-infinity'),", "WHERE q.status = 'pending' AND q.expires_at > now()),"),
]


def body_of(text, sig):
    name = sig.split('.')[1].split('(')[0]
    i = text.index(f'CREATE OR REPLACE FUNCTION public.{name}(')
    b0 = text.index('AS $fn$', i) + len('AS $fn$')
    return text[b0:text.index('$fn$', b0)]


def replace_once(text, old, new, what, show):
    n = text.count(old)
    if n != 1:
        raise SystemExit(f'MUTATION NOT APPLIED {what}: matched {n} times: {old.strip()[:100]!r}')
    if show:
        print(f'MUTATION APPLIED {what}: - {old.strip()[:100]}')
        print(f'                 + {new.strip()[:100]}')
    return text.replace(old, new)


def texts(mode, show):
    tn, rb = rd(T_PATH), rd(RB_PATH)
    if mode == 'mutant':
        pristine_md5 = md5(body_of(tn, EXPIRE_FN))
        for i, (a, b) in enumerate(TN_MUTANT):
            tn = replace_once(tn, a, b, f'tn#{i + 1}', show)
        mutant_md5 = md5(body_of(tn, EXPIRE_FN))
        rb = replace_once(rb, f"('{EXPIRE_FN}', '{pristine_md5}')", f"('{EXPIRE_FN}', '{mutant_md5}')", 'rollback body md5', show)
        for i, (a, b) in enumerate(RB_MUTANT_POST):
            rb = replace_once(rb, a, b, f'rollback post-check#{i + 1}', show)
        if show:
            print(f'MUTATION APPLIED trigger body md5 {pristine_md5} -> {mutant_md5}')
    elif mode != 'pristine':
        raise SystemExit('mode must be pristine or mutant')
    return tn, rb


GUARD = """DO $guard4263n2s$
DECLARE n bigint := 0;
BEGIN
  IF pg_catalog.to_regclass('public.pm_backlog_items') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.pm_backlog_items' INTO n;
  END IF;
  IF n > 100 OR coalesce((SELECT s.n_live_tup FROM pg_catalog.pg_stat_user_tables s WHERE s.relid = pg_catalog.to_regclass('public.pm_backlog_items')), 0) > 100 THEN
    RAISE EXCEPTION 'refuses to run: TEST DATABASE ONLY (production tracker rows present)';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users u WHERE md5(u.id::text) = ('53a38518' || '7695375e2e8695625a20a77a')) THEN   /*REFUSE:hosted*/
    RAISE EXCEPTION 'refuses to run: the hosted test database (its marker is present); this control commits T-N';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE md5(u.id::text) = '__MARKER__') THEN
    RAISE EXCEPTION 'refuses to run: TEST DATABASE ONLY (test database marker absent)';
  END IF;
END
$guard4263n2s$;
"""

# the state every run must leave exactly as it found it (counts and catalogue, never row contents)
BASELINE = """jsonb_build_object(
    'ledger_head', (SELECT max(m.version) FROM supabase_migrations.schema_migrations m),
    'ledger_rows', (SELECT count(*) FROM supabase_migrations.schema_migrations),
    'settings', (SELECT md5(to_jsonb(s)::text) FROM public.mcp_settings s WHERE s.id),
    'notice_version', (SELECT s.notice_version FROM public.mcp_settings s WHERE s.id),
    'tn_objects', (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.oid IN (
                     pg_catalog.to_regprocedure('public._mcp_notice_change_expires_requests()'),
                     pg_catalog.to_regprocedure('public._mcp_connection_version_fixed()'),
                     pg_catalog.to_regprocedure('public.mcp_list_my_connection_access()')))
                  + (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal
                      AND t.tgname IN ('mcp_settings_notice_change_expires_requests', 'mcp_connections_version_fixed')),
    'catalogue', (SELECT md5(coalesce(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, 'default')
                                                 || ':' || pg_catalog.pg_get_userbyid(p.proowner)::text, ';' ORDER BY p.oid::regprocedure::text), ''))
                    FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                     AND (p.proname LIKE 'mcp\\_%' OR p.proname LIKE '\\_mcp\\_%' OR p.proname LIKE 'ai\\_app\\_%')),
    'triggers', (SELECT md5(coalesce(string_agg(t.tgrelid::regclass::text || ':' || t.tgname::text || ':' || t.tgenabled::text, ';'
                                                ORDER BY t.tgrelid::regclass::text, t.tgname::text), ''))
                   FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN (
                     'public.mcp_settings'::regclass, 'public.mcp_connections'::regclass, 'public.mcp_authorization_requests'::regclass)),
    'auth_users', (SELECT count(*) FROM auth.users),
    'mcp_rows', jsonb_build_object(
       'clients', (SELECT count(*) FROM public.mcp_oauth_clients), 'requests', (SELECT count(*) FROM public.mcp_authorization_requests),
       'codes', (SELECT count(*) FROM public.mcp_authorization_codes), 'connections', (SELECT count(*) FROM public.mcp_connections),
       'tokens', (SELECT count(*) FROM public.mcp_tokens), 'call_log', (SELECT count(*) FROM public.mcp_call_log),
       'notices', (SELECT count(*) FROM public.ai_app_connect_notices), 'reads', (SELECT count(*) FROM public.mcp_message_reads)),
    'org_rows', jsonb_build_object('organizations', (SELECT count(*) FROM public.organizations),
       'members', (SELECT count(*) FROM public.organization_members), 'addons', (SELECT count(*) FROM public.member_addons),
       'cloud_settings', (SELECT count(*) FROM public.cloud_autosave_settings), 'public_users', (SELECT count(*) FROM public.users)))"""

# fixture rows that reference the fixture user, per column referencing auth.users (catalogue-driven; counts only)
FK_COUNT = """(SELECT coalesce(sum((xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %s WHERE %I = %L::uuid',
                     c.conrelid::regclass::text, a.attname::text, '__A__'), false, true, '')))[1]::text::bigint), 0)
   FROM pg_catalog.pg_constraint c
   JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
  WHERE c.contype = 'f' AND c.confrelid = 'auth.users'::regclass)"""

PRECHECK = GUARD + """-- /*t:precheck*/ READ ONLY. Proves one call = one transaction (a local setting set, then read in the next statement),
-- read committed, and the start state; refuses (verdict.py) unless it is clean.
SELECT set_config('t4263n2s.probe', 'one', true);
DO $pre$
BEGIN
  RAISE EXCEPTION 'T4263N_PRE %', jsonb_build_object(
    'txn', current_setting('t4263n2s.probe', true), 'iso', current_setting('transaction_isolation'),
    'fixture_by_id', (SELECT count(*) FROM auth.users WHERE id = '__A__'::uuid),
    'fixture_by_pattern', (SELECT count(*) FROM auth.users WHERE email LIKE 'p4263n2s-%@example.test'),
    'fixture_fk_rows', """ + FK_COUNT + """,
    'client_exists', (SELECT count(*) FROM public.mcp_oauth_clients WHERE client_id = '__C__'),
    'pending_requests', (SELECT count(*) FROM public.mcp_authorization_requests WHERE status = 'pending'),
    'connections_v2', (SELECT count(*) FROM public.mcp_connections WHERE notice_version >= 2),
    'enabled', (SELECT s.enabled FROM public.mcp_settings s WHERE s.id),
    'updated_at', (SELECT s.updated_at FROM public.mcp_settings s WHERE s.id)::text,
    'baseline', """ + BASELINE + """);
END
$pre$;
"""

SETUP = GUARD + """-- /*t:setup*/ COMMITS: one user (p4263n2s-__RUN__@example.test), one organization on the team plan with
-- cloud_autosave_assignable on, one membership, the assignment, Keepr Cloud on; mcp_settings.enabled true (the precheck
-- recorded its value and updated_at; teardown.sql puts both back); one registered client with the Claude address; one
-- request in the shape mcp_authorize_begin writes (20261118130000:566-570: scope mcp:read, 180 seconds); then the view
-- as the user, which must answer approval page version 1. Its last statement returns the view's nonce.
SET LOCAL lock_timeout = '3s';
DO $setup$
DECLARE A uuid := '__A__'::uuid; O uuid := '__O__'::uuid; r jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM auth.users u WHERE u.email LIKE 'p4263n2s-%@example.test') THEN
    RAISE EXCEPTION 'another run is in progress or left fixtures behind (p4263n2s-*@example.test): run.sh cleanup';
  END IF;
  SET LOCAL session_replication_role = replica;
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (A, 'p4263n2s-__RUN__@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now());
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
  VALUES (A, 'p4263n2s-__RUN__@example.test', 'email', A::text, 'Fixture n2s') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id, name, slug) VALUES (O, 'Fixture n2s', 'p4263n2s-__RUN__');
  INSERT INTO public.organization_members (id, organization_id, user_id, role, license_status) VALUES ('__M__'::uuid, O, A, 'agent', 'active');
  INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
  VALUES (O, (SELECT id FROM public.plans WHERE tier = 'team' ORDER BY sort_order, name LIMIT 1), '{"cloud_autosave_assignable":{"enabled":true}}');
  SET LOCAL session_replication_role = origin;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  r := public.assign_member_addon(O, A, 'cloud_autosave', true, NULL);
  IF r ->> 'state' IS DISTINCT FROM 'assigned' THEN RAISE EXCEPTION 'assign failed: %', r; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', A, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', A::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  r := public.set_my_cloud_autosave(A, true, 1, NULL);
  IF r ->> 'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'enable failed: %', r; END IF;
  UPDATE public.mcp_settings SET enabled = true WHERE id;
  INSERT INTO public.mcp_oauth_clients (client_id, client_name, redirect_uris, ip_sha256)
  VALUES ('__C__', 'Fixture n2s', ARRAY['https://claude.ai/api/mcp/auth_callback'], sha256(convert_to('p4263n2s-ip-__RUN__', 'UTF8')));
  INSERT INTO public.mcp_authorization_requests (id, client_id, redirect_uri, code_challenge, resource, scope, state, browser_binding_sha256, expires_at)
  VALUES ('__R__', '__C__', 'https://claude.ai/api/mcp/auth_callback', public._mcp_b64url(sha256(convert_to('v' || md5('__RUN__') || md5('__RUN__x'), 'UTF8'))),
          'https://p4263n2s.example.test/api/mcp', 'mcp:read', NULL, sha256(convert_to('p4263n2s-bind-__RUN__', 'UTF8')), now() + interval '180 seconds');
END
$setup$;
SELECT set_config('request.jwt.claims', json_build_object('sub', '__A__', 'role', 'authenticated')::text, true),
       set_config('request.jwt.claim.sub', '__A__', true), set_config('request.jwt.claim.role', 'authenticated', true);
SELECT jsonb_build_object('k', 'setup', 'view', public.mcp_authorize_view('__R__', sha256(convert_to('p4263n2s-bind-__RUN__', 'UTF8'))))::text;
"""

SESSION2 = GUARD + """-- /*t:session2*/ ROLLS BACK (ends in RAISE). Starts its transaction BEFORE session 1, waits until session 1 holds
-- T-N's lock (it sleeps in a statement carrying this run's marker), then approves the request viewed at version 1.
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '60s';
DO $s2$
DECLARE t0 timestamptz := now(); c0 timestamptz := clock_timestamp(); c1 timestamptz; c2 timestamptz; i integer := 0; ap jsonb;
        stamped integer; holder integer;
BEGIN
  LOOP
    PERFORM pg_catalog.pg_stat_clear_snapshot();
    SELECT a.pid INTO holder FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_locks l ON l.pid = a.pid
     WHERE a.pid <> pg_catalog.pg_backend_pid() AND a.wait_event = 'PgSleep'
       AND a.query LIKE '%p_hold:' || '__RUN__' || '%'
       AND l.locktype = 'relation' AND l.relation = 'public.mcp_authorization_requests'::regclass
       AND l.mode = 'ExclusiveLock' AND l.granted
     LIMIT 1;
    EXIT WHEN holder IS NOT NULL;
    i := i + 1;
    IF i > 200 THEN RAISE EXCEPTION 'T4263N_GATE_TIMEOUT: session 1 not seen holding the lock within 20 s'; END IF;
    PERFORM pg_sleep(0.1);
  END LOOP;
  c1 := clock_timestamp();
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '__A__', 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '__A__', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  ap := public.mcp_authorize_approve('__R__', sha256(convert_to('p4263n2s-bind-__RUN__', 'UTF8')), '__NONCE__',
                                     sha256(convert_to('p4263n2s-code-__RUN__', 'UTF8')));
  c2 := clock_timestamp();
  SELECT c.notice_version INTO stamped FROM public.mcp_authorization_codes x JOIN public.mcp_connections c ON c.id = x.connection_id
   WHERE x.code_sha256 = sha256(sha256(convert_to('p4263n2s-code-__RUN__', 'UTF8')));
  RAISE EXCEPTION 'T4263N_S2 %', jsonb_build_object('txn_start', t0, 'clock_start', c0, 'gate_passed', c1, 'approve_done', c2,
    'holder_pid', holder, 'approve', ap, 'stamped', stamped,
    'v2_connections_of_user', (SELECT count(*) FROM public.mcp_connections WHERE user_id = '__A__'::uuid AND notice_version >= 2));
END
$s2$;
"""


def session1(tn):
    return ("/*p_hold:__RUN__*/\n" + GUARD + """-- /*t:session1*/ COMMITS T-N (the apply file: the migration text, then its ledger row), holding its locks for 6 s
-- after the bump in a statement that carries this run's marker.
SELECT jsonb_build_object('k', 's1_start', 'txn_start', now(), 'clock', clock_timestamp())::text;
""" + tn + f"""
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES ('{T_VERSION}', '{T_LEDGER}', ARRAY[]::text[]);
SELECT jsonb_build_object('k', 's1_hold', 'clock', clock_timestamp(),
                          'holds_lock', EXISTS (SELECT 1 FROM pg_catalog.pg_locks l WHERE l.pid = pg_catalog.pg_backend_pid()
                                                 AND l.relation = 'public.mcp_authorization_requests'::regclass AND l.mode = 'ExclusiveLock'))::text;
SELECT 'p_hold:__RUN__' AS marker, pg_sleep(6);
SELECT jsonb_build_object('k', 's1_end', 'clock', clock_timestamp())::text;
""")


STATE = GUARD + """-- /*t:state*/ READ ONLY (ends in RAISE): what the two sessions left.
DO $st$
BEGIN
  RAISE EXCEPTION 'T4263N_STATE %', jsonb_build_object(
    'ledger_tn', (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '""" + T_VERSION + """'),
    'notice_version', (SELECT s.notice_version FROM public.mcp_settings s WHERE s.id),
    'request_status', (SELECT r.status FROM public.mcp_authorization_requests r WHERE r.id = '__R__'),
    'request_expires', (SELECT r.expires_at::text FROM public.mcp_authorization_requests r WHERE r.id = '__R__'),
    'connections_of_user', (SELECT count(*) FROM public.mcp_connections WHERE user_id = '__A__'::uuid),
    'codes_of_request', (SELECT count(*) FROM public.mcp_authorization_codes WHERE client_id = '__C__'));
END
$st$;
"""


def rollback(rb):
    return GUARD + "-- /*t:rollback*/ COMMITS the rollback file.\n" + rb


TEARDOWN = GUARD + """-- /*t:teardown*/ COMMITS. Removes exactly this run's rows: the client (its requests, codes and connections go with it),
-- then the fixture user's rows, keyed on the fixture id AND this run's email and slug; puts mcp_settings.enabled and
-- updated_at back to the values the precheck read, only once T-N is rolled back (version 1, no T-N function).
SET LOCAL lock_timeout = '3s';
DO $td$
DECLARE A uuid := '__A__'::uuid; v_org uuid[];
BEGIN
  DELETE FROM public.mcp_oauth_clients WHERE client_id = '__C__' AND client_name = 'Fixture n2s';
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = A AND email = 'p4263n2s-__RUN__@example.test') THEN
    SELECT coalesce(array_agg(o.id), '{}') INTO v_org FROM public.organizations o
     WHERE o.slug = 'p4263n2s-__RUN__' AND o.id IN (SELECT m.organization_id FROM public.organization_members m WHERE m.user_id = A);
    DELETE FROM public.cloud_autosave_settings WHERE user_id = A;
    DELETE FROM public.member_addons WHERE user_id = A;
    SET LOCAL session_replication_role = replica;
    DELETE FROM public.organization_members WHERE user_id = A AND organization_id = ANY (v_org);
    DELETE FROM public.organization_plans WHERE organization_id = ANY (v_org);
    DELETE FROM public.organizations WHERE id = ANY (v_org);
    DELETE FROM public.users WHERE id = A AND email = 'p4263n2s-__RUN__@example.test';
    SET LOCAL session_replication_role = origin;
    DELETE FROM auth.users WHERE id = A AND email = 'p4263n2s-__RUN__@example.test';
  END IF;
  IF pg_catalog.to_regprocedure('public.mcp_list_my_connection_access()') IS NULL
     AND (SELECT s.notice_version FROM public.mcp_settings s WHERE s.id) = 1 THEN
    UPDATE public.mcp_settings SET enabled = __ENABLED__, updated_at = '__UPDATED_AT__'::timestamptz WHERE id;
  END IF;
END
$td$;
"""

VERIFY = GUARD + """-- /*t:verify*/ READ ONLY (ends in RAISE): the state compared with the precheck's baseline.
DO $vf$
BEGIN
  RAISE EXCEPTION 'T4263N_VERIFY %', jsonb_build_object(
    'fixture_by_id', (SELECT count(*) FROM auth.users WHERE id = '__A__'::uuid),
    'fixture_fk_rows', """ + FK_COUNT + """,
    'client_exists', (SELECT count(*) FROM public.mcp_oauth_clients WHERE client_id = '__C__'),
    'baseline', """ + BASELINE + """);
END
$vf$;
"""

PROBE = GUARD + """-- /*t:probe*/ READ ONLY (ends in RAISE): is T-N applied, and at which trigger body (for the trap).
DO $pr$
BEGIN
  RAISE EXCEPTION 'T4263N_PROBE %', jsonb_build_object(
    'ledger_tn', (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '""" + T_VERSION + """'),
    'expire_md5', (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('""" + EXPIRE_FN + """')));
END
$pr$;
"""


# the trap's statistics reset: one more call, so the guard is first in it like in every other call
RESET = GUARD + """-- the trap's pg_stat_statements reset (writes no row)
select extensions.pg_stat_statements_reset();
"""


def fill(text, vals):
    for k, v in vals.items():
        text = text.replace(f'__{k}__', v)
    return text


def compose(outdir, mode, run, a, o, m, c, r, show=True, marker=None):
    marker = marker if marker is not None else os.environ.get('T4263N_MARKER_MD5', '')
    if not MARKER_RE.fullmatch(marker):
        raise SystemExit('T4263N_MARKER_MD5 must be the md5 (32 lowercase hex) of the dry-run database marker id; there is no default')
    if marker == HOSTED_MARKER:
        raise SystemExit('refusing: T4263N_MARKER_MD5 is the hosted test database marker; this control commits T-N')
    if not re.fullmatch(r'[0-9a-f]{16}', run):
        raise SystemExit('run id: 16 lowercase hex characters')
    for x in (a, o, m):
        if not UUID_RE.fullmatch(x) or len(set(x.replace('-', ''))) == 1:
            raise SystemExit(f'not a fresh lowercase uuid: {x}')
    if not re.fullmatch(r'kpr_c_[A-Za-z0-9_-]{22}', c) or not re.fullmatch(r'[A-Za-z0-9_-]{22}', r):
        raise SystemExit('client id kpr_c_ + 22, request id 22 characters of [A-Za-z0-9_-]')
    tn, rb = texts(mode, show)
    other_tn, other_rb = texts('mutant' if mode == 'pristine' else 'pristine', False)
    vals = {'RUN': run, 'A': a, 'O': o, 'M': m, 'C': c, 'R': r, 'MARKER': marker}
    files = {'precheck.sql': PRECHECK, 'setup.sql': SETUP, 'session2.tpl': SESSION2, 'session1.sql': session1(tn),
             'state.sql': STATE, 'rollback.sql': rollback(rb), 'rollback-other.sql': rollback(other_rb),
             'teardown.tpl': TEARDOWN, 'verify.sql': VERIFY, 'probe.sql': PROBE, 'reset.sql': RESET}
    os.makedirs(outdir, exist_ok=True)
    for name, text in files.items():
        out = fill(text, vals)
        assert out.count('refuses to run: TEST DATABASE ONLY (test database marker absent)') == 1, name
        assert out.count(marker) == 1, name
        assert out.count("md5(u.id::text) = ('53a38518' || '7695375e2e8695625a20a77a')") == 1 and HOSTED_MARKER not in out, name
        assert re.search(r'__[A-Z_]+__', out) is None or name.endswith('.tpl'), (name, re.findall(r'__[A-Z_]+__', out))
        open(os.path.join(outdir, name), 'w', encoding='utf-8').write(out)
    open(os.path.join(outdir, 'md5s.txt'), 'w').write(
        f"mode {mode}\nexpire_md5_this {md5(body_of(tn, EXPIRE_FN))}\nexpire_md5_other {md5(body_of(other_tn, EXPIRE_FN))}\n")
    return files


def main(argv):
    if argv[:1] == ['--check']:
        d = tempfile.mkdtemp()
        for mode in ('pristine', 'mutant'):
            compose(os.path.join(d, mode), mode, '0123456789abcdef', '11111111-2222-4333-8444-555555555555',
                    '21111111-2222-4333-8444-555555555555', '31111111-2222-4333-8444-555555555555',
                    'kpr_c_' + 'A' * 22, 'B' * 22, show=(mode == 'mutant'), marker=md5('offline-check-marker'))
        print(d)
        return 0
    if len(argv) != 8:
        print(__doc__)
        return 2
    compose(*argv)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
