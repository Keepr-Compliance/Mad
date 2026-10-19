#!/usr/bin/env python3
"""BACKLOG-3998 DB harness composer.

Writes, next to this file (all self-rolled-back: each ends with RAISE EXCEPTION carrying
the report, so nothing persists):
  controls-<n>.sql  helpers + a batch of at most 15 controls run against the LIVE
                    functions (the migration must already be applied).
  mutants-<n>.sql   helpers; the controls named by each mutant are first run on the
                    live code (BASE), then each mutant is applied inside its own
                    subtransaction and the same controls run again. A body mutant is an
                    exact-once anchor replace of the live definition, and its md5(prosrc)
                    must change; a state mutant (grant, SECURITY DEFINER, trigger, policy)
                    must change the state its probe query reads. The report prints
                    MUTATION APPLIED with before/after, then which controls went red.
  c14-rollback-reapply.sql  rollback.sql, then the migration, then the md5 read-back.

Every body-mutant anchor is checked offline against the migration's function bodies
first: exactly one occurrence, or this script exits non-zero.

Fixtures: synthetic accounts '<tag>-3998-<n>@example.test' (test naming only).
Run each file on keepr-test (xiaobikzagpyubjcrcpb) through execute_sql and read the
report in the error text.
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MIGS = HERE.parents[1] / 'migrations'
MIG = MIGS / '20261016070000_backlog_3998_users_email_from_auth.sql'
MIG_TEXT = MIG.read_text()
G3991_TEXT = (MIGS / '20261019050000_backlog_3991_idp_names_and_member_name_edit.sql').read_text()
ROLLBACK = (HERE / 'rollback.sql').read_text()

SIGS = {
    'email': 'public.users_email_from_auth()',
    'guard': 'public.users_client_write_guard()',
    'pair': 'public.users_own_oauth_pair()',
    'lookup': 'public.user_id_for_auth_email(text)',
    'hnu': 'public.handle_new_user()',
    'aaiu': 'public.admin_add_internal_user(text,text)',
    'sync': 'public.sync_email_from_auth()',
}
NAMES = {k: v.split('.')[1].split('(')[0] for k, v in SIGS.items()}


def body(key: str) -> str:
    m = re.findall(r'CREATE OR REPLACE FUNCTION public\.' + NAMES[key] + r'\(.*?AS \$function\$(.*?)\$function\$', MIG_TEXT, re.S)
    assert len(m) == 1, key
    return m[0]


GUARD_3991 = re.search(r'(DO \$pre\$.*?END \$pre\$;)', G3991_TEXT, re.S).group(1)
BACKFILL = re.search(r'(UPDATE public\.users u\n   SET email = u\.email\n.*?;)\s*$', MIG_TEXT, re.S).group(1)


def q(s: str) -> str:
    tag = 'q'
    while f'${tag}$' in s:
        tag += 'q'
    return f'${tag}${s}${tag}$'


HELPERS = r"""
CREATE FUNCTION pg_temp.res(ok boolean, nm text, det text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN COALESCE(ok, false) THEN 'PASS' ELSE 'FAIL' END || '|' || nm || '|' || COALESCE(det, '') $f$;
-- Identity switches: client (authenticated, JWT sub), anon, service_role, back to postgres.
CREATE FUNCTION pg_temp.asu(p uuid) RETURNS void LANGUAGE sql AS $f$
  SELECT set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
  SELECT set_config('role', 'authenticated', true) $f$;
CREATE FUNCTION pg_temp.asanon() RETURNS void LANGUAGE sql AS $f$
  SELECT set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  SELECT set_config('role', 'anon', true) $f$;
CREATE FUNCTION pg_temp.assvc() RETURNS void LANGUAGE sql AS $f$
  SELECT set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  SELECT set_config('role', 'service_role', true) $f$;
CREATE FUNCTION pg_temp.pg() RETURNS void LANGUAGE sql AS $f$
  SELECT set_config('role', 'postgres', true); SELECT set_config('request.jwt.claims', '', true) $f$;
-- A synthetic sign-up: auth.users insert (handle_new_user writes the public.users row).
CREATE FUNCTION pg_temp.mk(p_email text, p_app jsonb DEFAULT '{"provider":"azure","providers":["azure"]}',
                           p_meta jsonb DEFAULT '{}', p_sso boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql AS $f$
DECLARE v uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data, raw_app_meta_data, is_sso_user)
  VALUES (v, p_email, 'authenticated', 'authenticated', p_meta, p_app, p_sso);
  RETURN v;
END $f$;
CREATE FUNCTION pg_temp.mkid(p_uid uuid, p_provider text, p_pid text, p_at timestamptz DEFAULT now()) RETURNS void
LANGUAGE sql AS $f$
  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  VALUES (p_pid, p_uid, jsonb_build_object('sub', p_pid), p_provider, p_at, p_at) $f$;
-- A public.users row with no auth.users record (SCIM / directory-sync shape).
CREATE FUNCTION pg_temp.noauth(p_email text) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, provisioning_source, is_managed)
  VALUES (v, p_email, 'azure', 'ext-' || v, 'scim', true);
  RETURN v;
