#!/usr/bin/env python3
"""BACKLOG-4244: controls and mutants for the MCP data tools in ONE kt-sql call (one transaction ending in RAISE).

Usage: harness.py run [--print] [--only=<mutant prefix,...>] [--no-mutants] [--fixtures=<path>]

Order in the call: a read-only catalog record (signatures of the 13 cloud writes, this migration's objects),
a stop unless all 13 cloud writes have the p_expected_user_id signature (the test project must already hold
20261112190000 as edited), the rollback of this migration, this migration twice, lib/helpers.sql,
lib/fixtures.sql, lib/probes.sql, the fixtures, then every probe on the migration as written (C_*), the
outputs used by the portal schema test (FX_*), then every mutant (M_*): each in a subtransaction, applied,
checked in the catalog (md5(prosrc), ACL or relrowsecurity) before its probe runs, then undone.
The call ends with extensions.pg_stat_statements_reset() and a RAISE, so nothing persists.

Each mutant is an exact-string replace on the text of one function read from the working tree; a fragment
that does not match its stated count stops the script before anything is sent.
A mutant is caught when its probe returns FAIL. Mutants marked want=green are expected to stay green
(the other isolation layer, or a constraint, makes them equivalent) and are kept so the claim stays checked.
"""
import hashlib, json, os, re, secrets, subprocess, sys

here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
rd = lambda p: open(os.path.join(root, p)).read()
MIGP = 'supabase/migrations/20261114110000_backlog_4244_mcp_data_tools.sql'
MIG = rd(MIGP)
M1 = rd('supabase/migrations/20261112180000_backlog_4236_cloud_autosave_feature_keys.sql')
M2 = rd('supabase/migrations/20261112190000_backlog_4236_cloud_autosave_schema.sql')
RB = rd('supabase/tests/backlog-4244/rollback-4244.sql')
HL, FX, PR = (rd('supabase/tests/backlog-4244/lib/' + f) for f in ('helpers.sql', 'fixtures.sql', 'probes.sql'))
TAG = '$swp4244$'
for t in (MIG, M1, M2, RB, HL, FX, PR):
    assert TAG not in t

WRITES = ['set_my_cloud_autosave', 'cloud_delete_install', 'cloud_upsert_deal', 'cloud_upsert_parties', 'cloud_upsert_checklists',
          'cloud_upsert_checklist_items', 'cloud_upsert_messages', 'cloud_upsert_files', 'cloud_tombstone', 'cloud_delete_deal',
          'cloud_mark_deal_synced', 'cloud_register_blob', 'cloud_confirm_blob']
READERS = ['_mcp_r_list_deals', '_mcp_r_get_deal', '_mcp_r_deal_checklists']


def lit(s):
    return "'" + s.replace("'", "''") + "'"


def q(s):
    return TAG + s + TAG


TAG2 = '$rbt4244$'


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


def apply_in(name, old, new, cnt, mode):
    u, src, sig = unit(MIG, name)
    n = u.count(old)
    if n != cnt:
        raise SystemExit('MUTATION NOT APPLIED %s: fragment matched %d times in %s (want %d): %r' % (mode, n, name, cnt, old[:100]))
    mu = u.replace(old, new)
    assert mu != u
    print('MUTATION APPLIED %s (%s)' % (mode, name))
    for l in old.splitlines():
        print('  - ' + l.strip()[:160])
    for l in new.splitlines():
        print('  + ' + l.strip()[:160])
    _, msrc, _ = unit(mu, name)
    MUTATED.append((mode, mu))
    return mu, msrc, sig


def create(name, text):
    if name in READERS:
        return ("    EXECUTE 'GRANT CREATE ON SCHEMA public TO mcp_reader';\n    EXECUTE 'SET ROLE mcp_reader';\n"
                "    EXECUTE %s;\n    EXECUTE 'RESET ROLE';\n    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM mcp_reader';\n") % q(text)
    return '    EXECUTE %s;\n' % q(text)


def block(key, body):
    """one subtransaction whose body sets v; the subtransaction is undone, then key -> v is recorded"""
    return ('  v := NULL;\n  BEGIN\n%s\n    RAISE EXCEPTION USING ERRCODE = %s;\n'
            '  EXCEPTION WHEN SQLSTATE %s THEN NULL;\n    WHEN OTHERS THEN EXECUTE %s; v := %s || SQLSTATE || %s || SQLERRM;\n  END;\n'
            '  INSERT INTO pg_temp.p4244_out VALUES (%s, coalesce(v, %s));\n'
            ) % (body, lit('T4244'), lit('T4244'), lit('RESET ROLE'), lit('CRASH '), lit(' '), lit(key), lit('NULL (body set nothing)'))


