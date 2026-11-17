#!/usr/bin/env python3
"""BACKLOG-4263 PR-1: controls and mutants for the MCP tool list_all_deals in ONE kt-sql call (one
transaction ending in RAISE, so nothing persists).

Usage: harness.py run [--print] [--dump <dir>] [--no-mutants] [--only=<mutant prefix,...>] [--fixtures=<path>]
       [--apply-trial=<apply file> [--break-md5]]

Order in the call: a read-only catalog record (PRE_*), a stop unless the test project holds the 4244 data
tools at their known function bodies, rollback-4263.sql, the migration twice, the 4244 harness helpers,
lib/fixtures.sql, lib/probes.sql, the fixtures, every probe on the migration as written (C_*), the reader
outputs used by the portal tests (FX_*), then every mutant (M_*): each in a subtransaction, applied,
checked in the catalog (md5(prosrc), ACL or a DDL condition) before its probe runs, then undone.
The call ends with extensions.pg_stat_statements_reset() and a RAISE.

--apply-trial runs the apply file (BEGIN/COMMIT removed) inside a transaction that ends in RAISE and
reports whether its post-check passed; with --break-md5 one expected md5 in it is changed first, and the
post-check must raise.
"""
import hashlib, json, os, re, secrets, subprocess, sys

here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
rd = lambda p: open(os.path.join(root, p)).read()
MIGP = 'supabase/migrations/20261118100000_backlog_4263_mcp_list_all_deals.sql'
MIG = rd(MIGP)
M4238 = rd('supabase/migrations/20261112170000_backlog_4238_mcp_oauth_server.sql')
RB = rd('supabase/tests/backlog-4263/rollback-4263.sql')
HL = rd('supabase/tests/backlog-4244/lib/helpers.sql')
FX, PR = (rd('supabase/tests/backlog-4263/lib/' + f) for f in ('fixtures.sql', 'probes.sql'))
TAG, TAG2 = '$swp4263$', '$rbt4263$'
for t in (MIG, RB, HL, FX, PR):
    assert TAG not in t and TAG2 not in t

READER = '_mcp_r_list_all_deals'
TOOL = 'mcp_list_all_deals'
# md5(prosrc) of the nine anon-callable mcp functions, measured on the test project 2026-11-17
# (unchanged by this migration; equal to the 4244 apply post-check for the three data tools)
ANON9 = {
    'mcp_get_status(text,bytea,text)': '2b810d019c8962949d56d38cfcc8a691',
    'mcp_check_access(text,bytea,text)': 'dc8edad305196bf1e30187cf7a8b1fbd',
    'mcp_get_deal(text,bytea,text,text)': '999e936dd89df5f79147cf26ed0c45e6',
    'mcp_refresh(text,bytea,text,text,bytea,bytea)': 'b6ccefaa100e0b69df3e16e0a407d740',
    'mcp_register_client(text,text,text,text[],bytea)': '27326378a7ca849f4a116f6b46e1767e',
    'mcp_list_deals(text,bytea,text,text,text,integer,text)': '89449ee2d49e57602d4531982ecfa8a0',
    'mcp_get_deal_checklists(text,bytea,text,text,boolean,text)': 'c43551f4a67bc1bed96991b4368a3c8f',
    'mcp_exchange_code(text,bytea,text,text,text,text,bytea,bytea)': 'cfb0787d8601435bbe47a575155866b8',
    'mcp_authorize_begin(text,text,text,text,text,text,text,text,bytea,bytea)': 'bf7192517604c2db532312a7e071a751',
}


def lit(s):
    return "'" + s.replace("'", "''") + "'"


def q(s):
    return TAG + s + TAG


def q2(s):
    assert TAG2 not in s
    return TAG2 + s + TAG2


def md5(s):
    return hashlib.md5(s.encode('utf-8')).hexdigest()


def unit(text, name):
    """(CREATE ... $fn$; plus its REVOKE/GRANT lines, prosrc, regprocedure text) of one function."""
    start = 'CREATE OR REPLACE FUNCTION public.%s(' % name
    assert text.count(start) == 1, name
    i = text.index(start)
    b0 = text.index('AS $fn$', i) + len('AS $fn$')
    b1 = text.index('$fn$;', b0)
    end = b1 + len('$fn$;')
    acl = []
    for line in text[end:].lstrip('\n').split('\n'):
        if re.match(r'(REVOKE|GRANT) .* ON FUNCTION public\.%s\(' % re.escape(name), line):
            acl.append(line)
        else:
            break
    sig = re.search(r'ON FUNCTION (public\.%s\([^)]*\))' % re.escape(name), acl[0]).group(1)
    return text[i:end] + '\n' + '\n'.join(acl) + '\n', text[b0:b1], sig


