#!/usr/bin/env python3
"""BACKLOG-4259 database mutants, all in ONE kt-sql call (one transaction ending in RAISE).

Usage: mutants-4259.py <out.sql>    then: ~/.claude/bin/kt-sql <out.sql> | python3 parse.py

Composition: rollback, the migration (working tree; commit first), lib/helpers.sql, a function
pg_temp.k4259() holding the base fixtures and the K1-K5 blocks copied from controls.sql, and a
driver. The driver runs 'pristine' first, then each mutant, each inside its own subtransaction:
CREATE OR REPLACE of the one mutated function (text built here by exact-string replace that must
match exactly once in that function), a check that the catalog md5(prosrc) equals the md5 of the
mutant body computed here (else the mode reports MD5_MISMATCH and runs nothing), then k4259(). The
subtransaction is rolled back, so the next mode starts from the pristine function again; the
driver also asserts the pristine md5 before each mode.
"""
import hashlib, json, os, secrets, sys

here = os.path.dirname(os.path.abspath(__file__))
MIG = os.path.join(here, '..', '..', 'migrations', '20261112170000_backlog_4238_mcp_oauth_server.sql')
m = open(MIG).read()
rb = open(os.path.join(here, 'rollback-4238.sql')).read()
hl = open(os.path.join(here, 'lib', 'helpers.sql')).read()
ctl = open(os.path.join(here, 'controls.sql')).read()


def one(text, s):
    assert text.count(s) == 1, s[:80]
    return text.index(s)


def fn_stmt(name):
    i = one(m, 'CREATE OR REPLACE FUNCTION public.%s(' % name)
    j = m.index('\n$fn$;', i) + len('\n$fn$;')
    return m[i:j]


def body(stmt):
    i = stmt.index('AS $fn$') + len('AS $fn$')
    j = stmt.rindex('$fn$;')
    return stmt[i:j]


REG_CHECKS = """  IF (p_client_id ~ '^kpr_c_[A-Za-z0-9_-]{22}$'
      AND char_length(p_client_name) BETWEEN 1 AND 100) IS NOT TRUE THEN
    RETURN public._mcp_refuse('invalid_client_metadata');
  END IF;
  IF (cardinality(p_redirect_uris) BETWEEN 1 AND 3
      AND array_position(p_redirect_uris, NULL) IS NULL
      AND NOT EXISTS (SELECT 1 FROM unnest(p_redirect_uris) u(uri)
                       WHERE NOT EXISTS (SELECT 1 FROM public.mcp_redirect_allowlist a WHERE a.redirect_uri = u.uri))) IS NOT TRUE THEN
    RETURN public._mcp_refuse('invalid_redirect_uri');
  END IF;
"""
REG_BUMPS = """  v_b := public._mcp_bump('reg_ip:' || encode(p_ip_sha256, 'hex'), interval '1 hour', 60);
  IF v_b IS NOT DISTINCT FROM 'ok' THEN
    v_b := public._mcp_bump('reg_all', interval '1 day', 500);
  END IF;
  IF v_b IS DISTINCT FROM 'ok' THEN
    RETURN public._mcp_refuse(coalesce(v_b, 'busy'));
  END IF;
"""
REG_ENABLED = """  IF (SELECT s.enabled FROM public.mcp_settings s WHERE s.id) IS NOT TRUE THEN
    RETURN public._mcp_refuse('busy');
  END IF;
"""
VIEW_REDIR = "                                           AND x.redirect_uri = v_req.redirect_uri\n"
VIEW_STATUS = "                                           AND x.status = 'active'))"

# mode: (function, [(old, new)], controls that must turn red, description)
MODES = {
  'MK1_counters_before_checks': ('mcp_register_client', [(REG_CHECKS + REG_BUMPS, REG_BUMPS + REG_CHECKS)],
      'K1_refused_registration_counts_nothing K2_refused_do_not_block_valid', 'MOST LIKELY WRONG: counters bumped before the argument and allow-list checks (previous order)'),
  'MK2_counters_between_checks': ('mcp_register_client', [(REG_CHECKS + REG_BUMPS, REG_CHECKS.split('  IF (cardinality')[0] + REG_BUMPS + '  IF (cardinality' + REG_CHECKS.split('  IF (cardinality')[1])],
      'K1_refused_registration_counts_nothing K2_refused_do_not_block_valid', 'counters after the argument check but before the allow-list check'),
  'MK3_no_enabled_check': ('mcp_register_client', [(REG_ENABLED, '')],
      'K3_disabled_refuses_registration', 'registration without the enabled check'),
  'MK4_old_lifetime': ('mcp_authorize_begin', [("now() + interval '180 seconds'", "now() + interval '10 minutes'")],
      'K4_request_lifetime', 'request lifetime 10 minutes (previous value), expires_in left at 180'),
  'MK5_lifetime_179': ('mcp_authorize_begin', [("now() + interval '180 seconds'", "now() + interval '179 seconds'")],
      'K4_request_lifetime', 'request lifetime 179 s'),
  'MK6_replaces_keyed_on_client': ('mcp_authorize_view', [(VIEW_REDIR, "                                           AND x.client_id = v_req.client_id\n")],
      'K5_view_replaces_existing', 'MOST LIKELY WRONG: replacement notice keyed on the client id (a new registration never matches)'),
  'MK7_replaces_ignores_status': ('mcp_authorize_view', [(VIEW_STATUS, "                                           AND true))")],
      'K5_view_replaces_existing', 'replacement notice also counts pending connections'),
  'MK8_replaces_ignores_user': ('mcp_authorize_view', [("                                         WHERE x.user_id = v_uid\n", "                                         WHERE true\n")],
      'K5_view_replaces_existing', 'replacement notice for any user'),
}