END $f$;
-- Write a value with triggers off (models a value stored before this migration).
CREATE FUNCTION pg_temp.raw_email(p_id uuid, p_email text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('session_replication_role', 'replica', true);
  UPDATE public.users SET email = p_email WHERE id = p_id;
  PERFORM set_config('session_replication_role', 'origin', true);
END $f$;
CREATE FUNCTION pg_temp.ae(p_id uuid) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT lower(btrim(email)) FROM auth.users WHERE id = p_id $f$;
CREATE FUNCTION pg_temp.pe(p_id uuid) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT email FROM public.users WHERE id = p_id $f$;
-- An internal-role caller for admin_add_internal_user.
CREATE FUNCTION pg_temp.internal(p_tag text) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v uuid := pg_temp.mk(p_tag || '-3998-int@example.test');
BEGIN
  INSERT INTO public.internal_roles (user_id, role_id, created_by)
  SELECT v, r.id, v FROM public.admin_roles r WHERE r.slug = 'super-admin';
  RETURN v;
END $f$;
CREATE FUNCTION pg_temp.trial_ok(t timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $f$
  SELECT t BETWEEN now() + interval '14 days' - interval '1 minute' AND now() + interval '14 days' + interval '1 minute' $f$;
-- The 17 reset columns, as text, for comparisons.
CREATE FUNCTION pg_temp.prot(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $f$
  SELECT jsonb_build_object(
    'status', status, 'suspended_at', suspended_at, 'suspension_reason', suspension_reason,
    'is_active', is_active, 'subscription_tier', subscription_tier,
    'subscription_status', subscription_status, 'subscription_started_at', subscription_started_at,
    'trial_ends_at_ok', pg_temp.trial_ok(trial_ends_at),
    'provisioning_source', provisioning_source, 'scim_external_id', scim_external_id,
    'is_managed', is_managed, 'sso_only', sso_only, 'last_sso_login_at', last_sso_login_at,
    'last_sso_provider', last_sso_provider, 'jit_provisioned', jit_provisioned,
    'jit_provisioned_at', jit_provisioned_at, 'idp_claims', idp_claims)
  FROM public.users WHERE id = p_id $f$;
CREATE FUNCTION pg_temp.prot_default() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
  SELECT jsonb_build_object(
    'status', 'active', 'suspended_at', null, 'suspension_reason', null, 'is_active', true,
    'subscription_tier', 'free', 'subscription_status', 'trial', 'subscription_started_at', null,
    'trial_ends_at_ok', true, 'provisioning_source', 'manual', 'scim_external_id', null,
    'is_managed', false, 'sso_only', false, 'last_sso_login_at', null, 'last_sso_provider', null,
    'jit_provisioned', false, 'jit_provisioned_at', null, 'idp_claims', null) $f$;
CREATE FUNCTION pg_temp.jdiff(a jsonb, b jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT COALESCE(string_agg(k, ',' ORDER BY k), '') FROM jsonb_object_keys(a || b) k
   WHERE (a -> k) IS DISTINCT FROM (b -> k) $f$;
"""

# --------------------------------------------------------------------------- controls
# Each control: (id, name, plpgsql body). The body declares nothing (use the DECLARE
# list below) and ends with `r := pg_temp.res(...)`. It runs as postgres; it switches
# identity itself and always switches back (pg_temp.pg()) before reading.
DECL = """  a uuid; b uuid; c uuid; i uuid; n uuid; x uuid; y uuid;
  t text; t2 text; e text; st text; ok boolean; j jsonb; j2 jsonb; k int;"""

C = []


def ctl(cid, name, sql):
    C.append((cid, name, sql))


ctl('C1', 'client sets own email -> stored value is the auth email', r"""
  a := pg_temp.mk('c1-3998-a@example.test');
  PERFORM pg_temp.asu(a);
  UPDATE public.users SET email = 'c1-3998-madeup@example.test' WHERE id = a;
  PERFORM pg_temp.pg();
  r := pg_temp.res(pg_temp.pe(a) = pg_temp.ae(a), 'C1 ' || cname, pg_temp.pe(a));
""")

ctl('C2', 'admin_add_internal_user by a stored public value finds no one (P0002)', r"""
  i := pg_temp.internal('c2');
  a := pg_temp.mk('c2-3998-a@example.test');
  PERFORM pg_temp.raw_email(a, 'c2-3998-probe@example.test');
  PERFORM pg_temp.asu(i);
  BEGIN
    PERFORM public.admin_add_internal_user('c2-3998-probe@example.test', 'support_agent');
    st := 'no error';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE;
  END;
  PERFORM pg_temp.pg();
  ok := st = 'P0002' AND NOT EXISTS (SELECT 1 FROM public.internal_roles WHERE user_id = a);
  r := pg_temp.res(ok, 'C2 ' || cname, st);
""")

ctl('C2b', 'admin_add_internal_user by the auth email grants the role', r"""
  i := pg_temp.internal('c2b');
  a := pg_temp.mk('c2b-3998-a@example.test');
  PERFORM pg_temp.asu(i);
  BEGIN
    PERFORM public.admin_add_internal_user('c2b-3998-a@example.test', 'support_agent');
    st := 'ok';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE || ' ' || SQLERRM;
  END;
  PERFORM pg_temp.pg();
  ok := st = 'ok' AND EXISTS (SELECT 1 FROM public.internal_roles WHERE user_id = a);
  r := pg_temp.res(ok, 'C2b ' || cname, st);
""")

ctl('C5', 'sign-up whose address an auth-backed row holds: sign-up ok, row kept, new row placeholder', r"""
  a := pg_temp.mk('c5-3998-a@example.test');
  PERFORM pg_temp.raw_email(a, 'c5-3998-probe@example.test');
  BEGIN
    x := pg_temp.mk('c5-3998-probe@example.test');
    st := 'ok';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE || ' ' || SQLERRM;
  END;
  ok := st = 'ok' AND pg_temp.pe(a) = 'c5-3998-probe@example.test'
        AND pg_temp.pe(x) = x::text || '@unknown.local';
  r := pg_temp.res(ok, 'C5 ' || cname, st || ' a=' || COALESCE(pg_temp.pe(a), 'GONE') || ' x=' || COALESCE(pg_temp.pe(x), 'none'));
""")

ctl('C4', 'desktop-shaped update and insert as the client succeed and store the auth email', r"""
  a := pg_temp.mk('c4-3998-a@example.test');
  b := pg_temp.mk('c4-3998-b@example.test');
  DELETE FROM public.users WHERE id = b;
  PERFORM pg_temp.asu(a);
  BEGIN
    UPDATE public.users SET email = 'c4-3998-mailbox@example.test', first_name = 'F', last_name = 'L',
           display_name = 'D', avatar_url = NULL, last_login_at = now(), updated_at = now()
     WHERE id = a RETURNING email INTO t;
    st := 'upd ok';
  EXCEPTION WHEN OTHERS THEN st := 'upd ' || SQLSTATE || ' ' || SQLERRM;
  END;
  PERFORM pg_temp.asu(b);
  BEGIN
    INSERT INTO public.users (id, email, first_name, last_name, display_name, avatar_url, oauth_provider,
           oauth_id, subscription_tier, subscription_status, trial_ends_at, login_count, last_login_at, signup_source)
    VALUES (b, 'c4-3998-mailbox2@example.test', 'F', 'L', 'D', NULL, 'azure', 'c4-3998-sub', 'free', 'trial',
            now() + interval '14 days', 1, now(), 'desktop_app')
    RETURNING email INTO t2;
    st := st || '; ins ok';
  EXCEPTION WHEN OTHERS THEN st := st || '; ins ' || SQLSTATE || ' ' || SQLERRM;
  END;
  PERFORM pg_temp.pg();
  ok := st = 'upd ok; ins ok' AND t = pg_temp.ae(a) AND t2 = pg_temp.ae(b)
        AND pg_temp.pe(a) = pg_temp.ae(a) AND pg_temp.pe(b) = pg_temp.ae(b);
  r := pg_temp.res(ok, 'C4 ' || cname, st);
""")

ctl('C6', 'update from inside a SECURITY DEFINER function is rewritten too', r"""
  a := pg_temp.mk('c6-3998-a@example.test');
  EXECUTE $d$CREATE FUNCTION pg_temp.c6_definer() RETURNS void LANGUAGE sql SECURITY DEFINER AS
    'UPDATE public.users SET email = ''c6-3998-meta@example.test'' WHERE id = auth.uid()'$d$;
  PERFORM pg_temp.asu(a);
  PERFORM pg_temp.c6_definer();
  PERFORM pg_temp.pg();
  r := pg_temp.res(pg_temp.pe(a) = pg_temp.ae(a), 'C6 ' || cname, pg_temp.pe(a));
""")

ctl('C7', 'row with no auth.users record keeps the written email on insert and update', r"""
  n := pg_temp.noauth('C7-3998-Mixed@Example.test');
  t := pg_temp.pe(n);
  UPDATE public.users SET email = 'C7-3998-Second@Example.test' WHERE id = n;
  ok := t = 'C7-3998-Mixed@Example.test' AND pg_temp.pe(n) = 'C7-3998-Second@Example.test';
  r := pg_temp.res(ok, 'C7 ' || cname, t || ' / ' || pg_temp.pe(n));
""")

ctl('C8', 'admin_add_internal_user matches the auth email case-insensitively', r"""
  i := pg_temp.internal('c8');
  a := pg_temp.mk('c8-3998-a@example.test');
  PERFORM pg_temp.asu(i);
  BEGIN
    PERFORM public.admin_add_internal_user('  C8-3998-A@Example.TEST ', 'support_agent');
    st := 'ok';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE || ' ' || SQLERRM;
  END;
  PERFORM pg_temp.pg();
  ok := st = 'ok' AND EXISTS (SELECT 1 FROM public.internal_roles WHERE user_id = a);
  r := pg_temp.res(ok, 'C8 ' || cname, st);
""")

ctl('C11', 'user_id_for_auth_email refused to authenticated and anon (42501)', r"""
  a := pg_temp.mk('c11-3998-a@example.test');
  PERFORM pg_temp.asu(a);
  BEGIN PERFORM public.user_id_for_auth_email('c11-3998-a@example.test'); st := 'auth:allowed';
  EXCEPTION WHEN OTHERS THEN st := 'auth:' || SQLSTATE; END;
  PERFORM pg_temp.asanon();
  BEGIN PERFORM public.user_id_for_auth_email('c11-3998-a@example.test'); st := st || ' anon:allowed';
  EXCEPTION WHEN OTHERS THEN st := st || ' anon:' || SQLSTATE; END;
  PERFORM pg_temp.pg();
  r := pg_temp.res(st = 'auth:42501 anon:42501', 'C11 ' || cname, st);
""")

ctl('C11b', 'user_id_for_auth_email (service_role): auth match, unclaimed fallback, stored value ignored', r"""
  a := pg_temp.mk('c11b-3998-a@example.test');
  b := pg_temp.mk('c11b-3998-b@example.test');
  PERFORM pg_temp.raw_email(b, 'c11b-3998-probe@example.test');
  n := pg_temp.noauth('C11b-3998-Unclaimed@Example.test');
  PERFORM pg_temp.assvc();
  x := public.user_id_for_auth_email(' C11B-3998-A@example.test');
  y := public.user_id_for_auth_email('c11b-3998-unclaimed@example.test');
  c := public.user_id_for_auth_email('c11b-3998-probe@example.test');
  i := public.user_id_for_auth_email('c11b-3998-nobody@example.test');
  PERFORM pg_temp.pg();
  ok := x = a AND y = n AND c IS NULL AND i IS NULL;
  r := pg_temp.res(ok, 'C11b ' || cname, format('auth=%s unclaimed=%s probe=%s nobody=%s', x = a, y = n, c, i));
""")

ctl('C12', '3991 pre-check (as merged in this branch) passes against the installed handle_new_user', r"""
  BEGIN
    EXECUTE """ + q(GUARD_3991) + r""";
    st := 'ok';
  EXCEPTION WHEN OTHERS THEN st := SQLERRM;
  END;
  r := pg_temp.res(st = 'ok', 'C12 ' || cname, st);
""")

ctl('C13', 'auth email change reaches public.users (lowercased)', r"""
  a := pg_temp.mk('c13-3998-a@example.test');
  UPDATE auth.users SET email = 'C13-3998-New@Example.test' WHERE id = a;
  r := pg_temp.res(pg_temp.pe(a) = 'c13-3998-new@example.test', 'C13 ' || cname, pg_temp.pe(a));
""")

ctl('C13b', 'auth email change commits when the public.users update fails', r"""
  a := pg_temp.mk('c13b-3998-a@example.test');
  EXECUTE format($d$CREATE FUNCTION pg_temp.c13b_fail() RETURNS trigger LANGUAGE plpgsql AS
    'BEGIN IF NEW.id::text = ''%s'' THEN RAISE EXCEPTION ''c13b forced failure''; END IF; RETURN NEW; END'$d$, a);
  CREATE TRIGGER c13b_fail BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION pg_temp.c13b_fail();
  BEGIN
    UPDATE auth.users SET email = 'c13b-3998-new@example.test' WHERE id = a;
    st := 'ok';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE || ' ' || SQLERRM;
  END;
  DROP TRIGGER c13b_fail ON public.users;
  ok := st = 'ok' AND pg_temp.ae(a) = 'c13b-3998-new@example.test' AND pg_temp.pe(a) = 'c13b-3998-a@example.test';
  r := pg_temp.res(ok, 'C13b ' || cname, st);
""")

ctl('C15', 'client cannot move its row to another id (42501)', r"""
  a := pg_temp.mk('c15-3998-a@example.test');
  x := gen_random_uuid();
  PERFORM pg_temp.asu(a);
  BEGIN
    UPDATE public.users SET id = x, email = 'c15-3998-client@example.test' WHERE id = a;
    st := 'moved';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE;
  END;
  PERFORM pg_temp.pg();
  ok := st = '42501' AND pg_temp.pe(a) IS NOT NULL AND pg_temp.pe(x) IS NULL;
  r := pg_temp.res(ok, 'C15 ' || cname, st || ' moved_row_email=' || COALESCE(pg_temp.pe(x), 'none'));
""")

ctl('C16', 'sign-up whose (provider, oauth_id) another account holds: ok, holder kept, new row uses its id', r"""
  a := pg_temp.mk('c16-3998-a@example.test');
  UPDATE public.users SET oauth_provider = 'azure', oauth_id = 'c16-3998-sub' WHERE id = a;
  BEGIN
    x := pg_temp.mk('c16-3998-x@example.test', '{"provider":"azure"}', '{"provider_id":"c16-3998-sub"}');
    st := 'ok';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE || ' ' || SQLERRM;
  END;
  ok := st = 'ok'
    AND (SELECT oauth_id FROM public.users WHERE id = a) = 'c16-3998-sub'
    AND (SELECT oauth_provider || ':' || oauth_id FROM public.users WHERE id = x) = 'azure:' || x::text;
  r := pg_temp.res(ok, 'C16 ' || cname, st);
""")

ctl('C16b', 'ordinary sign-up keeps the provider pair from the sign-up metadata', r"""
  x := pg_temp.mk('C16b-3998-X@Example.test', '{"provider":"google"}', '{"sub":"c16b-3998-sub","full_name":"N"}');
  ok := (SELECT oauth_provider || ':' || oauth_id || ':' || email FROM public.users WHERE id = x)
        = 'google:c16b-3998-sub:c16b-3998-x@example.test';
  r := pg_temp.res(ok, 'C16b ' || cname, (SELECT oauth_provider || ':' || oauth_id || ':' || email FROM public.users WHERE id = x));
""")

ctl('C17', 'client update of its own oauth_provider/oauth_id keeps the stored pair (no error)', r"""
  a := pg_temp.mk('c17-3998-a@example.test', '{"provider":"azure"}', '{"provider_id":"c17-3998-sub"}');
  PERFORM pg_temp.asu(a);
  BEGIN
    UPDATE public.users SET oauth_provider = 'google', oauth_id = 'c17-3998-other' WHERE id = a;
    INSERT INTO public.users (id, email, oauth_provider, oauth_id)
    VALUES (a, 'c17-3998-a@example.test', 'google', 'c17-3998-other2')
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, oauth_provider = EXCLUDED.oauth_provider,
                                   oauth_id = EXCLUDED.oauth_id;
    st := 'ok';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE || ' ' || SQLERRM;
  END;
  PERFORM pg_temp.pg();
  t := (SELECT oauth_provider || ':' || oauth_id FROM public.users WHERE id = a);
  r := pg_temp.res(st = 'ok' AND t = 'azure:c17-3998-sub', 'C17 ' || cname, st || ' ' || t);
""")

ctl('C18', 'client insert of its own row: reset columns at defaults, pair from auth.identities', r"""
  b := pg_temp.mk('c18-3998-b@example.test');
  PERFORM pg_temp.mkid(b, 'google', 'c18-3998-gsub');
  DELETE FROM public.users WHERE id = b;
  PERFORM pg_temp.asu(b);
  BEGIN
    INSERT INTO public.users (id, email, oauth_provider, oauth_id, status, suspended_at, suspension_reason,
      is_active, subscription_tier, subscription_status, subscription_started_at, trial_ends_at,
      provisioning_source, scim_external_id, is_managed, sso_only, last_sso_login_at, last_sso_provider,
      jit_provisioned, jit_provisioned_at, idp_claims)
    VALUES (b, 'c18-3998-b@example.test', 'azure', 'c18-3998-chosen', 'suspended', now(), 'x',
      false, 'enterprise', 'active', now(), now() + interval '10 years',
      'scim', 'c18-ext', true, true, now(), 'azure', true, now(), '{"a":1}');
    st := 'ok';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE || ' ' || SQLERRM;
  END;
  PERFORM pg_temp.pg();
  j := pg_temp.prot(b);
  t := (SELECT oauth_provider || ':' || oauth_id FROM public.users WHERE id = b);
  ok := st = 'ok' AND j = pg_temp.prot_default() AND t = 'google:c18-3998-gsub';
  r := pg_temp.res(ok, 'C18 ' || cname, st || ' differs=[' || COALESCE(pg_temp.jdiff(j, pg_temp.prot_default()), '?') || '] pair=' || COALESCE(t, 'none'));
""")

ctl('C18b', 'client insert whose identity pair another row holds: oauth_id is its own id', r"""
  a := pg_temp.mk('c18b-3998-a@example.test');
  UPDATE public.users SET oauth_provider = 'google', oauth_id = 'c18b-3998-gsub' WHERE id = a;
  b := pg_temp.mk('c18b-3998-b@example.test');
  PERFORM pg_temp.mkid(b, 'google', 'c18b-3998-gsub');
  DELETE FROM public.users WHERE id = b;
  PERFORM pg_temp.asu(b);
  BEGIN
    INSERT INTO public.users (id, email, oauth_provider, oauth_id) VALUES (b, 'x', 'google', 'c18b-3998-gsub');
    st := 'ok';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE || ' ' || SQLERRM;
  END;
  PERFORM pg_temp.pg();
  t := (SELECT oauth_provider || ':' || oauth_id FROM public.users WHERE id = b);
  r := pg_temp.res(st = 'ok' AND t = 'google:' || b::text, 'C18b ' || cname, st || ' ' || COALESCE(t, 'none'));
""")

ctl('C19', 'server writers keep the columns they set (service_role insert; definer insert called by a client)', r"""
  PERFORM pg_temp.assvc();
  x := gen_random_uuid();
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, status, provisioning_source, scim_external_id,
    is_managed, sso_only, jit_provisioned, subscription_tier)
  VALUES (x, 'c19-3998-svc@example.test', 'azure', 'c19-3998-ext', 'suspended', 'scim', 'c19-ext',
    true, true, true, 'enterprise');
  PERFORM pg_temp.pg();
  a := pg_temp.mk('c19-3998-a@example.test');
  EXECUTE $d$CREATE FUNCTION pg_temp.c19_definer(p uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS
    'INSERT INTO public.users (id, email, oauth_provider, oauth_id, status, provisioning_source, is_managed, jit_provisioned)
     VALUES (p, ''c19-3998-def@example.test'', ''google'', ''c19-3998-def'', ''suspended'', ''jit'', true, true)'$d$;
  y := gen_random_uuid();
  PERFORM pg_temp.asu(a);
  PERFORM pg_temp.c19_definer(y);
  PERFORM pg_temp.pg();
  t := (SELECT concat_ws(',', status, provisioning_source, scim_external_id, is_managed, sso_only, jit_provisioned, subscription_tier, oauth_id)
          FROM public.users WHERE id = x);
  t2 := (SELECT concat_ws(',', status, provisioning_source, is_managed, jit_provisioned, oauth_id) FROM public.users WHERE id = y);
  ok := t = 'suspended,scim,c19-ext,true,true,true,enterprise,c19-3998-ext'
    AND t2 = 'suspended,jit,true,true,c19-3998-def';
  r := pg_temp.res(ok, 'C19 ' || cname, t || ' | ' || t2);
""")

ctl('C20', 'reset values equal the column defaults (pg_attrdef)', r"""
  x := gen_random_uuid();
  INSERT INTO public.users (id, email, oauth_provider, oauth_id) VALUES (x, 'c20-3998-dflt@example.test', 'email', x::text);
  j := pg_temp.prot(x);
  r := pg_temp.res(j = pg_temp.prot_default(), 'C20 ' || cname, 'differs=[' || pg_temp.jdiff(j, pg_temp.prot_default()) || ']');
""")

ctl('C21', 'two auth accounts with one address (one SSO): lookup NULL, admin_add_internal_user refuses (not P0002)', r"""
  i := pg_temp.internal('c21');
  a := pg_temp.mk('c21-3998-a@example.test');
  b := pg_temp.mk('c21-3998-a@example.test', '{"provider":"sso:x"}', '{}', true);
  PERFORM pg_temp.assvc();
  x := public.user_id_for_auth_email('c21-3998-a@example.test');
  PERFORM pg_temp.asu(i);
  BEGIN
    PERFORM public.admin_add_internal_user('c21-3998-a@example.test', 'support_agent');
    st := 'granted';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE || ' ' || SQLERRM;
  END;
  PERFORM pg_temp.pg();
  ok := x IS NULL AND st LIKE 'P0001 More than one account%'
    AND NOT EXISTS (SELECT 1 FROM public.internal_roles WHERE user_id IN (a, b));
  r := pg_temp.res(ok, 'C21 ' || cname, format('lookup=%s %s', x, st));
""")

ctl('C22', 'mixed-case unclaimed row is replaced at sign-up', r"""
  n := pg_temp.noauth('C22-3998-Orphan@Example.test');
  BEGIN
    x := pg_temp.mk('c22-3998-orphan@example.test');
    st := 'ok';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE || ' ' || SQLERRM;
  END;
  ok := st = 'ok' AND pg_temp.pe(n) IS NULL AND pg_temp.pe(x) = 'c22-3998-orphan@example.test';
  r := pg_temp.res(ok, 'C22 ' || cname, st || ' orphan=' || COALESCE(pg_temp.pe(n), 'removed') || ' new=' || COALESCE(pg_temp.pe(x), 'none'));
""")

ctl('C23', 'migration data step rewrites a stored value to the auth email', r"""
  a := pg_temp.mk('c23-3998-a@example.test');
  PERFORM pg_temp.raw_email(a, 'c23-3998-stale@example.test');
  EXECUTE """ + q(BACKFILL) + r""";
  r := pg_temp.res(pg_temp.pe(a) = 'c23-3998-a@example.test', 'C23 ' || cname, pg_temp.pe(a));
""")

ctl('C24', 'collision on a client update gives the placeholder, not an error', r"""
  a := pg_temp.mk('c24-3998-a@example.test');
  PERFORM pg_temp.raw_email(a, 'c24-3998-old@example.test');
  n := pg_temp.noauth('c24-3998-a@example.test');
  PERFORM pg_temp.asu(a);
  BEGIN
    UPDATE public.users SET email = 'c24-3998-x@example.test' WHERE id = a;
    st := 'ok';
  EXCEPTION WHEN OTHERS THEN st := SQLSTATE || ' ' || SQLERRM;
  END;
  PERFORM pg_temp.pg();
  ok := st = 'ok' AND pg_temp.pe(a) = a::text || '@unknown.local';
  r := pg_temp.res(ok, 'C24 ' || cname, st || ' ' || COALESCE(pg_temp.pe(a), 'none'));
""")

ctl('C25', 'sign-up email: auth email lowercased; no user-metadata fallback', r"""
  x := pg_temp.mk(NULL, '{"provider":"azure"}', '{"email":"c25-3998-meta@example.test"}');
  y := pg_temp.mk('  C25-3998-Upper@Example.TEST');
  ok := pg_temp.pe(x) = x::text || '@unknown.local' AND pg_temp.pe(y) = 'c25-3998-upper@example.test';
  r := pg_temp.res(ok, 'C25 ' || cname, pg_temp.pe(x) || ' / ' || pg_temp.pe(y));
""")

ctl('C26', 'catalog: definer/invoker, EXECUTE grants, update policy WITH CHECK, triggers', r"""
  SELECT string_agg(p.proname || '=' || p.prosecdef::text || ':' ||
           CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE') THEN 'A' ELSE '-' END ||
           CASE WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE') THEN 'U' ELSE '-' END ||
           CASE WHEN has_function_privilege('service_role', p.oid, 'EXECUTE') THEN 'S' ELSE '-' END, ' ' ORDER BY p.proname)
    INTO t FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('users_email_from_auth', 'users_client_write_guard', 'users_own_oauth_pair',
                       'user_id_for_auth_email', 'admin_add_internal_user', 'sync_email_from_auth', 'handle_new_user');
  SELECT with_check INTO t2 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'users' AND policyname = 'users_can_update_own_user';
  SELECT string_agg(tgname, ',' ORDER BY tgname) INTO e FROM pg_trigger
   WHERE tgname IN ('users_email_from_auth', 'users_client_write_guard', 'on_auth_user_email_changed') AND NOT tgisinternal;
  ok := t = 'admin_add_internal_user=true:-US handle_new_user=true:--S sync_email_from_auth=true:--S user_id_for_auth_email=true:--S users_client_write_guard=false:--S users_email_from_auth=true:--S users_own_oauth_pair=true:-US'
    AND t2 = '(( SELECT auth.uid() AS uid) = id)'
    AND e = 'on_auth_user_email_changed,users_client_write_guard,users_email_from_auth';
  r := pg_temp.res(ok, 'C26 ' || cname, t || ' | ' || COALESCE(t2, 'no check') || ' | ' || COALESCE(e, ''));
""")

ctl('C27', 'users_own_oauth_pair: own pair for the client, nothing for anon', r"""
  a := pg_temp.mk('c27-3998-a@example.test');
  PERFORM pg_temp.mkid(a, 'azure', 'c27-3998-late', now());
  PERFORM pg_temp.mkid(a, 'email', a::text, now() - interval '1 day');
  PERFORM pg_temp.asu(a);
  SELECT p.provider || ':' || p.provider_id INTO t FROM public.users_own_oauth_pair() p;
  PERFORM pg_temp.asanon();
  BEGIN
    SELECT count(*) INTO k FROM public.users_own_oauth_pair();
    st := 'anon rows=' || k;
  EXCEPTION WHEN OTHERS THEN st := 'anon ' || SQLSTATE;
  END;
  PERFORM pg_temp.pg();
  r := pg_temp.res(t = 'email:' || a::text AND st = 'anon 42501', 'C27 ' || cname, COALESCE(t, 'none') || ' ' || st);
""")

CIDS = [c[0] for c in C]
assert len(set(CIDS)) == len(CIDS)


def control_fn(cid, name, sql):
    return f"""CREATE FUNCTION pg_temp.{cid.lower()}() RETURNS text LANGUAGE plpgsql AS {q(f'''
DECLARE
  r text;
  cname text := {q(name)};
{DECL}
BEGIN
  BEGIN
{sql}
    RAISE EXCEPTION USING ERRCODE = 'ZX998', MESSAGE = r;
  EXCEPTION
    WHEN SQLSTATE 'ZX998' THEN RETURN SQLERRM;
    WHEN OTHERS THEN
      PERFORM pg_temp.pg();
      RETURN 'FAIL|{cid} ' || cname || '|unexpected ' || SQLSTATE || ' ' || SQLERRM;
  END;
END''')};
"""


def fns(ids):
    return ''.join(control_fn(*c) for c in C if c[0] in ids)

# --------------------------------------------------------------------------- mutants
# Body mutants: (id, function key, anchor, replacement, what, controls expected red)
M = [
    ('M1', 'email', "  IF EXISTS (SELECT 1 FROM public.users u\n              WHERE u.email = v_email\n",
     "  IF false AND EXISTS (SELECT 1 FROM public.users u\n              WHERE u.email = v_email\n",
     'email trigger: no collision fallback', ['C24', 'C5']),
    ('M2', 'email', "  IF v_found IS NOT TRUE THEN\n    RETURN NEW;\n  END IF;\n",
     "  IF v_found IS NOT TRUE THEN\n    RETURN NEW;\n  END IF;\n  IF COALESCE(auth.role(), '') <> 'authenticated' THEN\n    RETURN NEW;\n  END IF;\n",
     'email trigger: acts only for JWT role authenticated', ['C13', 'C23']),
    ('M3', 'email', "  SELECT true, lower(btrim(a.email)) INTO v_found, v_email",
     "  SELECT true, a.email INTO v_found, v_email",
     'email trigger: no lower/btrim', ['C13', 'C25']),
    ('M4', 'email', "  IF v_found IS NOT TRUE THEN\n    RETURN NEW;\n  END IF;\n",
     "  IF v_found IS NOT TRUE THEN\n    NEW.email := NEW.id::text || '@unknown.local';\n    RETURN NEW;\n  END IF;\n",
     'email trigger: placeholders rows with no auth record', ['C7', 'C22']),
    ('M5', 'guard', "  IF current_user NOT IN ('authenticated', 'anon') THEN\n    RETURN NEW;\n  END IF;\n",
     "  IF COALESCE(auth.role(), '') NOT IN ('authenticated', 'anon') THEN\n    RETURN NEW;\n  END IF;\n",
     'guard keyed on JWT role instead of current_user', ['C19']),
    ('M6', 'guard', "  IF current_user NOT IN ('authenticated', 'anon') THEN\n    RETURN NEW;\n  END IF;\n",
     "",
     'guard: no role check', ['C19']),
    ('M7', 'guard', "    NEW.oauth_provider := OLD.oauth_provider;\n    NEW.oauth_id := OLD.oauth_id;\n",
     "",
     'guard: update branch keeps client pair', ['C17']),
    ('M8', 'guard', "  IF v_provider IS NOT NULL THEN\n    NEW.oauth_provider := v_provider;\n    NEW.oauth_id := v_provider_id;\n  END IF;\n",
     "",
     'guard: insert keeps client pair', ['C18']),
    ('M9', 'pair', "    v_provider_id := v_uid::text;\n  END IF;\n\n  provider := v_provider;",
     "    NULL;\n  END IF;\n\n  provider := v_provider;",
     'users_own_oauth_pair: no collision fallback', ['C18b']),
    ('M10', 'pair', "   ORDER BY i.created_at, i.id\n", "   ORDER BY i.created_at DESC, i.id\n",
     'users_own_oauth_pair: latest identity instead of earliest', ['C27']),
    ('M11', 'hnu', "    v_oauth_id := NEW.id::text;\n  END IF;\n", "    NULL;\n  END IF;\n",
     'handle_new_user: no pair fallback', ['C16']),
    ('M12', 'hnu', "       AND NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = u.id)\n  LOOP", "\n  LOOP",
     'handle_new_user: removes auth-backed rows too', ['C5']),
    ('M13', 'hnu', "     WHERE lower(btrim(u.email)) = v_email\n", "     WHERE u.email = v_email\n",
     'handle_new_user: exact-case orphan match', ['C22']),
    ('M14', 'hnu', "  v_email := COALESCE(NULLIF(lower(btrim(NEW.email)), ''), NEW.id::text",
     "  v_email := COALESCE(NULLIF(lower(btrim(NEW.email)), ''), NULLIF(TRIM(NEW.raw_user_meta_data->>'email'), ''), NEW.id::text",
     'handle_new_user: metadata email fallback restored', ['C25']),
    ('M15', 'lookup', "  IF cardinality(v_ids) > 1 THEN\n    RETURN NULL;\n  END IF;\n  IF cardinality(v_ids) = 1 THEN\n    RETURN (SELECT",
     "  IF cardinality(v_ids) >= 1 THEN\n    RETURN (SELECT",
     'lookup: first of several auth matches', ['C21']),
    ('M16', 'lookup', "     AND NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = u.id);",
     ";", 'lookup: fallback includes auth-backed rows', ['C11b']),
    ('M17', 'lookup', "  IF cardinality(v_ids) = 1 THEN\n    RETURN v_ids[1];\n  END IF;\n  RETURN NULL;",
     "  RETURN NULL;", 'lookup: no unclaimed-row fallback', ['C11b']),
    ('M18', 'aaiu', "  SELECT u.id INTO v_target_user_id\n    FROM auth.users a JOIN public.users u ON u.id = a.id\n   WHERE lower(btrim(a.email)) = lower(btrim(p_email));",
     "  SELECT id INTO v_target_user_id FROM public.users WHERE email = p_email;",
     'admin_add_internal_user: matches the stored public value', ['C2', 'C8']),
    ('M19', 'aaiu', "   WHERE lower(btrim(a.email)) = lower(btrim(p_email));\n  IF v_target",
     "   WHERE a.email = p_email;\n  IF v_target", 'admin_add_internal_user: case-sensitive', ['C8']),
    ('M20', 'aaiu', " USING ERRCODE = 'P0002';", ";", 'admin_add_internal_user: not-found without P0002', ['C2']),
    ('M21', 'aaiu', "  IF v_matches > 1 THEN\n    RAISE EXCEPTION 'More than one account has email: %', p_email;\n  END IF;\n",
     "", 'admin_add_internal_user: ambiguity not refused', ['C21']),
    ('M22', 'sync', "  BEGIN\n    UPDATE public.users SET email = NEW.email WHERE id = NEW.id;\n  EXCEPTION WHEN OTHERS THEN\n    RAISE WARNING 'sync_email_from_auth: % %', SQLSTATE, SQLERRM;\n  END;\n",
     "  UPDATE public.users SET email = NEW.email WHERE id = NEW.id;\n",
     'sync_email_from_auth: errors not caught', ['C13b']),
]

RESET_COLS = ['status', 'suspended_at', 'suspension_reason', 'is_active', 'subscription_tier',
              'subscription_status', 'subscription_started_at', 'trial_ends_at', 'provisioning_source',
              'scim_external_id', 'is_managed', 'sso_only', 'last_sso_login_at', 'last_sso_provider',
              'jit_provisioned', 'jit_provisioned_at', 'idp_claims']
GB = body('guard')
for n_, col in enumerate(RESET_COLS, 1):
    line = re.search(r'\n  NEW\.' + col + r' := [^\n]*;\n', GB).group(0)
    M.append((f'R{n_}', 'guard', line, '\n', f'guard: {col} not reset', ['C18']))

# State mutants: (id, what, probe query returning text, mutation SQL, controls expected red)
S = [
    ('S1', 'email trigger SECURITY INVOKER',
     "SELECT prosecdef::text FROM pg_proc WHERE oid = 'public.users_email_from_auth()'::regprocedure",
     "ALTER FUNCTION public.users_email_from_auth() SECURITY INVOKER", ['C4', 'C1']),
    ('S2', 'guard SECURITY DEFINER',
     "SELECT prosecdef::text FROM pg_proc WHERE oid = 'public.users_client_write_guard()'::regprocedure",
     "ALTER FUNCTION public.users_client_write_guard() SECURITY DEFINER", ['C17', 'C18']),
    ('S3', 'update policy without WITH CHECK',
     "SELECT COALESCE(with_check, 'none') FROM pg_policies WHERE schemaname = 'public' AND tablename = 'users' AND policyname = 'users_can_update_own_user'",
     "DROP POLICY users_can_update_own_user ON public.users; CREATE POLICY users_can_update_own_user ON public.users FOR UPDATE USING ((SELECT auth.uid()) = id)",
     ['C15']),
    ('S4', 'guard trigger on INSERT only',
     "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'users_client_write_guard'",
     "DROP TRIGGER users_client_write_guard ON public.users; CREATE TRIGGER users_client_write_guard BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.users_client_write_guard()",
     ['C17']),
    ('S5', 'lookup EXECUTE granted to authenticated and anon',
     "SELECT proacl::text FROM pg_proc WHERE oid = 'public.user_id_for_auth_email(text)'::regprocedure",
     "GRANT EXECUTE ON FUNCTION public.user_id_for_auth_email(text) TO authenticated, anon", []),
    ('S6', 'auth.users email trigger absent',
     "SELECT count(*)::text FROM pg_trigger WHERE tgname = 'on_auth_user_email_changed'",
     "DROP TRIGGER on_auth_user_email_changed ON auth.users", ['C13']),
    ('S7', 'email trigger without OF id (on email only)',
     "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'users_email_from_auth'",
     "DROP TRIGGER users_email_from_auth ON public.users; CREATE TRIGGER users_email_from_auth BEFORE INSERT OR UPDATE OF email ON public.users FOR EACH ROW EXECUTE FUNCTION public.users_email_from_auth()",
     ['C15']),
    ('S8', 'users_own_oauth_pair EXECUTE granted to anon',
     "SELECT proacl::text FROM pg_proc WHERE oid = 'public.users_own_oauth_pair()'::regprocedure",
     "GRANT EXECUTE ON FUNCTION public.users_own_oauth_pair() TO anon", ['C27']),
]
# S5: C11 cannot red here: the function's own auth.role() check still refuses. Recorded as
# defence in depth (C11 is held by two independent guards); the catalog control C26 reds.
S[4] = (S[4][0], S[4][1], S[4][2], S[4][3], ['C26'])
# S7: with WITH CHECK in place an id move is refused by RLS (C15); the OF id term is
# defence in depth. C26 does not read the column list, so S7 is expected to stay green
# everywhere: recorded as a known-uncaught state mutant.

def check_anchors():
    bad = []
    for mid, key, a, _r, _w, _c in M:
        n = body(key).count(a)
        if n != 1:
            bad.append(f'{mid}: anchor occurs {n} times in {key}: {a[:60]!r}')
    if bad:
        print('\n'.join(bad))
        sys.exit(1)


check_anchors()


def header(title):
    return f"-- BACKLOG-3998 DB harness: {title}. Generated by compose.py; see README.md.\n" \
           f"-- Synthetic accounts '<tag>-3998-...@example.test' (test naming only).\n"


def controls_batch(ids):
    run = '\n'.join(f"  rep := rep || E'\\n' || pg_temp.{c.lower()}();" for c in ids)
    return header('controls ' + ','.join(ids)) + HELPERS + fns(ids) + f"""
DO $run$
DECLARE rep text := '';
BEGIN
{run}
  RAISE EXCEPTION 'REPORT (% PASS / % FAIL)%',
    (SELECT count(*) FROM regexp_split_to_table(rep, E'\\n') l WHERE l LIKE 'PASS|%'),
    (SELECT count(*) FROM regexp_split_to_table(rep, E'\\n') l WHERE l LIKE 'FAIL|%'), rep;
END $run$;
"""


def mutants_batch(items):
    """items: list of ('M', tuple) or ('S', tuple)."""
    ctl_ids = sorted({c for kind, t in items for c in (t[5] if kind == 'M' else t[4])}, key=CIDS.index)
    base = '\n'.join(f"  rep := rep || E'\\n' || 'BASE ' || pg_temp.{c.lower()}();" for c in ctl_ids)
    blocks = []
    for kind, t in items:
        if kind == 'M':
            mid, key, a, rep_, what, exp = t
            sig = SIGS[key]
            runs = '\n'.join(f"      res := res || E'\\n    ' || pg_temp.{c.lower()}();" for c in exp)
            blocks.append(f"""
  BEGIN
    DECLARE res text := ''; d0 text; d1 text; m0 text; m1 text;
    BEGIN
      SELECT pg_get_functiondef('{sig}'::regprocedure), md5(prosrc) INTO d0, m0 FROM pg_proc WHERE oid = '{sig}'::regprocedure;
      IF (length(d0) - length(replace(d0, {q(a)}, ''))) / length({q(a)}) <> 1 THEN
        RAISE EXCEPTION USING ERRCODE = 'ZX997', MESSAGE = '{mid} ANCHOR NOT EXACTLY ONCE (live body)';
      END IF;
      d1 := replace(d0, {q(a)}, {q(rep_)});
      EXECUTE d1;
      SELECT md5(prosrc) INTO m1 FROM pg_proc WHERE oid = '{sig}'::regprocedure;
      IF m1 = m0 THEN
        RAISE EXCEPTION USING ERRCODE = 'ZX997', MESSAGE = '{mid} NOT APPLIED (md5 unchanged)';
      END IF;
      res := '{mid} MUTATION APPLIED ' || left(m0, 8) || '->' || left(m1, 8) || ' ' || {q(what)};
{runs}
      RAISE EXCEPTION USING ERRCODE = 'ZX996', MESSAGE = res;
    END;
  EXCEPTION WHEN SQLSTATE 'ZX996' OR SQLSTATE 'ZX997' THEN rep := rep || E'\\n' || SQLERRM;
  END;""")
        else:
            sid, what, probe, mut, exp = t
            runs = '\n'.join(f"      res := res || E'\\n    ' || pg_temp.{c.lower()}();" for c in exp)
            blocks.append(f"""
  BEGIN
    DECLARE res text := ''; p0 text; p1 text;
    BEGIN
      EXECUTE {q(probe)} INTO p0;
      EXECUTE {q(mut)};
      EXECUTE {q(probe)} INTO p1;
      IF p1 IS NOT DISTINCT FROM p0 THEN
        RAISE EXCEPTION USING ERRCODE = 'ZX997', MESSAGE = '{sid} NOT APPLIED (state unchanged)';
      END IF;
      res := '{sid} MUTATION APPLIED ' || left(COALESCE(p0, 'null'), 60) || ' -> ' || left(COALESCE(p1, 'null'), 60) || ' ' || {q(what)};
{runs}
      RAISE EXCEPTION USING ERRCODE = 'ZX996', MESSAGE = res;
    END;
  EXCEPTION WHEN SQLSTATE 'ZX996' OR SQLSTATE 'ZX997' THEN rep := rep || E'\\n' || SQLERRM;
  END;""")
    ids = ','.join(t[0] for _, t in items)
    return header('mutants ' + ids) + HELPERS + fns(ctl_ids) + f"""
DO $run$
DECLARE rep text := '';
BEGIN
{base}
{''.join(blocks)}
  RAISE EXCEPTION 'MUTANT REPORT%', rep;
END $run$;
"""


def write(name, text):
    assert all(ord(ch) < 128 for ch in text), name
    (HERE / name).write_text(text)


for old in HERE.glob('controls-*.sql'):
    old.unlink()
for old in HERE.glob('mutants-*.sql'):
    old.unlink()

BATCH = 10
for n_, s_ in enumerate(range(0, len(CIDS), BATCH), 1):
    write(f'controls-{n_}.sql', controls_batch(CIDS[s_:s_ + BATCH]))

items = [('M', t) for t in M] + [('S', t) for t in S]
# Each mutant file: at most 15 control runs including BASE.
batches, cur = [], []
for it in items:
    cand = cur + [it]
    exp_runs = sum(len(t[5] if k == 'M' else t[4]) for k, t in cand)
    base_runs = len({c for k, t in cand for c in (t[5] if k == 'M' else t[4])})
    if cur and exp_runs + base_runs > 15:
        batches.append(cur)
        cur = [it]
    else:
        cur = cand
if cur:
    batches.append(cur)
for n_, b in enumerate(batches, 1):
    write(f'mutants-{n_}.sql', mutants_batch(b))

write('c14-rollback-reapply.sql', header('C14 rollback then re-apply') + ROLLBACK + '\n' + MIG_TEXT + r"""
DO $c14$
DECLARE rep text;
BEGIN
  SELECT string_agg(p.proname || '=' || md5(p.prosrc), ' ' ORDER BY p.proname) INTO rep FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('users_email_from_auth', 'users_client_write_guard', 'users_own_oauth_pair',
                       'user_id_for_auth_email', 'admin_add_internal_user', 'sync_email_from_auth', 'handle_new_user');
  RAISE EXCEPTION 'C14 REPORT %', rep;
END $c14$;
""")

print(f'{len(C)} controls in {len(range(0, len(CIDS), BATCH))} files; {len(M)} body mutants + {len(S)} state mutants in {len(batches)} files; anchors exact-once OK')