OFFLINE_MD5 = {n: md5(unit(MIG, n)[1]) for n in (READER, TOOL)}


def create(name, expr):
    if name == READER:
        return ("    EXECUTE 'GRANT CREATE ON SCHEMA public TO mcp_reader';\n    EXECUTE 'SET ROLE mcp_reader';\n"
                "    EXECUTE %s;\n    EXECUTE 'RESET ROLE';\n    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM mcp_reader';\n") % expr
    return '    EXECUTE %s;\n' % expr


def block(key, body):
    """one subtransaction whose body sets v; the subtransaction is undone, then key -> v is recorded"""
    return ('  v := NULL;\n  BEGIN\n%s\n    RAISE EXCEPTION USING ERRCODE = %s;\n'
            '  EXCEPTION WHEN SQLSTATE %s THEN NULL;\n    WHEN OTHERS THEN EXECUTE %s; v := %s || SQLSTATE || %s || SQLERRM;\n  END;\n'
            '  INSERT INTO pg_temp.p4263_out VALUES (%s, coalesce(v, %s));\n'
            ) % (body, lit('T4263'), lit('T4263'), lit('RESET ROLE'), lit('CRASH '), lit(' '), lit(key), lit('NULL (body set nothing)'))


WANT = {}


def fn_mutant(mode, name, reps, probe, want='red', pre=''):
    """reps: [(old, new, count)] exact-string replaces on the function's text from the migration file"""
    u, _, sig = unit(MIG, name)
    mu = u
    for old, new, cnt in reps:
        n = mu.count(old)
        if n != cnt:
            raise SystemExit('MUTATION NOT APPLIED %s: fragment matched %d times in %s (want %d): %r' % (mode, n, name, cnt, old[:120]))
        mu = mu.replace(old, new)
    assert mu != u
    print('MUTATION APPLIED %s (%s)' % (mode, name))
    for old, new, _ in reps:
        print('  - ' + ' | '.join(l.strip() for l in old.splitlines())[:180])
        print('  + ' + ' | '.join(l.strip() for l in new.splitlines())[:180])
    _, msrc, _ = unit(mu, name)
    WANT['M_' + mode] = want
    body = pre + create(name, q(mu)) + (
        "    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(%s)) IS DISTINCT FROM %s THEN\n"
        "      v := 'NOT APPLIED IN DB';\n    ELSE\n      v := %s;\n    END IF;") % (lit(sig), lit(md5(msrc)), probe)
    return block('M_' + mode, body)


def ddl_mutant(mode, sql, verify, probe, want='red'):
    WANT['M_' + mode] = want
    print('MUTATION APPLIED %s (ddl)\n  + %s' % (mode, sql.strip()[:200]))
    body = ('    EXECUTE %s;\n    IF (%s) IS NOT TRUE THEN\n      v := \'NOT APPLIED IN DB\';\n    ELSE\n      v := %s;\n    END IF;'
            % (q(sql), verify, probe))
    return block('M_' + mode, body)


def combo_mutant(mode, sql, verify, name, reps, probe, want='red'):
    print('  + ddl: ' + sql.strip()[:200])
    pre = '    EXECUTE %s;\n    IF (%s) IS NOT TRUE THEN RAISE EXCEPTION \'combo ddl not applied\'; END IF;\n' % (q(sql), verify)
    return fn_mutant(mode, name, reps, probe, want=want, pre=pre)


def acl_mutant(mode, sql, sig, probe='pg_temp.p_grants()'):
    WANT['M_' + mode] = 'red'
    print('MUTATION APPLIED %s (acl)\n  + %s' % (mode, sql.strip()))
    body = ("    t0 := (SELECT coalesce(proacl::text, 'null') FROM pg_proc WHERE oid = to_regprocedure(%s));\n    EXECUTE %s;\n"
            "    IF (SELECT coalesce(proacl::text, 'null') FROM pg_proc WHERE oid = to_regprocedure(%s)) IS NOT DISTINCT FROM t0 THEN\n"
            "      v := 'NOT APPLIED IN DB (acl unchanged)';\n    ELSE\n      v := %s;\n    END IF;") % (lit(sig), q(sql), lit(sig), probe)
    return block('M_' + mode, body)