WANT = {}
MUTATED = []


def fn_mutant(mode, name, old, new, probe, cnt=1, want='red', pre=''):
    mu, msrc, sig = apply_in(name, old, new, cnt, mode)
    WANT['M_' + mode] = want
    body = pre + create(name, mu) + (
        "    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(%s)) IS DISTINCT FROM %s THEN\n"
        "      v := 'NOT APPLIED IN DB';\n    ELSE\n      v := %s;\n    END IF;") % (lit(sig), lit(md5(msrc)), probe)
    return block('M_' + mode, body)


def ddl_mutant(mode, sql, verify, probe, want='red'):
    """sql is run as the database owner; verify is a boolean SQL expression that is true once it applied"""
    WANT['M_' + mode] = want
    print('MUTATION APPLIED %s (ddl)\n  + %s' % (mode, sql.strip()[:200]))
    body = ('    EXECUTE %s;\n    IF (%s) IS NOT TRUE THEN\n      v := \'NOT APPLIED IN DB\';\n    ELSE\n      v := %s;\n    END IF;'
            % (q(sql), verify, probe))
    return block('M_' + mode, body)


def combo_mutant(mode, sql, verify, name, old, new, probe, want='red', cnt=1):
    mu, msrc, sig = apply_in(name, old, new, cnt, mode)
    print('  + ddl: ' + sql.strip()[:200])
    WANT['M_' + mode] = want
    body = '    EXECUTE %s;\n' % q(sql) + create(name, mu) + (
        "    IF (%s) IS NOT TRUE OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(%s)) IS DISTINCT FROM %s THEN\n"
        "      v := 'NOT APPLIED IN DB';\n    ELSE\n      v := %s;\n    END IF;") % (verify, lit(sig), lit(md5(msrc)), probe)
    return block('M_' + mode, body)


def acl_mutant(mode, sql, probe='pg_temp.p_grants()', want='red', sig=None):
    WANT['M_' + mode] = want
    print('MUTATION APPLIED %s (acl)\n  + %s' % (mode, sql.strip()))
    body = ("    t0 := (SELECT coalesce(proacl::text, 'null') FROM pg_proc WHERE oid = to_regprocedure(%s));\n    EXECUTE %s;\n"
            "    IF (SELECT coalesce(proacl::text, 'null') FROM pg_proc WHERE oid = to_regprocedure(%s)) IS NOT DISTINCT FROM t0 THEN\n"
            "      v := 'NOT APPLIED IN DB (acl unchanged)';\n    ELSE\n      v := %s;\n    END IF;") % (lit(sig), q(sql), lit(sig), probe)
    return block('M_' + mode, body)


def own_site(tag):
    m = re.findall(r'(\w+\.owner_user_id = v_uid /\*OWN:%s\*/)' % tag, MIG)
    assert len(m) == 1, (tag, m)
    return m[0]


def fn_of_tag(tag):
    marker = '/*%s*/' % tag
    for name in re.findall(r'CREATE OR REPLACE FUNCTION public\.(\w+)\(', MIG):
        if marker in unit(MIG, name)[0]:
            return name
    raise SystemExit('no function holds ' + marker)


def rls_off(table):
    return ('ALTER TABLE public.%s DISABLE ROW LEVEL SECURITY' % table,
            "(SELECT NOT relrowsecurity FROM pg_class WHERE oid = 'public.%s'::regclass)" % table)


PROBES = ['p_list_a', 'p_order_a', 'p_iso', 'p_ent', 'p_notice', 'p_disabled', 'p_tokens', 'p_no_claims', 'p_withheld', 'p_removed',
          'p_unconfirmed', 'p_limits', 'p_paging', 'p_people_cap', 'p_masking', 'p_dates', 'p_fresh', 'p_saved_from', 'p_null_install',
          'p_checklists', 'p_log', 'p_grants', 'p_checks', 'p_rollback']