# K blocks and the base fixtures, copied from controls.sql
k_start = one(ctl, '  -- ===== K1 (BACKLOG-4259)')
k_end = one(ctl, '  -- ===== content-free log =====')
k_blocks = ctl[k_start:k_end]
f_start = one(ctl, '  -- ===== base fixtures =====')
f_end = one(ctl, '  -- ===== D15a: no state function yet =====')
fixtures = ctl[f_start:f_end]
decl_start = one(ctl, 'DECLARE\n  r  jsonb := ')
decl_end = one(ctl, '  ANON_FNS text[]')
decl = ctl[decl_start:decl_end]

k_fn = ("CREATE FUNCTION pg_temp.k4259() RETURNS jsonb LANGUAGE plpgsql AS $k4259$\n" + decl + "BEGIN\n"
        + fixtures + k_blocks + "  RETURN r;\nEND\n$k4259$;\n")

def md5(s):
    return hashlib.md5(s.encode('utf-8')).hexdigest()

rows = []
for mode, (fname, edits, targets, desc) in MODES.items():
    stmt = fn_stmt(fname)
    mut = stmt
    for old, new in edits:
        if mut.count(old) != 1:
            sys.exit('MUTATION NOT APPLIED: %s fragment matched %d times' % (mode, mut.count(old)))
        mut = mut.replace(old, new)
    assert mut != stmt
    print('MUTATION APPLIED %s (%s): %s' % (mode, fname, desc), file=sys.stderr)
    rows.append((mode, fname, md5(body(stmt)), mut, md5(body(mut)), targets))
for tag in ('$k4259$', '$mut4259$', '$drv4259$'):
    assert all(tag not in r[3] for r in rows) and tag not in m and tag not in ctl.replace(k_blocks, '')

drv = ["DO $drv4259$\nDECLARE v jsonb; out jsonb := '{}'::jsonb; reds jsonb; cur text;\nBEGIN"]
targets_all = sorted({t for r in rows for t in r[5].split()})
drv.append("""  BEGIN
    v := pg_temp.k4259();
    out := out || jsonb_build_object('pristine', (SELECT coalesce(jsonb_object_agg(e.key, left(e.value, 300)), '{}'::jsonb) FROM jsonb_each_text(v) e WHERE e.value <> 'PASS'),
                                     'pristine_total', (SELECT count(*) FROM jsonb_each_text(v)));
    RAISE EXCEPTION USING ERRCODE = 'T4259';
  EXCEPTION WHEN SQLSTATE 'T4259' THEN NULL; WHEN OTHERS THEN out := out || jsonb_build_object('pristine_crash', SQLSTATE || ' ' || SQLERRM);
  END;""")
for mode, fname, pmd5, mut, mmd5, targets in rows:
    drv.append("""  BEGIN
    SELECT md5(p.prosrc) INTO cur FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = %(fn)s;
    IF cur IS DISTINCT FROM %(pmd5)s THEN
      out := out || jsonb_build_object(%(mode)s, 'PRISTINE_MD5_MISMATCH ' || coalesce(cur, 'null'));
    ELSE
      EXECUTE $mut4259$%(mut)s$mut4259$;
      SELECT md5(p.prosrc) INTO cur FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = %(fn)s;
      IF cur IS DISTINCT FROM %(mmd5)s THEN
        out := out || jsonb_build_object(%(mode)s, 'MD5_MISMATCH ' || coalesce(cur, 'null'));
      ELSE
        v := pg_temp.k4259();
        reds := (SELECT coalesce(jsonb_agg(e.key ORDER BY e.key), '[]'::jsonb) FROM jsonb_each_text(v) e WHERE e.value <> 'PASS');
        out := out || jsonb_build_object(%(mode)s, jsonb_build_object('md5', cur, 'total', (SELECT count(*) FROM jsonb_each_text(v)), 'reds', reds,
                 'want_red', %(targets)s::jsonb,
                 'verdict', CASE WHEN (SELECT bool_and(reds ? t) FROM jsonb_array_elements_text(%(targets)s::jsonb) t) THEN 'as expected' ELSE 'MISSED' END));
      END IF;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'T4259';
  EXCEPTION WHEN SQLSTATE 'T4259' THEN NULL; WHEN OTHERS THEN out := out || jsonb_build_object(%(mode)s, 'CRASH ' || SQLSTATE || ' ' || SQLERRM);
  END;""" % {'fn': "'" + fname + "'", 'pmd5': "'" + pmd5 + "'", 'mmd5': "'" + mmd5 + "'", 'mode': "'" + mode + "'",
             'mut': mut, 'targets': "'" + json.dumps(targets.split()) + "'"})
drv.append("""  -- final: every function back to the pristine body
  out := out || jsonb_build_object('final_md5', (SELECT jsonb_object_agg(p.proname, md5(p.prosrc)) FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('mcp_register_client', 'mcp_authorize_begin', 'mcp_authorize_view')));
  RAISE EXCEPTION 'P4238_RESULT %', out || jsonb_build_object('total', jsonb_array_length(to_jsonb(ARRAY[1])));
END
$drv4259$;""")

text = ("SET LOCAL pg_stat_statements.track = 'none';\n" + rb + '\n' + m + '\n' + hl + '\n' + k_fn + '\n'.join(drv) + '\n')
text = text.replace('__SECRET__', secrets.token_hex(32)).replace('__PREV_SECRET__', secrets.token_hex(32))
assert '__SECRET__' not in text
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as fh:
    fh.write(text)
print(json.dumps({'out': sys.argv[1], 'bytes': len(text),
                  'pristine_md5': {r[1]: r[2] for r in rows}, 'mutant_md5': {r[0]: r[4] for r in rows}}, indent=1))