def rls_off(table):
    return ('ALTER TABLE public.%s DISABLE ROW LEVEL SECURITY' % table,
            "(SELECT NOT relrowsecurity FROM pg_class WHERE oid = 'public.%s'::regclass)" % table)


def nobump_gate():
    """pg_temp.p4263_enter_nobump: _mcp_enter from the 4238 file with both rate bumps replaced by 'ok'"""
    u = M4238[M4238.index('CREATE OR REPLACE FUNCTION public._mcp_enter('):]
    u = u[:u.index('$fn$;') + len('$fn$;')]
    reps = [("v_b := public._mcp_bump('call_conn:' || g.connection_id::text, interval '1 minute', 30);", "v_b := 'ok';"),
            ("v_b := public._mcp_bump('call_user:' || g.user_id::text, interval '1 minute', 60);", "v_b := 'ok';"),
            ('CREATE OR REPLACE FUNCTION public._mcp_enter(', 'CREATE FUNCTION pg_temp.p4263_enter_nobump(')]
    for old, new in reps:
        assert u.count(old) == 1, old
        u = u.replace(old, new)
    return '    EXECUTE %s;\n' % q(u)


ENTER = "g := public._mcp_enter(p_at_digest, p_resource, 'list_all_deals');"
RO_LINE = "      PERFORM set_config('transaction_read_only', 'on', true);\n"