ROLLBACK_PROBE = ("CREATE FUNCTION pg_temp.p_rollback() RETURNS text LANGUAGE plpgsql AS $rbp$\n"
                  "DECLARE f0 text := (SELECT v FROM pg_temp.p4244_out WHERE k = 'fp_after_apply'); r text; gone boolean; chk text; e text := '';\n"
                  "BEGIN\n"
                  "  r := pg_temp.ld('a1');\n"
                  "  BEGIN\n    EXECUTE %s;\n  EXCEPTION WHEN OTHERS THEN e := 'rollback failed: ' || SQLERRM;\n  END;\n"
                  "  IF e <> '' THEN RETURN pg_temp.pass(false, e); END IF;\n"
                  "  gone := to_regprocedure('public.mcp_list_deals(text,bytea,text,text,text,integer,text)') IS NULL\n"
                  "          AND to_regprocedure('public._mcp_r_get_deal(uuid)') IS NULL AND to_regprocedure('public._mcp_clean(text,integer)') IS NULL;\n"
                  "  chk := (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'public.mcp_call_log'::regclass AND c.conname = 'mcp_call_log_tool_check');\n"
                  "  EXECUTE %s;\n  EXECUTE %s;\n"
                  "  RETURN pg_temp.all_of(pg_temp.pass(pg_temp.err(r) = 'OK', left(r, 100)), pg_temp.pass(gone, 'objects left'),\n"
                  "    pg_temp.pass(chk NOT LIKE '%%list_deals%%' AND chk LIKE '%%get_status%%', chk),\n"
                  "    pg_temp.pass(pg_temp.fp() = f0, 'catalog after rollback, apply, apply differs'));\n"
                  "END $rbp$;\n")