def mutants():
    b = []
    P = 'pg_temp.p_iso()'
    own = "dl.owner_user_id = v_uid /*OWN:all_deals*/"
    b.append(fn_mutant('ISO_owner_term_only', READER, [(own, 'true /*OWN:all_deals*/', 1)], P, want='green'))
    sql, ver = rls_off('cloud_deals')
    b.append(combo_mutant('ISO_owner_term_and_rls', sql, ver, READER, [(own, 'true /*OWN:all_deals*/', 1)], P))
    b.append(ddl_mutant('ISO_rls_only', sql, ver, P, want='green'))
    b.append(combo_mutant('ISO_inst_owner_and_rls', sql, ver, READER,
                          [("x.owner_user_id = v_uid /*OWN:all_inst*/", "true /*OWN:all_inst*/", 1)], 'pg_temp.p_values()'))
    b.append(fn_mutant('CONF_dropped', READER, [(" AND dl.is_confirmed /*CONF:all*/", '', 1)], 'pg_temp.p_unconfirmed()'))
    b.append(fn_mutant('GATE_no_secret_check', TOOL,
                       [("  IF public._mcp_secret_ok(p_secret) IS NOT TRUE THEN\n    RETURN public._mcp_refuse('not_connected');\n  END IF;\n", '', 1)],
                       'pg_temp.p_tokens()'))
    b.append(fn_mutant('GATE_outcome_ignored', TOOL,
                       [("  IF g.outcome IS DISTINCT FROM 'ok' THEN\n    RETURN public._mcp_refuse(g.outcome);\n  END IF;\n", '', 1)], 'pg_temp.p_tokens()'))
    b.append(fn_mutant('RO_no_read_only', TOOL, [(RO_LINE, '', 1)], 'pg_temp.p_ro()'))
    b.append(fn_mutant('READER_volatile', READER, [('RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER', 'RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER', 1)], P))
    for tag, old in (('schema_version', "(v_st -> 'schema_version') IS DISTINCT FROM to_jsonb(1)\n     OR "),
                     ('licensed', "\n     OR (v_st -> 'licensed') IS DISTINCT FROM to_jsonb(true)"),
                     ('enabled', "\n     OR (v_st -> 'settings' -> 'enabled') IS DISTINCT FROM to_jsonb(true)")):
        b.append(fn_mutant('ENT_term_dropped_' + tag, READER, [(old, '', 1)], 'pg_temp.p_ent()'))
    b.append(fn_mutant('ENT_no_check', READER,
                       [("  IF (v_st -> 'schema_version') IS DISTINCT FROM to_jsonb(1)\n     OR (v_st -> 'licensed') IS DISTINCT FROM to_jsonb(true)\n"
                         "     OR (v_st -> 'settings' -> 'enabled') IS DISTINCT FROM to_jsonb(true) THEN\n    RETURN '{\"not_entitled\":true}'::jsonb;\n  END IF;\n", '', 1)],
                       'pg_temp.p_ent()'))
    rsig = 'public._mcp_r_list_all_deals(text, date, date, uuid)'
    tsig = 'public.mcp_list_all_deals(text, bytea, text, text, text, text, text)'
    b.append(acl_mutant('ACL_reader_to_anon', 'SET ROLE mcp_reader; GRANT EXECUTE ON FUNCTION %s TO anon; RESET ROLE' % rsig, rsig))
    b.append(acl_mutant('ACL_reader_to_authenticated', 'SET ROLE mcp_reader; GRANT EXECUTE ON FUNCTION %s TO authenticated; RESET ROLE' % rsig, rsig))
    b.append(acl_mutant('ACL_tool_to_authenticated', 'GRANT EXECUTE ON FUNCTION %s TO authenticated' % tsig, tsig))
    # page bounds
    b.append(fn_mutant('BOUND_bytes_removed', READER, [(" AND s.cum <= 85000 /*BOUND:bytes*/", '', 1)], 'pg_temp.p_bound()'))
    b.append(fn_mutant('BOUND_rows_removed', READER, [("s.rk <= 500 /*BOUND:rows*/ AND ", '', 1)], 'pg_temp.p_bound()'))
    b.append(fn_mutant('BOUND_strict_less', READER, [("s.cum <= 85000 /*BOUND:bytes*/", "s.cum < 85000 /*BOUND:bytes*/", 1)], 'pg_temp.p_boundary()'))
    b.append(fn_mutant('BOUND_plus_one', READER, [("s.cum <= 85000 /*BOUND:bytes*/", "s.cum <= 85001 /*BOUND:bytes*/", 1)], 'pg_temp.p_boundary()'))
    b.append(fn_mutant('BOUND_no_separator', READER, [("sum(octet_length(r.j::text) + 2)", "sum(octet_length(r.j::text))", 1)], 'pg_temp.p_bound()'))
    # keyset
    b.append(fn_mutant('KEY_ge', READER, [("dl.id > p_after_id) /*KEY:after*/", "dl.id >= p_after_id) /*KEY:after*/", 1)], 'pg_temp.p_bound()'))
    b.append(fn_mutant('PAGE_order_by_save_time', READER, [
        ("AND (p_after_id IS NULL OR dl.id > p_after_id) /*KEY:after*/",
         "AND (p_after_id IS NULL OR (dl.last_synced_at, dl.id) > ((SELECT y.last_synced_at FROM public.cloud_deals y WHERE y.id = p_after_id), p_after_id)) /*KEY:after*/", 1),
        ("ORDER BY dl.id /*ORDER:all*/", "ORDER BY dl.last_synced_at, dl.id /*ORDER:all*/", 1),
        ("row_number() OVER (ORDER BY c.id) AS rk", "row_number() OVER (ORDER BY c.last_synced_at, c.id) AS rk", 1)], 'pg_temp.p_cursor_stable()'))
    b.append(fn_mutant('PAGE_cursor_first_row', READER, [("ORDER BY pg.rk DESC LIMIT 1", "ORDER BY pg.rk LIMIT 1", 1)], 'pg_temp.p_bound()'))
    # arguments
    for tag, old in [('status', "(p_status IS NULL OR p_status IN ('active', 'pending', 'closed')) IS NOT TRUE /*ARG:status*/\n     OR "),
                     ('from', "     OR (p_closed_from IS NULL OR p_closed_from ~ '^\\d{4}-\\d{2}-\\d{2}$') IS NOT TRUE /*ARG:from*/\n"),
                     ('to', "     OR (p_closed_to IS NULL OR p_closed_to ~ '^\\d{4}-\\d{2}-\\d{2}$') IS NOT TRUE /*ARG:to*/\n"),
                     ('cursor', "\n     OR (p_cursor IS NULL OR p_cursor ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') IS NOT TRUE /*ARG:cursor*/")]:
        b.append(fn_mutant('ARG_dropped_' + tag, TOOL, [(old, '', 1)], 'pg_temp.p_args()'))
    b.append(fn_mutant('ARG_dropped_range', TOOL, [("v_from > v_to /*ARG:range*/", "false /*ARG:range*/", 1)], 'pg_temp.p_args()'))
    # values and masking
    b.append(fn_mutant('MASK_address_plain', READER, [("public._mcp_clean(c.property_address, 300)", "c.property_address", 1)], 'pg_temp.p_mask()'))
    for col in ('listing_price', 'sale_price', 'earnest_money_amount', 'commission_offered_rate', 'commission_actual_rate', 'commission_gross_amount'):
        b.append(fn_mutant('NUM_type_not_checked_' + col, READER,
                           [("jsonb_typeof(c.details -> '%s') = 'number' AND " % col, '', 1)], 'pg_temp.p_values()'))
        b.append(fn_mutant('NUM_length_not_checked_' + col, READER,
                           [(" AND octet_length(c.details ->> '%s') <= 30" % col, '', 1)], 'pg_temp.p_values()'))
        b.append(fn_mutant('NUM_length_31_' + col, READER,
                           [("octet_length(c.details ->> '%s') <= 30" % col, "octet_length(c.details ->> '%s') <= 31" % col, 1)], 'pg_temp.p_values()'))
    for col, src in (('transaction_type', 'transaction_type'), ('status', 'status'), ('locked', 'lock_reason')):
        b.append(fn_mutant('TXT_not_cut_' + col, READER, [("public._mcp_txt(c.%s, 20)" % src, "c.%s" % src, 1)], 'pg_temp.p_values()'))
    b.append(fn_mutant('ROWMAX_address_not_cut', READER, [("public._mcp_clean(c.property_address, 300)", "public._mcp_strip(c.property_address)", 1)], 'pg_temp.p_rowmax()'))
    b.append(fn_mutant('DATE_rule_dropped', READER,
                       [("CASE WHEN jsonb_typeof(c.details -> 'closing_deadline') = 'string' AND c.details ->> 'closing_deadline' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN c.details -> 'closing_deadline' END",
                         "c.details -> 'closing_deadline'", 1)], 'pg_temp.p_values()'))
    b.append(fn_mutant('COLUMN_swapped', READER, [("'listing_price', 'sale_price'", "'sale_price', 'listing_price'", 1)], 'pg_temp.p_values()'))
    b.append(fn_mutant('FILTER_closed_local_zone', READER,
                       [("(p_closed_to IS NULL OR (dl.closed_at AT TIME ZONE 'UTC')::date <= p_closed_to)",
                         "(p_closed_to IS NULL OR (dl.closed_at AT TIME ZONE 'Pacific/Kiritimati')::date <= p_closed_to)", 1)], 'pg_temp.p_filters()'))
    # rate count and call log
    b.append(fn_mutant('RATE_enter_twice', TOOL, [(ENTER, ENTER + "\n  g := public._mcp_enter(p_at_digest, p_resource, 'list_all_deals');", 1)], 'pg_temp.p_rate()'))
    b.append(fn_mutant('RATE_gate_without_bump', TOOL, [(ENTER, "g := pg_temp.p4263_enter_nobump(p_at_digest, p_resource, 'list_all_deals');", 1)],
                       'pg_temp.p_rate()', pre=nobump_gate()))
    b.append(fn_mutant('LOG_wrong_tool', TOOL, [(ENTER, "g := public._mcp_enter(p_at_digest, p_resource, 'list_deals');", 1)], 'pg_temp.p_log()'))
    b.append(fn_mutant('LOG_no_finish', TOOL,
                       [("  PERFORM public._mcp_finish(g.call_id, v_out, CASE WHEN v_out = 'ok' THEN jsonb_array_length(v_res -> 'rows') END, v_t0);\n", '', 1)],
                       'pg_temp.p_log()'))
    b.append(ddl_mutant('LOG_tool_check_not_widened',
                        "ALTER TABLE public.mcp_call_log DROP CONSTRAINT mcp_call_log_tool_check; ALTER TABLE public.mcp_call_log ADD CONSTRAINT mcp_call_log_tool_check CHECK (tool IS NULL OR tool IN ('get_status', 'list_deals', 'get_deal', 'get_deal_checklists'))",
                        "(SELECT pg_get_constraintdef(c.oid) NOT LIKE '%list_all_deals%' FROM pg_constraint c WHERE c.conname = 'mcp_call_log_tool_check' AND c.conrelid = 'public.mcp_call_log'::regclass)",
                        'pg_temp.p_log()'))
    rb_bad = RB.replace("DELETE FROM public.mcp_call_log WHERE tool = 'list_all_deals';\n", '')
    assert rb_bad != RB
    print('MUTATION APPLIED ROLLBACK_no_delete (rollback text)\n  - DELETE FROM public.mcp_call_log WHERE tool = ...;')
    WANT['M_ROLLBACK_no_delete'] = 'red'
    b.append(block('M_ROLLBACK_no_delete', "    PERFORM pg_temp.la('a1');\n    v := pg_temp.p_rollback(%s);" % q(rb_bad)))
    return b


PROBES = ['p_iso', 'p_unconfirmed', 'p_removed', 'p_values', 'p_rowmax', 'p_mask', 'p_filters', 'p_args', 'p_tokens', 'p_ent', 'p_bound',
          'p_boundary', 'p_cursor_stable', 'p_ro', 'p_grants', 'p_log', 'p_rate']

FP = ("CREATE FUNCTION pg_temp.fp() RETURNS text LANGUAGE sql AS $h$\n"
      "  SELECT md5(coalesce((SELECT string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, '-') || ':' || p.provolatile::text\n"
      "     || ':' || p.proowner::regrole::text || ':' || p.prosecdef, ',' ORDER BY p.oid::regprocedure::text)\n"
      "     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_'), '')\n"
      "   || coalesce((SELECT string_agg(c.conname || '=' || pg_get_constraintdef(c.oid), ';' ORDER BY c.conname) FROM pg_constraint c\n"
      "     WHERE c.conrelid = 'public.mcp_call_log'::regclass), ''))\n$h$;\n")

ROLLBACK_PROBE = ("CREATE FUNCTION pg_temp.p_rollback(rb text) RETURNS text LANGUAGE plpgsql AS $rbp$\n"
                  "DECLARE f0 text := (SELECT v FROM pg_temp.p4263_out WHERE k = 'fp_after_apply'); chk text; gone boolean; e text := '';\n"
                  "BEGIN\n"
                  "  BEGIN\n    EXECUTE rb;\n  EXCEPTION WHEN OTHERS THEN e := 'rollback failed: ' || SQLERRM;\n  END;\n"
                  "  IF e <> '' THEN RETURN pg_temp.pass(false, e); END IF;\n"
                  "  gone := to_regprocedure('public.mcp_list_all_deals(text,bytea,text,text,text,text,text)') IS NULL\n"
                  "          AND to_regprocedure('public._mcp_r_list_all_deals(text,date,date,uuid)') IS NULL;\n"
                  "  chk := (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'public.mcp_call_log'::regclass AND c.conname = 'mcp_call_log_tool_check');\n"
                  "  EXECUTE pg_temp.t_mig();\n  EXECUTE pg_temp.t_mig();\n"
                  "  RETURN pg_temp.all_of(pg_temp.pass(gone, 'objects left'),\n"
                  "    pg_temp.pass(chk NOT LIKE '%%list_all_deals%%' AND chk LIKE '%%get_deal_checklists%%', chk),\n"
                  "    pg_temp.pass(pg_temp.fp() = f0, 'catalog after rollback, apply, apply differs'));\n"
                  "END $rbp$;\n")