def mutants():
    b = []
    P = 'pg_temp.p_iso()'
    # ---- (1) isolation: the owner term, row level security, and both
    own = {'list_inst': 'cloud_deals', 'list_deals': 'cloud_deals', 'list_people': 'cloud_deal_parties', 'list_todos': 'cloud_deal_checklist_items',
           'list_copy': 'cloud_deals', 'get_deal': 'cloud_deals', 'get_inst': 'cloud_deals', 'get_people': 'cloud_deal_parties',
           'cl_deal': 'cloud_deals', 'cl_lists': 'cloud_deal_checklists', 'cl_items': 'cloud_deal_checklist_items', 'cl_total': 'cloud_deal_checklist_items'}
    # child reads under an owned deal: the composite key (cloud_deal_id, owner_user_id) makes the owner term redundant
    equivalent_even_without_rls = {'list_people', 'list_todos', 'get_people', 'cl_lists', 'cl_items', 'cl_total'}
    for tag, table in own.items():
        site = own_site(tag)
        name = fn_of_tag('OWN:' + tag)
        new = 'true /*OWN:%s*/' % tag
        b.append(fn_mutant('ISO_owner_term_only_' + tag, name, site, new, P, want='green'))
        sql, ver = rls_off(table)
        b.append(combo_mutant('ISO_owner_term_and_rls_' + tag, sql, ver, name, site, new, P,
                              want='green' if tag in equivalent_even_without_rls else 'red'))
    for table in ('cloud_deals', 'cloud_deal_parties', 'cloud_deal_checklists', 'cloud_deal_checklist_items'):
        sql, ver = rls_off(table)
        b.append(ddl_mutant('ISO_rls_only_' + table, sql, ver, P, want='green'))
    b.append(ddl_mutant('ISO_allow_all_policy_deals', 'CREATE POLICY p4244_all ON public.cloud_deals FOR SELECT TO authenticated USING (true)',
                        "(SELECT count(*) FROM pg_policies WHERE tablename = 'cloud_deals' AND policyname = 'p4244_all') = 1", P, want='green'))
    b.append(combo_mutant('ISO_bypassrls_and_owner_term_list_deals', 'ALTER ROLE mcp_reader BYPASSRLS',
                          "(SELECT rolbypassrls FROM pg_roles WHERE rolname = 'mcp_reader')", '_mcp_r_list_deals',
                          own_site('list_deals'), 'true /*OWN:list_deals*/', P))
    # a join that multiplies rows: install numbering without GROUP BY
    b.append(fn_mutant('ISO_inst_not_grouped', '_mcp_r_list_deals',
                       "SELECT x.source_install_id, row_number() OVER (ORDER BY min(x.created_at), x.source_install_id) AS n\n        FROM public.cloud_deals x\n       WHERE x.owner_user_id = v_uid /*OWN:list_inst*/ AND x.source_install_id IS NOT NULL\n       GROUP BY x.source_install_id),",
                       "SELECT x.source_install_id, row_number() OVER (ORDER BY x.created_at, x.source_install_id) AS n\n        FROM public.cloud_deals x\n       WHERE x.owner_user_id = v_uid /*OWN:list_inst*/ AND x.source_install_id IS NOT NULL),",
                       'pg_temp.p_list_a()'))
    # ---- (2) entitlement, gate, tokens
    lic = "\n     OR (v_st -> 'licensed') IS DISTINCT FROM to_jsonb(true)"
    ena = "\n     OR (v_st -> 'settings' -> 'enabled') IS DISTINCT FROM to_jsonb(true)"
    whole = ("  IF (v_st -> 'schema_version') IS DISTINCT FROM to_jsonb(1)" + lic + ena + " THEN\n    RETURN '{\"not_entitled\":true}'::jsonb;\n  END IF;\n")
    for r in READERS:
        b.append(fn_mutant('ENT_no_check_' + r, r, whole, '', 'pg_temp.p_ent()'))
    b.append(fn_mutant('ENT_no_licensed_term_list', '_mcp_r_list_deals', lic, '', 'pg_temp.p_ent()'))
    b.append(fn_mutant('ENT_no_enabled_term_list', '_mcp_r_list_deals', ena, '', 'pg_temp.p_ent()'))
    b.append(fn_mutant('ENT_entitled_instead_of_licensed_list', '_mcp_r_list_deals', lic, "\n     OR (v_st -> 'entitled') IS DISTINCT FROM to_jsonb(true)", 'pg_temp.p_notice()'))
    nul = "  IF v_uid IS NULL THEN\n    RETURN '{\"not_entitled\":true}'::jsonb;\n  END IF;\n"
    for r in READERS:
        b.append(fn_mutant('NOCLAIMS_no_null_check_' + r, r, nul, '', 'pg_temp.p_no_claims()'))
    b.append(fn_mutant('GATE_no_secret_check_get_deal', 'mcp_get_deal',
                       "  IF public._mcp_secret_ok(p_secret) IS NOT TRUE THEN\n    RETURN public._mcp_refuse('not_connected');\n  END IF;\n", '', 'pg_temp.p_tokens()'))
    b.append(fn_mutant('GATE_outcome_ignored_list', 'mcp_list_deals',
                       "  IF g.outcome IS DISTINCT FROM 'ok' THEN\n    RETURN public._mcp_refuse(g.outcome);\n  END IF;\n", '', 'pg_temp.p_tokens()'))
    b.append(fn_mutant('GATE_outcome_ignored_checklists_disabled', 'mcp_get_deal_checklists',
                       "  IF g.outcome IS DISTINCT FROM 'ok' THEN\n    RETURN public._mcp_refuse(g.outcome);\n  END IF;\n", '', 'pg_temp.p_disabled()'))
    # ---- (3) withheld people
    for f, old, new in [('name', "CASE WHEN p.w THEN NULL ELSE public._mcp_clean(p.display_name, 200) END /*WITHHELD:name*/", "public._mcp_clean(p.display_name, 200)"),
                        ('company', "CASE WHEN p.w THEN NULL ELSE public._mcp_clean(p.company, 200) END /*WITHHELD:company*/", "public._mcp_clean(p.company, 200)"),
                        ('emails', "CASE WHEN p.w THEN '[]'::jsonb /*WITHHELD:emails*/ ELSE coalesce", "CASE WHEN false THEN '[]'::jsonb ELSE coalesce"),
                        ('phones', "CASE WHEN p.w THEN '[]'::jsonb /*WITHHELD:phones*/ ELSE coalesce", "CASE WHEN false THEN '[]'::jsonb ELSE coalesce")]:
        b.append(fn_mutant('WITHHELD_not_blanked_' + f, '_mcp_r_get_deal', old, new, 'pg_temp.p_withheld()'))
    b.append(fn_mutant('WITHHELD_notes_blanked_too', '_mcp_r_get_deal', "'notes', public._mcp_clean(p.notes, 1000),",
                       "'notes', CASE WHEN p.w THEN NULL ELSE public._mcp_clean(p.notes, 1000) END,", 'pg_temp.p_withheld()'))
    # ---- (4) removed and unconfirmed rows
    for tag in ('list_people', 'list_todos', 'get_people', 'cl_lists', 'cl_items', 'cl_total'):
        m = re.findall(r'( AND \w+\.removed_at IS NULL /\*LIVE:%s\*/)' % tag, MIG)
        assert len(m) == 1, tag
        b.append(fn_mutant('LIVE_dropped_' + tag, fn_of_tag('LIVE:' + tag), m[0], '', 'pg_temp.p_removed()'))
    for tag, name in (('list', '_mcp_r_list_deals'), ('get_deal', '_mcp_r_get_deal'), ('cl', '_mcp_r_deal_checklists')):
        m = re.findall(r'( AND \w+\.is_confirmed /\*CONF:%s\*/)' % tag, MIG)
        assert len(m) == 1, tag
        b.append(fn_mutant('CONF_dropped_' + tag, name, m[0], '', 'pg_temp.p_unconfirmed()'))
    # ---- (6) input limits and paging
    for tag, name, old in [('limit', 'mcp_list_deals', "     OR (v_lim BETWEEN 1 AND 50) IS NOT TRUE /*ARG:limit*/\n"),
                           ('status', 'mcp_list_deals', "(p_status IS NULL OR p_status IN ('active', 'pending', 'closed')) IS NOT TRUE /*ARG:status*/\n     OR "),
                           ('address', 'mcp_list_deals', "     OR (p_address_contains IS NULL OR char_length(p_address_contains) BETWEEN 2 AND 100) IS NOT TRUE /*ARG:address*/\n"),
                           ('cursor_shape', 'mcp_list_deals', "\n         AND p_cursor ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z\\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'"),
                           ('deal_id', 'mcp_get_deal', "  IF (p_deal_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') IS NOT TRUE /*ARG:deal_id*/ THEN\n    PERFORM public._mcp_finish(g.call_id, 'invalid_input', 0, v_t0);\n    RETURN public._mcp_refuse('invalid_input');\n  END IF;\n"),
                           ('checklist_id', 'mcp_get_deal_checklists', "\n     OR (p_checklist_id IS NULL\n         OR p_checklist_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') IS NOT TRUE /*ARG:checklist_id*/")]:
        b.append(fn_mutant('ARG_dropped_' + tag, name, old, '', 'pg_temp.p_limits()'))
    b.append(fn_mutant('PAGE_order_ascending', '_mcp_r_list_deals', 'ORDER BY dl.last_synced_at DESC, dl.id DESC /*ORDER:list*/',
                       'ORDER BY dl.last_synced_at ASC, dl.id ASC /*ORDER:list*/', 'pg_temp.p_paging()'))
    b.append(fn_mutant('PAGE_no_people_byte_budget', '_mcp_r_get_deal', "SELECT jsonb_agg(s.j ORDER BY s.rn) FROM s WHERE s.cum <= 60000",
                       "SELECT jsonb_agg(s.j ORDER BY s.rn) FROM s", 'pg_temp.p_people_cap()'))
    # ---- masking, caps, dates
    b.append(fn_mutant('MASK_person_notes_plain', '_mcp_r_get_deal', "'notes', public._mcp_clean(p.notes, 1000),", "'notes', p.notes,", 'pg_temp.p_masking()'))
    b.append(fn_mutant('MASK_item_note_plain', '_mcp_r_deal_checklists', "'note', public._mcp_clean(i.note, 1000),", "'note', i.note,", 'pg_temp.p_masking()'))
    b.append(fn_mutant('MASK_item_title_plain', '_mcp_r_deal_checklists', "'title', public._mcp_clean(i.title, 300),", "'title', i.title,", 'pg_temp.p_masking()'))
    b.append(fn_mutant('MASK_item_description_plain', '_mcp_r_deal_checklists', "'description', public._mcp_clean(i.description, 1000),",
                       "'description', i.description,", 'pg_temp.p_masking()'))
    b.append(fn_mutant('MASK_phone_masked', '_mcp_r_get_deal', "public._mcp_txt(el ->> 'e164', 40)", "public._mcp_clean(el ->> 'e164', 40)", 'pg_temp.p_masking()'))
    b.append(fn_mutant('MASK_no_luhn', '_mcp_mask', '    IF v_sum % 10 = 0 THEN', '    IF true THEN', 'pg_temp.p_masking()'))
    b.append(fn_mutant('MASK_no_cut', '_mcp_txt', 'CASE WHEN char_length(s.x) > p_max THEN', 'CASE WHEN false THEN', 'pg_temp.p_masking()'))
    b.append(fn_mutant('MASK_no_strip', '_mcp_clean', "public._mcp_mask(regexp_replace(p, '[\\u0001-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', '', 'g'))",
                       'public._mcp_mask(p)', 'pg_temp.p_masking()', want='green'))
    b.append(fn_mutant('DATE_local_zone', '_mcp_day', "to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD')", "to_char(p, 'YYYY-MM-DD')", 'pg_temp.p_dates()'))
    # ---- (7) freshness
    for tag, name, a in (('list', '_mcp_r_list_deals', 'pr'), ('get', '_mcp_r_get_deal', 'v_deal')):
        old = 'WHEN %s.last_synced_at IS DISTINCT FROM %s.last_full_sync_at THEN' % (a, a)
        b.append(fn_mutant('FRESH_inverted_' + tag, name, old, 'WHEN %s.last_synced_at < %s.last_full_sync_at THEN' % (a, a), 'pg_temp.p_fresh()'))
        b.append(fn_mutant('FRESH_greater_than_' + tag, name, old, 'WHEN %s.last_synced_at > %s.last_full_sync_at THEN' % (a, a), 'pg_temp.p_fresh()', want='green'))
        b.append(fn_mutant('FRESH_updated_at_' + tag, name, old, 'WHEN %s.updated_at > %s.last_full_sync_at THEN' % (a, a), 'pg_temp.p_fresh()'))
        b.append(fn_mutant('FRESH_marked_means_full_' + tag, name, old, 'WHEN false THEN', 'pg_temp.p_fresh()'))
    # ---- (5) install: NULL install and numbering
    b.append(fn_mutant('NULLINST_inner_join_list', '_mcp_r_list_deals', 'FROM pr LEFT JOIN inst i ON', 'FROM pr JOIN inst i ON', 'pg_temp.p_null_install()'))
    b.append(fn_mutant('NULLINST_null_group_numbered_list', '_mcp_r_list_deals', ' /*OWN:list_inst*/ AND x.source_install_id IS NOT NULL', ' /*OWN:list_inst*/',
                       'pg_temp.p_null_install()'))
    b.append(fn_mutant('NULLINST_equality_get', '_mcp_r_get_deal', 'WHERE i.source_install_id IS NOT DISTINCT FROM v_deal.source_install_id;',
                       'WHERE i.source_install_id = v_deal.source_install_id;', 'pg_temp.p_null_install()', want='green'))
    # ---- checklists
    b.append(fn_mutant('CL_checklist_not_on_deal', '_mcp_r_deal_checklists', ' AND c.cloud_deal_id = p_deal_id /*CL:on_deal*/', '', 'pg_temp.p_checklists()'))
    # ---- reader shape, writes, volatility
    b.append(fn_mutant('READER_volatile', '_mcp_r_list_deals', 'RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER', 'RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER',
                       'pg_temp.p_list_a()'))
    b.append(fn_mutant('READER_writes', '_mcp_r_list_deals', "  RETURN (\n    WITH inst AS (",
                       "  INSERT INTO public.mcp_call_log (event, outcome) VALUES ('call', 'ok');\n  RETURN (\n    WITH inst AS (", 'pg_temp.p_list_a()'))
    # ---- log CHECK, grants, rollback
    b.append(ddl_mutant('LOG_tool_check_not_widened',
                        "ALTER TABLE public.mcp_call_log DROP CONSTRAINT mcp_call_log_tool_check; ALTER TABLE public.mcp_call_log ADD CONSTRAINT mcp_call_log_tool_check CHECK (tool IS NULL OR tool IN ('get_status'))",
                        "(SELECT pg_get_constraintdef(c.oid) NOT LIKE '%list_deals%' FROM pg_constraint c WHERE c.conname = 'mcp_call_log_tool_check' AND c.conrelid = 'public.mcp_call_log'::regclass)",
                        'pg_temp.p_log()'))
    b.append(acl_mutant('ACL_tool_to_authenticated', 'GRANT EXECUTE ON FUNCTION public.mcp_list_deals(text, bytea, text, text, text, integer, text) TO authenticated',
                        sig='public.mcp_list_deals(text,bytea,text,text,text,integer,text)'))
    b.append(acl_mutant('ACL_reader_to_anon', 'SET ROLE mcp_reader; GRANT EXECUTE ON FUNCTION public._mcp_r_get_deal(uuid) TO anon; RESET ROLE',
                        sig='public._mcp_r_get_deal(uuid)'))
    b.append(acl_mutant('ACL_helper_to_public', 'GRANT EXECUTE ON FUNCTION public._mcp_clean(text, integer) TO PUBLIC', sig='public._mcp_clean(text,integer)'))
    rb_bad = RB.replace("DELETE FROM public.mcp_call_log\n WHERE tool IN ('list_deals', 'get_deal', 'get_deal_checklists') OR outcome IN ('invalid_input', 'not_found', 'too_large');\n", '')
    assert rb_bad != RB
    print('MUTATION APPLIED ROLLBACK_no_delete (rollback text)\n  - DELETE FROM public.mcp_call_log WHERE tool IN (...) OR outcome IN (...);')
    WANT['M_ROLLBACK_no_delete'] = 'red'
    b.append(block('M_ROLLBACK_no_delete', '    EXECUTE %s;\n    v := pg_temp.p_rollback();' % q(ROLLBACK_PROBE.replace('CREATE FUNCTION pg_temp.p_rollback()', 'CREATE OR REPLACE FUNCTION pg_temp.p_rollback()') % (q2(rb_bad), q2(MIG), q2(MIG)))))
    return b