def md5_control():
    exp = ',\n'.join("    (%s, %s)" % (lit(k), lit(v)) for k, v in sorted(ANON9.items()))
    return ("CREATE FUNCTION pg_temp.p_md5() RETURNS text LANGUAGE sql AS $h$\n"
            "  WITH e(sig, m) AS (VALUES\n" + exp + ")\n"
            "  SELECT pg_temp.all_of(\n"
            "    pg_temp.pass((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._mcp_r_list_all_deals(text,date,date,uuid)'::regprocedure) = %s, 'reader md5'),\n"
            "    pg_temp.pass((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.mcp_list_all_deals(text,bytea,text,text,text,text,text)'::regprocedure) = %s, 'tool md5'),\n"
            "    pg_temp.pass((SELECT bool_and(md5(p.prosrc) = e.m) AND count(*) = 9 FROM e JOIN pg_proc p ON p.oid = to_regprocedure('public.' || e.sig)), 'existing anon md5 changed'),\n"
            "    pg_temp.pass((SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_') = 41, 'mcp function count'))\n$h$;\n"
            ) % (lit(OFFLINE_MD5[READER]), lit(OFFLINE_MD5[TOOL]))


SIMULATE_APPLIED = '--simulate-applied' in sys.argv


def compose(with_mutants=True, only=None):
    head = ("SET LOCAL pg_stat_statements.track = 'none';\nSET LOCAL lock_timeout = '10s';\n"
            "CREATE TEMP TABLE p4263_out (k text, v text);\n"
            "INSERT INTO pg_temp.p4263_out SELECT 'PRE_anon_mcp', count(*)::text FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_' AND has_function_privilege('anon', p.oid, 'EXECUTE');\n"
            "INSERT INTO pg_temp.p4263_out SELECT 'PRE_mcp_function_count', count(*)::text FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_';\n"
            "INSERT INTO pg_temp.p4263_out SELECT 'PRE_ledger_4244', count(*)::text FROM supabase_migrations.schema_migrations WHERE version = '20261114110000';\n"
            "INSERT INTO pg_temp.p4263_out SELECT 'PRE_ledger_4263', count(*)::text FROM supabase_migrations.schema_migrations WHERE version = '20261118100000';\n"
            "INSERT INTO pg_temp.p4263_out SELECT 'PRE_4263_objects', count(*)::text FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('mcp_list_all_deals', '_mcp_r_list_all_deals');\n"
            "INSERT INTO pg_temp.p4263_out SELECT 'PRE_tool_check', pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'public.mcp_call_log'::regclass AND c.conname = 'mcp_call_log_tool_check';\n")
    # before the apply: 9 anon mcp functions and none of this migration's; after it: 10 and both
    guard = ("DO $grd4263$ BEGIN IF (SELECT v FROM pg_temp.p4263_out WHERE k = 'PRE_ledger_4244') IS DISTINCT FROM '1'\n"
             "  OR ((SELECT v FROM pg_temp.p4263_out WHERE k = 'PRE_anon_mcp'), (SELECT v FROM pg_temp.p4263_out WHERE k = 'PRE_4263_objects'))\n"
             "     NOT IN (('9', '0'), ('10', '2')) THEN\n"
             "  RAISE EXCEPTION 'P4263_STOP precondition: %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.p4263_out); END IF; END $grd4263$;\n")
    if SIMULATE_APPLIED:
        # the state after the real apply, inside this transaction: the migration and its ledger row first
        head = MIG + "\nINSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20261118100000', 'backlog_4263_mcp_list_all_deals');\n" + head
    text = head + guard + RB + '\n' + MIG + '\n' + MIG + '\n' + HL + '\n' + FX + '\n' + PR + '\n' + FP + md5_control()
    text += ("INSERT INTO pg_temp.p4263_out SELECT 'fp_after_apply', pg_temp.fp();\n"
             "INSERT INTO pg_temp.p4263_out SELECT 'BASE', pg_temp.base4263()::text;\n")
    text += ("CREATE FUNCTION pg_temp.t_mig() RETURNS text LANGUAGE sql IMMUTABLE AS $tm4263$ SELECT %s::text $tm4263$;\n"
             "CREATE FUNCTION pg_temp.t_rb() RETURNS text LANGUAGE sql IMMUTABLE AS $tr4263$ SELECT %s::text $tr4263$;\n") % (q2(MIG), q2(RB))
    text += ROLLBACK_PROBE
    b = [block('C_p_md5', '    v := pg_temp.p_md5();')]
    for p in PROBES:
        b.append(block('C_' + p, '    v := pg_temp.%s();' % p))
    b.append(block('C_p_rollback', "    PERFORM pg_temp.la('a1');\n    v := pg_temp.p_rollback(pg_temp.t_rb());"))
    caps = {'FX_all_a': "pg_temp.la('a1')", 'FX_all_b': "pg_temp.la('b1')", 'FX_all_a_closed': "pg_temp.la('a1', 'closed', '2026-01-01', '2026-12-31')",
            'FX_all_a_none': "pg_temp.la('a1', NULL, '2030-01-01')", 'FX_all_f_page1': "pg_temp.la('f1')",
            'FX_all_f_page2': "pg_temp.la('f1', NULL, NULL, NULL, pg_temp.ncur(pg_temp.la('f1')))"}
    for k, e in caps.items():
        b.append(block(k, '    v := %s;' % e))
    if with_mutants:
        ms = mutants()
        if only:
            ms = [m for m in ms if any(("'M_" + o) in m for o in only)]
        b += ms
    text += "DO $sw4263$\nDECLARE v text; t0 text;\nBEGIN\n" + ''.join(b) + "END\n$sw4263$;\n"
    text += "SELECT extensions.pg_stat_statements_reset();\n"
    text += "DO $fin4263$ BEGIN RAISE EXCEPTION 'P4263_RESULT %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.p4263_out); END $fin4263$;\n"
    text = text.replace('__RUN__', secrets.token_hex(12)).replace('__SECRET__', secrets.token_hex(32))
    assert '__RUN__' not in text and '__SECRET__' not in text
    return text


def apply_trial(path, brk):
    """the apply file without BEGIN/COMMIT, then a RAISE that reports whether the post-check passed"""
    a = open(path).read()
    assert a.count('\nBEGIN;\n') == 1 and a.count('\nCOMMIT;\n') == 1
    a = a.replace('\nBEGIN;\n', '\n').replace('\nCOMMIT;\n', '\n')
    if brk:
        m = "'" + OFFLINE_MD5[READER] + "'"
        assert a.count(m) == 1
        a = a.replace(m, "'" + '0' * 32 + "'")
        print('MUTATION APPLIED apply-trial expected reader md5 -> 000...')
    return ("SET LOCAL pg_stat_statements.track = 'none';\n" + a +
            "\nSELECT extensions.pg_stat_statements_reset();\n"
            "DO $t$ BEGIN RAISE EXCEPTION 'P4263_APPLY_TRIAL post-check passed; ledger rows=%, anon mcp=%', "
            "(SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261118100000'), "
            "(SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname ~ '^_?mcp_' AND has_function_privilege('anon', p.oid, 'EXECUTE')); END $t$;\n")


UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')


def normalise(res):
    """FX_* outputs with every uuid replaced by <id:n>, numbered in sorted order of the ids so that id order is kept"""
    allids = sorted({m for k in res if k.startswith('FX_') for m in UUID.findall(res[k])})
    ids = {u: '<id:%d>' % (i + 1) for i, u in enumerate(allids)}
    return {k: json.loads(UUID.sub(lambda m: ids[m.group(0)], res[k])) for k in sorted(res) if k.startswith('FX_')}