def compose(with_mutants=True, only=None):
    head = ("SET LOCAL pg_stat_statements.track = 'none';\nSET LOCAL lock_timeout = '10s';\n"
            "CREATE TEMP TABLE p4244_out (k text, v text);\n"
            "INSERT INTO pg_temp.p4244_out SELECT 'PRE_server_version', current_setting('server_version');\n"
            "INSERT INTO pg_temp.p4244_out SELECT 'PRE_cloud_writes_new_signature', count(*)::text FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace\n"
            "  AND p.proname = ANY (%s::text[]) AND p.proargnames[1] = 'p_expected_user_id';\n"
            "INSERT INTO pg_temp.p4244_out SELECT 'PRE_cloud_writes_old_signature', count(*)::text FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace\n"
            "  AND p.proname = ANY (%s::text[]) AND p.proargnames[1] IS DISTINCT FROM 'p_expected_user_id';\n"
            "INSERT INTO pg_temp.p4244_out SELECT 'PRE_4244_objects', count(*)::text FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace\n"
            "  AND p.proname IN ('mcp_list_deals','mcp_get_deal','mcp_get_deal_checklists','_mcp_r_list_deals','_mcp_r_get_deal','_mcp_r_deal_checklists','_mcp_txt','_mcp_mask','_mcp_clean','_mcp_ts','_mcp_day');\n"
            "INSERT INTO pg_temp.p4244_out SELECT 'PRE_call_log_checks', string_agg(c.conname || '=' || pg_get_constraintdef(c.oid), '; ' ORDER BY c.conname) FROM pg_constraint c\n"
            "  WHERE c.conrelid = 'public.mcp_call_log'::regclass AND c.contype = 'c';\n"
            "INSERT INTO pg_temp.p4244_out SELECT 'PRE_ledger_4244', count(*)::text FROM supabase_migrations.schema_migrations WHERE version = '20261114110000';\n"
            ) % (lit('{' + ','.join(WRITES) + '}'), lit('{' + ','.join(WRITES) + '}'))
    # the test project holds the edited cloud migration (committed): stop unless all 13 writes have the new signature
    guard = ("DO $grd4244$ BEGIN IF (SELECT v FROM pg_temp.p4244_out WHERE k = 'PRE_cloud_writes_new_signature') IS DISTINCT FROM '13'\n"
             "  OR (SELECT v FROM pg_temp.p4244_out WHERE k = 'PRE_cloud_writes_old_signature') IS DISTINCT FROM '0' THEN\n"
             "  RAISE EXCEPTION 'P4244_STOP cloud writes not at the new signatures: %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.p4244_out); END IF; END $grd4244$;\n")
    text = head + guard + RB + '\n' + MIG + '\n' + MIG + '\n' + HL + '\n' + FX + '\n' + PR + '\n'
    text += ("INSERT INTO pg_temp.p4244_out SELECT 'fp_after_apply', pg_temp.fp();\n"
             "INSERT INTO pg_temp.p4244_out SELECT 'BASE', pg_temp.base4244()::text;\n")
    text += ROLLBACK_PROBE % (q2(RB), q2(MIG), q2(MIG))
    b = []
    for p in PROBES:
        b.append(block('C_' + p, '    v := pg_temp.%s();' % p))
    caps = {'FX_list_a': "pg_temp.ld('a1')", 'FX_list_b': "pg_temp.ld('b1')", 'FX_list_e_page1': "pg_temp.ld('e1', NULL, NULL, 2)",
            'FX_get_d1': "pg_temp.gd('a1', pg_temp.id('D1')::text)", 'FX_get_d2': "pg_temp.gd('a1', pg_temp.id('D2')::text)",
            'FX_get_d4': "pg_temp.gd('a1', pg_temp.id('D4')::text)", 'FX_cl_d1': "pg_temp.gc('a1', pg_temp.id('D1')::text)",
            'FX_cl_d4': "pg_temp.gc('a1', pg_temp.id('D4')::text)", 'FX_cl_d1_open': "pg_temp.gc('a1', pg_temp.id('D1')::text, true)"}
    for k, e in caps.items():
        b.append(block(k, '    v := %s;' % e))
    b.append(block('FX_list_null_install', "    PERFORM pg_temp.null_install_deal();\n    v := pg_temp.ld('a1');"))
    b.append(block('FX_get_null_install', "    v := pg_temp.gd('a1', pg_temp.null_install_deal()::text);"))
    if with_mutants:
        ms = mutants()
        if only:
            ms = [m for m in ms if any(("'M_" + o) in m for o in only)]
        b += ms
    text += "DO $sw4244$\nDECLARE v text; t0 text;\nBEGIN\n" + ''.join(b) + "END\n$sw4244$;\n"
    text += "SELECT extensions.pg_stat_statements_reset();\n"
    text += "DO $fin4244$ BEGIN RAISE EXCEPTION 'P4244_RESULT %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.p4244_out); END $fin4244$;\n"
    text = text.replace('__RUN__', secrets.token_hex(12)).replace('__SECRET__', secrets.token_hex(32))
    assert '__RUN__' not in text and '__SECRET__' not in text
    return text


UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
TS = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z')


def normalise(res):
    """FX_* outputs with every uuid replaced by <id:n> (the portal test builds an id from n) and every instant from the run by a fixed one"""
    ids, tss = {}, {}
    fixed_ts = {'2026-10-06T15:30:00.000000Z'}

    def uid(m):
        ids.setdefault(m.group(0), '<id:%d>' % (len(ids) + 1))
        return ids[m.group(0)]

    def ts(m):
        if m.group(0) in fixed_ts:
            return m.group(0)
        tss.setdefault(m.group(0), '2026-11-01T00:00:%02d.000000Z' % (len(tss) + 1))
        return tss[m.group(0)]
    out = {}
    for k in sorted(res):
        if not k.startswith('FX_'):
            continue
        s = TS.sub(ts, UUID.sub(uid, res[k]))
        out[k] = json.loads(s)
    return out


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'run'
    assert mode == 'run'
    only = None
    fx_path = None
    for a in sys.argv[2:]:
        if a.startswith('--only='):
            only = a.split('=', 1)[1].split(',')
        if a.startswith('--fixtures='):
            fx_path = a.split('=', 1)[1]
    sql = compose(with_mutants='--no-mutants' not in sys.argv, only=only)
    print('composed: %d bytes, mutants %d' % (len(sql), len(WANT)))
    if '--dump' in sys.argv:
        dd = sys.argv[sys.argv.index('--dump') + 1]
        os.makedirs(dd, exist_ok=True)
        open(os.path.join(dd, 'composed.sql'), 'w').write(sql)
        for mode, mu in MUTATED:
            open(os.path.join(dd, 'mut_' + mode + '.sql'), 'w').write(mu)
    if '--print' in sys.argv:
        return
    import tempfile, time
    d = tempfile.mkdtemp()
    p = os.path.join(d, 'h.sql')
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as fh:
        fh.write(sql)
    t0 = time.time()
    out = subprocess.run([os.path.expanduser('~/.claude/bin/kt-sql'), p], capture_output=True, text=True)
    os.remove(p); os.rmdir(d)
    msg = out.stdout + out.stderr
    try:
        msg = json.loads(out.stdout.split('\nkt-sql:')[0])['message']
    except Exception:
        pass
    m = re.search(r'P4244_RESULT (\{.*\})', msg, re.S)
    print('wall_s=%d' % (time.time() - t0))
    if not m:
        print('NO RESULT: ' + msg[:4000]); sys.exit(1)
    res, _ = json.JSONDecoder().raw_decode(m.group(1))
    cf = cp = 0
    caught = missed = 0
    for k in sorted(res):
        v = res[k]
        if k.startswith('M_'):
            want = WANT.get(k, 'red')
            red = v.startswith('FAIL')
            ok = red if want == 'red' else (v == 'PASS')
            caught += ok; missed += (not ok)
            print('%-62s want=%-5s %s  %s' % (k, want, ('RED' if red else ('GREEN' if v == 'PASS' else 'OTHER')) + (' ok' if ok else ' UNEXPECTED'), v[:240]))
        elif k.startswith('C_'):
            ok = v == 'PASS'
            cp += ok; cf += (not ok)
            print('%-62s %s' % (k, v[:600]))
        elif k.startswith('FX_'):
            print('%-62s %d bytes %s' % (k, len(v), v[:100]))
        else:
            print('%-62s %s' % (k, v[:600]))
    print('CONTROLS pass=%d fail=%d total=%d' % (cp, cf, cp + cf))
    print('MUTANTS as_expected=%d unexpected=%d total=%d' % (caught, missed, caught + missed))
    if fx_path:
        with open(fx_path, 'w') as fh:
            json.dump(normalise(res), fh, indent=1, sort_keys=True, ensure_ascii=False)
            fh.write('\n')
        print('fixtures written: ' + fx_path)
    sys.exit(1 if cf or missed or cp == 0 else 0)


main()