def run_sql(sql):
    import tempfile
    d = tempfile.mkdtemp()
    p = os.path.join(d, 'h.sql')
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as fh:
        fh.write(sql)
    out = subprocess.run([os.path.expanduser('~/.claude/bin/kt-sql'), p], capture_output=True, text=True)
    os.remove(p); os.rmdir(d)
    msg = out.stdout + out.stderr
    try:
        msg = json.loads(out.stdout.split('\nkt-sql:')[0])['message']
    except Exception:
        pass
    return msg


def main():
    args = sys.argv[2:]
    trial = next((a.split('=', 1)[1] for a in args if a.startswith('--apply-trial=')), None)
    if trial:
        sql = apply_trial(trial, '--break-md5' in args)
        if '--print' in args:
            print(sql); return
        msg = run_sql(sql)
        print(msg[:3000])
        ok = 'P4263_APPLY_TRIAL post-check passed' in msg
        sys.exit(0 if ok != ('--break-md5' in args) else 1)
    only = next((a.split('=', 1)[1].split(',') for a in args if a.startswith('--only=')), None)
    fx_path = next((a.split('=', 1)[1] for a in args if a.startswith('--fixtures=')), None)
    sql = compose(with_mutants='--no-mutants' not in args, only=only)
    print('composed: %d bytes, mutants %d' % (len(sql), len(WANT)))
    print('offline md5: ' + json.dumps(OFFLINE_MD5))
    if '--dump' in args:
        dd = args[args.index('--dump') + 1]
        os.makedirs(dd, exist_ok=True)
        open(os.path.join(dd, 'composed.sql'), 'w').write(sql)
    if '--print' in args:
        return
    import time
    t0 = time.time()
    msg = run_sql(sql)
    print('wall_s=%d' % (time.time() - t0))
    m = re.search(r'P4263_RESULT (\{.*\})', msg, re.S)
    if not m:
        print('NO RESULT: ' + msg[:4000]); sys.exit(1)
    res, _ = json.JSONDecoder().raw_decode(m.group(1))
    cf = cp = caught = missed = 0
    for k in sorted(res):
        v = res[k]
        if k.startswith('M_'):
            want = WANT.get(k, 'red')
            red = v.startswith('FAIL')
            ok = red if want == 'red' else (v == 'PASS')
            caught += ok; missed += (not ok)
            print('%-44s want=%-5s %s  %s' % (k, want, ('RED' if red else ('GREEN' if v == 'PASS' else 'OTHER')) + (' ok' if ok else ' UNEXPECTED'), v[:400]))
        elif k.startswith('C_'):
            ok = v == 'PASS'
            cp += ok; cf += (not ok)
            print('%-44s %s' % (k, v[:600]))
        elif k.startswith('FX_'):
            print('%-44s %d bytes %s' % (k, len(v), v[:90]))
        else:
            print('%-44s %s' % (k, v[:600]))
    print('CONTROLS pass=%d fail=%d total=%d' % (cp, cf, cp + cf))
    print('MUTANTS as_expected=%d unexpected=%d total=%d' % (caught, missed, caught + missed))
    if fx_path:
        with open(fx_path, 'w') as fh:
            json.dump(normalise(res), fh, indent=1, sort_keys=True, ensure_ascii=False)
            fh.write('\n')
        print('fixtures written: ' + os.path.basename(fx_path))
    sys.exit(1 if cf or missed or cp == 0 else 0)


main()
