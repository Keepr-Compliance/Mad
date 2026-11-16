#!/usr/bin/env python3
"""BACKLOG-4243 PR-0 mutation sweep: many mutants in ONE kt-sql call (one transaction ending in RAISE).

Usage: sweep-4243.py fn       function and grant mutants (C0.1, C0.3, C0.5-C0.7) against the base fixtures
       sweep-4243.py ddl      on the test project's committed state first: the edited migration re-run and
                              the rollback, rehearsed (C0.2 live, C0.9, C0.10); then the upgrade fixture
                              (C0.2: migration as at UPGRADE_FROM, then the edited one) and the rollback
                              (C0.4) with their mutants
       sweep-4243.py withheld   details_withheld: the edited migration rehearsed over the committed state; the
                              re-run over the migration as at WITHHELD_FROM with a stored party row; the rollback
                              then that earlier file; with their mutants
       sweep-4243.py <mode> --print   compose only, print the SQL size, run nothing
       sweep-4243.py ddl --c02=set,files,confirm   only these C0.2 drop mutants (payload size)

Each mutant is an exact-string replace on the text of the migration or rollback read from the working
tree; a fragment that does not match its stated count stops the script before anything is sent. The
script prints MUTATION APPLIED and the changed lines for each. In the database each function mutant is
created in a subtransaction and checked by md5(prosrc) (or by its ACL for grant mutants) before its
probe runs; the subtransaction is then undone. Every probe returns PASS or FAIL; a mutant is caught when
its probe returns FAIL. The call ends in RAISE, so nothing persists.
"""
import hashlib, json, os, re, secrets, subprocess, sys

here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
M1P = 'supabase/migrations/20261112180000_backlog_4236_cloud_autosave_feature_keys.sql'
M2P = 'supabase/migrations/20261112190000_backlog_4236_cloud_autosave_schema.sql'
RBP = 'supabase/tests/backlog-4236/rollback-4236.sql'
UPGRADE_FROM = 'da5bed2ce'   # the migration as first applied to the test project (earlier signatures)
rd = lambda p: open(os.path.join(root, p)).read()
M1, M2, RB = rd(M1P), rd(M2P), rd(RBP)
M2_OLD = subprocess.check_output(['git', '-C', root, 'show', '%s:%s' % (UPGRADE_FROM, M2P)], text=True)
HL, FX, K6 = (rd('supabase/tests/backlog-4236/lib/' + f) for f in ('helpers.sql', 'fixtures.sql', 'contract-4243.sql'))
TAG = '$swp4243$'
for t in (M1, M2, RB, M2_OLD):
    assert TAG not in t

WRITES = [('set_my_cloud_autosave', 'boolean, integer', 'set'), ('cloud_delete_install', 'uuid', 'delete_install'),
          ('cloud_upsert_deal', 'jsonb', 'deal'), ('cloud_upsert_parties', 'uuid, uuid, jsonb', 'parties'),
          ('cloud_upsert_checklists', 'uuid, uuid, jsonb', 'checklists'), ('cloud_upsert_checklist_items', 'uuid, uuid, jsonb', 'items'),
          ('cloud_upsert_messages', 'uuid, uuid, jsonb', 'messages'), ('cloud_upsert_files', 'uuid, uuid, jsonb', 'files'),
          ('cloud_tombstone', 'uuid, text, uuid[]', 'tombstone'), ('cloud_delete_deal', 'uuid', 'delete_deal'),
          ('cloud_mark_deal_synced', 'uuid, uuid', 'mark_synced'), ('cloud_register_blob', 'text, bigint, text', 'register'),
          ('cloud_confirm_blob', 'uuid', 'confirm')]


def apply(text, old, new, cnt, mode):
    n = text.count(old)
    if n != cnt:
        raise SystemExit('MUTATION NOT APPLIED %s: fragment matched %d times (want %d): %r' % (mode, n, cnt, old[:100]))
    out = text.replace(old, new)
    assert out != text
    print('MUTATION APPLIED %s' % mode)
    for l in old.splitlines():
        if l not in new.splitlines():
            print('  - ' + l.strip()[:150])
    for l in new.splitlines():
        if l not in old.splitlines():
            print('  + ' + l.strip()[:150])
    return out


def unit(text, name):
    """(CREATE ... $f$; plus its REVOKE/GRANT lines, prosrc, regprocedure text) of one function."""
    start = 'CREATE OR REPLACE FUNCTION public.%s(' % name
    assert text.count(start) == 1, name
    i = text.index(start)
    b0 = text.index('AS $f$', i) + len('AS $f$')
    b1 = text.index('$f$;', b0)
    end = b1 + len('$f$;')
    acl = []
    for line in text[end:].lstrip('\n').split('\n'):
        if re.match(r'(REVOKE|GRANT) .* ON FUNCTION public\.%s\(' % re.escape(name), line):
            acl.append(line)
        else:
            break
    sig = re.search(r'ON FUNCTION (public\.%s\([^)]*\))' % re.escape(name), acl[0]).group(1)
    return text[i:end] + '\n' + '\n'.join(acl) + '\n', text[b0:b1], sig


def q(s):
    return TAG + s + TAG


def md5(s):
    return hashlib.md5(s.encode('utf-8')).hexdigest()


def block(key, body):
    """one subtransaction whose body sets v; the subtransaction is undone, then `key` -> v is recorded
    (a plpgsql variable survives the undo; a row written inside it would not)"""
    return ('  v := NULL;\n  BEGIN\n%s\n    RAISE EXCEPTION USING ERRCODE = %s;\n'
            '  EXCEPTION WHEN SQLSTATE %s THEN NULL;\n    WHEN OTHERS THEN EXECUTE %s; v := %s || SQLSTATE || %s || SQLERRM;\n  END;\n'
            '  INSERT INTO pg_temp.p4243_out VALUES (%s, coalesce(v, %s));\n'
            ) % (body, lit('T4243'), lit('T4243'), lit('RESET ROLE'), lit('CRASH '), lit(' '), lit(key), lit('NULL (body set nothing)'))


def lit(s):
    return "'" + s.replace("'", "''") + "'"


def fn_mutant(mode, fn_name, old, new, probe, cnt=1):
    mut = apply(M2, old, new, cnt, mode)
    u, src, sig = unit(mut, fn_name)
    _, src0, _ = unit(M2, fn_name)
    assert src != src0, mode
    body = ('    EXECUTE %s;\n'
            "    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(%s)) IS DISTINCT FROM %s THEN\n"
            "      v := 'NOT APPLIED IN DB';\n    ELSE\n      v := %s;\n    END IF;") % (q(u), lit(sig), lit(md5(src)), probe)
    return block('M_' + mode, body)


def acl_mutant(mode, fn_name, old, new, cnt=1):
    mut = apply(M2, old, new, cnt, mode)
    u, _, sig = unit(mut, fn_name)
    body = ("    t0 := (SELECT coalesce(proacl::text, 'null') FROM pg_proc WHERE oid = to_regprocedure(%s));\n"
            "    EXECUTE %s;\n    EXECUTE %s;\n"
            "    IF (SELECT coalesce(proacl::text, 'null') FROM pg_proc WHERE oid = to_regprocedure(%s)) IS NOT DISTINCT FROM t0 THEN\n"
            "      v := 'NOT APPLIED IN DB (acl unchanged)';\n    ELSE\n      v := pg_temp.k6_catalog();\n    END IF;"
            ) % (lit(sig), q('DROP FUNCTION %s;' % sig), q(u), lit(sig))
    return block('M_' + mode, body)


C02_SOLO = False  # --c02-solo: only the upgrade fixture and its drop mutants
STOP_AFTER_C02 = ''
C02_ONLY = None   # --c02=<tag,...> limits the C0.2 drop mutants to these writes
WRITES_SECTION = '-- ============================================================================ on / off and installs\n'
assert M2.count(WRITES_SECTION) == 1
HEAD = "SET LOCAL pg_stat_statements.track = 'none';\nSET LOCAL lock_timeout = '10s';\n"
BASE = RB + '\n' + M1 + '\n' + M1 + '\n' + M2 + '\n' + M2 + '\n' + HL + '\n' + FX + '\n' + K6 + '\n'
OUT_TABLE = 'CREATE TEMP TABLE p4243_out (k text, v text);\n'
FINAL = ("DO $fin4243$ BEGIN RAISE EXCEPTION 'P4243_SWEEP %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.p4243_out); END $fin4243$;\n")
DECL = "DO $sw4243$\nDECLARE v text; t0 text; base jsonb;\nBEGIN\n"


def sweep_fn():
    b = ['  base := pg_temp.base();\n  INSERT INTO pg_temp.p4243_out VALUES (\'base\', base::text);\n']
    for name, _, tag in WRITES:
        b.append(block('P_K6_' + name, '    v := pg_temp.k6_probe(%s);' % lit(name)))
    b.append(block('P_catalog', '    v := pg_temp.k6_catalog();'))
    for k in ('k1', 'k2', 'k4', 'n1', 'n2', 'w'):
        b.append(block('P_' + k, '    v := pg_temp.%s_probe();' % k))
    # C0.1: drop the check in each function
    for name, _, tag in WRITES:
        key = 'success' if name in ('set_my_cloud_autosave', 'cloud_delete_install') else 'ok'
        line = ("  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('%s', false, 'error', 'wrong_account'); END IF;   /*WHO:%s*/\n" % (key, tag))
        b.append(fn_mutant('K6_no_check_' + tag, name, line, '', 'pg_temp.k6_probe(%s)' % lit(name)))
    # likely wrong builds of the check
    for name, tag, between in [('set_my_cloud_autosave', 'set', "  IF p_enabled IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_input'); END IF;\n"),
                               ('cloud_delete_install', 'delete_install', "  IF p_source_install_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_input'); END IF;\n")]:
        line = ("  IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('success', false, 'error', 'wrong_account'); END IF;   /*WHO:%s*/\n" % tag)
        ins = ('  -- Default settings row (enabled = false), locked FOR UPDATE below; a refused call can leave it in place.\n'
               '  INSERT INTO public.cloud_autosave_settings (user_id) VALUES (v_uid) ON CONFLICT (user_id) DO NOTHING;\n')
        b.append(fn_mutant('K6_check_after_insert_' + tag, name, line + between + ins, between + ins + line, 'pg_temp.k6_probe(%s)' % lit(name)))
    b.append(fn_mutant('K6_not_equal_instead_of_distinct_deal', 'cloud_upsert_deal',
                       "IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:deal*/",
                       "IF p_expected_user_id <> v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:deal*/",
                       'pg_temp.k6_probe(%s)' % lit('cloud_upsert_deal')))
    b.append(fn_mutant('K6_presence_only_parties', 'cloud_upsert_parties',
                       "IF p_expected_user_id IS DISTINCT FROM v_uid THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:parties*/",
                       "IF p_expected_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'wrong_account'); END IF;   /*WHO:parties*/",
                       'pg_temp.k6_probe(%s)' % lit('cloud_upsert_parties')))
    # K1, K2, K4
    b.append(fn_mutant('K1_no_uploaded_term', 'cloud_upsert_files',
                       '         AND b.uploaded_at IS NOT NULL                                                        /*FILE:uploaded*/\n', '', 'pg_temp.k1_probe()'))
    b.append(fn_mutant('K2_no_removed_term', 'cloud_upsert_files',
                       "\n         AND m.removed_at IS NULL;                                                            /*FILE:livemessage*/", ';', 'pg_temp.k2_probe()'))
    b.append(fn_mutant('K4_no_fence', 'cloud_confirm_blob',
                       '    UPDATE public.cloud_blobs SET purge_requested_at = now() WHERE id = b.id;                 /*CONFIRM:fence*/\n', '', 'pg_temp.k4_probe()'))
    # N1 freshness: a transaction-start clock, two clock reads in mark, no greatest()
    N1 = 'pg_temp.n1_probe()'
    b.append(fn_mutant('N1_mark_transaction_start', 'cloud_mark_deal_synced',
                       '  v_at := clock_timestamp();                                                                 /*CLOCK:mark*/',
                       '  v_at := now();                                                                 /*CLOCK:mark*/', N1))
    b.append(fn_mutant('N1_mark_two_clock_reads', 'cloud_mark_deal_synced',
                       'UPDATE public.cloud_deals SET last_full_sync_at = v_at, last_synced_at = v_at WHERE id = v_deal;',
                       'UPDATE public.cloud_deals SET last_full_sync_at = clock_timestamp(), last_synced_at = clock_timestamp() WHERE id = v_deal;', N1))
    b.append(fn_mutant('N1_deal_transaction_start', 'cloud_upsert_deal',
                       '    v_now := clock_timestamp();                                                              /*CLOCK:deal*/',
                       '    v_now := now();                                                              /*CLOCK:deal*/', N1))
    CHILD = 'greatest(last_synced_at, clock_timestamp()) WHERE id = v_deal;   /*CLOCK:%s*/'
    for fn_name, tag in [('cloud_upsert_parties', 'parties'), ('cloud_upsert_checklists', 'checklists'), ('cloud_upsert_checklist_items', 'items')]:
        b.append(fn_mutant('N1_%s_transaction_start' % tag, fn_name, CHILD % tag, 'now() WHERE id = v_deal;   /*CLOCK:%s*/' % tag, N1))
    b.append(fn_mutant('N1_messages_transaction_start', 'cloud_upsert_messages',
                       'greatest(last_synced_at, clock_timestamp()) WHERE id = v_deal;   /*MSG:touch*/', 'now() WHERE id = v_deal;   /*MSG:touch*/', N1))
    b.append(fn_mutant('N1_files_transaction_start', 'cloud_upsert_files',
                       'greatest(last_synced_at, clock_timestamp()) WHERE id = v_deal;   /*CLOCK:files*/', 'now() WHERE id = v_deal;   /*CLOCK:files*/', N1))
    b.append(fn_mutant('N1_tombstone_transaction_start', 'cloud_tombstone',
                       '  v_now := clock_timestamp();                                                                /*CLOCK:tombstone*/',
                       '  v_now := now();                                                                /*CLOCK:tombstone*/', N1))
    b.append(fn_mutant('N1_parties_no_greatest', 'cloud_upsert_parties', CHILD % 'parties', 'clock_timestamp() WHERE id = v_deal;   /*CLOCK:parties*/', N1))
    # N2: an uploaded blob is confirmed again without a storage read
    b.append(fn_mutant('N2_no_early_return', 'cloud_confirm_blob',
                       "  IF b.uploaded_at IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'state', 'uploaded'); END IF;   /*CONFIRM:already*/\n",
                       '', 'pg_temp.n2_probe()'))
    # details_withheld (BACKLOG-4243 PR-0b)
    W = 'pg_temp.w_probe()'
    b.append(fn_mutant('W_name_not_nulled', 'cloud_upsert_parties',
                       "display_name = CASE WHEN v_withheld THEN NULL ELSE r ->> 'display_name' END,", "display_name = r ->> 'display_name',", W))
    b.append(fn_mutant('W_company_not_nulled', 'cloud_upsert_parties',
                       "company = CASE WHEN v_withheld THEN NULL ELSE r ->> 'company' END,", "company = r ->> 'company',", W))
    b.append(fn_mutant('W_emails_not_nulled', 'cloud_upsert_parties',
                       "emails = CASE WHEN v_withheld THEN NULL WHEN jsonb_typeof", "emails = CASE WHEN jsonb_typeof", W))
    b.append(fn_mutant('W_phones_not_nulled', 'cloud_upsert_parties',
                       "phones = CASE WHEN v_withheld THEN NULL WHEN jsonb_typeof", "phones = CASE WHEN jsonb_typeof", W))
    b.append(fn_mutant('W_nulling_unconditional', 'cloud_upsert_parties', "CASE WHEN v_withheld THEN NULL", "CASE WHEN true THEN NULL", W, cnt=4))
    b.append(fn_mutant('W_nulling_new_rows_only', 'cloud_upsert_parties', "CASE WHEN v_withheld THEN NULL", "CASE WHEN v_withheld AND cur.version = 0 THEN NULL", W, cnt=4))
    b.append(fn_mutant('W_keyed_on_contact_source', 'cloud_upsert_parties',
                       "v_withheld := coalesce((r ->> 'details_withheld')::boolean, false);",
                       "v_withheld := (r ->> 'contact_source') IS NOT DISTINCT FROM 'google_contacts';", W))
    b.append(fn_mutant('W_absent_means_true', 'cloud_upsert_parties',
                       "v_withheld := coalesce((r ->> 'details_withheld')::boolean, false);", "v_withheld := coalesce((r ->> 'details_withheld')::boolean, true);", W))
    b.append(fn_mutant('W_flag_not_validated', 'cloud_upsert_parties',
                       "ARRAY['is_primary', 'contact_deleted', 'details_withheld']", "ARRAY['is_primary', 'contact_deleted']", W))
    b.append(fn_mutant('W_flag_not_stored', 'cloud_upsert_parties', "        details_withheld = v_withheld,\n", "", W))
    b.append(fn_mutant('W_equal_hash_flip_not_applied', 'cloud_upsert_parties',
                       "    IF v_status = 'unchanged' AND v_withheld AND NOT cur.details_withheld THEN v_status := 'applied'; END IF;   /*PTY:flip*/\n", '', W))
    # C0.3 grants
    b.append(acl_mutant('G_no_revoke_deal', 'cloud_upsert_deal',
                        'REVOKE ALL ON FUNCTION public.cloud_upsert_deal(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;\n', ''))
    b.append(acl_mutant('G_grant_anon_tombstone', 'cloud_tombstone',
                        'GRANT EXECUTE ON FUNCTION public.cloud_tombstone(uuid, uuid, text, uuid[]) TO authenticated;',
                        'GRANT EXECUTE ON FUNCTION public.cloud_tombstone(uuid, uuid, text, uuid[]) TO authenticated, anon;'))
    b.append(acl_mutant('G_revoke_keeps_service_role_register', 'cloud_register_blob',
                        'REVOKE ALL ON FUNCTION public.cloud_register_blob(uuid, text, bigint, text) FROM PUBLIC, anon, authenticated, service_role;',
                        'REVOKE ALL ON FUNCTION public.cloud_register_blob(uuid, text, bigint, text) FROM PUBLIC, anon, authenticated;'))
    b.append(acl_mutant('G_revoke_keeps_public_confirm', 'cloud_confirm_blob',
                        'REVOKE ALL ON FUNCTION public.cloud_confirm_blob(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;',
                        'REVOKE ALL ON FUNCTION public.cloud_confirm_blob(uuid, uuid) FROM anon, authenticated, service_role;'))
    return HEAD + BASE + OUT_TABLE + DECL + ''.join(b) + 'END\n$sw4243$;\n' + FINAL


RB_CLEAN = ("CREATE FUNCTION pg_temp.rb_clean() RETURNS text LANGUAGE sql AS $h$\n"
            "  SELECT pg_temp.pass(n = 0, 'functions_left=' || n || ' ' || coalesce(l, '')) FROM (\n"
            "    SELECT count(*) AS n, string_agg(p.oid::regprocedure::text, ',') AS l FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace\n"
            "       AND (p.proname ~ '^_?cloud_' OR p.proname IN ('assign_member_addon', 'get_my_cloud_autosave_state', 'set_my_cloud_autosave'))) x\n$h$;\n")
FP = ("CREATE FUNCTION pg_temp.cat_fp() RETURNS text LANGUAGE sql AS $h$\n"
      "  SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) FROM (\n"
      "    SELECT p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, '') AS x FROM pg_proc p\n"
      "     WHERE p.pronamespace = 'public'::regnamespace AND (p.proname ~ '^_?cloud_' OR p.proname IN ('assign_member_addon', 'get_my_cloud_autosave_state', 'set_my_cloud_autosave'))\n"
      "    UNION ALL SELECT c.relname || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity FROM pg_class c\n"
      "     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND (c.relname LIKE 'cloud\\_%' OR c.relname = 'member_addons')\n"
      "    UNION ALL SELECT 'pol:' || schemaname || '.' || tablename || ':' || policyname FROM pg_policies\n"
      "     WHERE policyname LIKE 'Cloud deal files:%' OR (schemaname = 'public' AND (tablename LIKE 'cloud\\_%' OR tablename = 'member_addons'))) y\n$h$;\n")
OLD_CAT = ("CREATE FUNCTION pg_temp.old_catalog() RETURNS text LANGUAGE plpgsql AS $h$\n"
           "DECLARE s text; acc text := '';\nBEGIN\n"
           "  FOREACH s IN ARRAY ARRAY[%s] LOOP\n"
           "    IF to_regprocedure(s) IS NULL THEN acc := acc || ' missing:' || s; CONTINUE; END IF;\n"
           "    IF has_function_privilege('public', s, 'EXECUTE') OR has_function_privilege('anon', s, 'EXECUTE')\n"
           "       OR has_function_privilege('service_role', s, 'EXECUTE') OR NOT has_function_privilege('authenticated', s, 'EXECUTE') THEN acc := acc || ' acl:' || s; END IF;\n"
           "  END LOOP;\n"
           "  FOREACH s IN ARRAY ARRAY[%s] LOOP\n"
           "    IF to_regprocedure(s) IS NOT NULL THEN acc := acc || ' new_present:' || s; END IF;\n"
           "  END LOOP;\n  RETURN pg_temp.pass(acc = '', acc);\nEND $h$;\n") % (
    ', '.join(lit('public.%s(%s)' % (n, o.replace(' ', ''))) for n, o, _ in WRITES),
    ', '.join(lit('public.%s(uuid,%s)' % (n, o.replace(' ', ''))) for n, o, _ in WRITES))
MCP_PROBE = ("CREATE FUNCTION pg_temp.mcp_status_probe() RETURNS text LANGUAGE plpgsql AS $h$\n"
             "DECLARE j jsonb; u uuid := gen_random_uuid();\nBEGIN\n"
             "  IF to_regprocedure('public._mcp_r_entitlement()') IS NULL THEN RETURN 'FAIL: _mcp_r_entitlement absent'; END IF;\n"
             "  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);\n"
             "  PERFORM set_config('request.jwt.claim.sub', u::text, true);\n"
             "  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);\n"
             "  j := public._mcp_r_entitlement();\n  PERFORM pg_temp.clear_claims();\n"
             "  RETURN pg_temp.pass(j ->> 'entitled' = 'false' AND j ->> 'reason' = 'no_license', coalesce(j::text, 'null'));\nEND $h$;\n")


def sweep_ddl():
    pre = HEAD + HL + '\n' + K6 + '\n' + RB_CLEAN + FP + OLD_CAT + MCP_PROBE + OUT_TABLE
    # 1. rehearsal on the committed state: the edited migration re-run, then the rollback, in this one transaction
    r = [DECL]
    r.append("  INSERT INTO pg_temp.p4243_out VALUES ('R0_live_before_old_catalog', pg_temp.old_catalog());\n")
    r.append("  INSERT INTO pg_temp.p4243_out VALUES ('R0_live_ledger_rows', (SELECT count(*)::text FROM supabase_migrations.schema_migrations WHERE version = '20261112190000'));\n")
    r.append("  INSERT INTO pg_temp.p4243_out VALUES ('R0_live_mcp_status', pg_temp.mcp_status_probe());\n")
    r.append('  EXECUTE %s;\n' % q(M2))
    r.append("  INSERT INTO pg_temp.p4243_out VALUES ('R1_rerun_catalog', pg_temp.k6_catalog());\n")
    r.append("  INSERT INTO pg_temp.p4243_out VALUES ('R1_rerun_mcp_status', pg_temp.mcp_status_probe());\n")
    r.append("  INSERT INTO pg_temp.p4243_out VALUES ('R1_rerun_ledger_rows', (SELECT count(*)::text FROM supabase_migrations.schema_migrations WHERE version = '20261112190000'));\n")
    r.append(block('M_C09_state_function_renamed',
                   "    EXECUTE 'ALTER FUNCTION public.get_my_cloud_autosave_state() RENAME TO get_my_cloud_autosave_state_x4243';\n    v := pg_temp.mcp_status_probe();"))
    r.append('  EXECUTE %s;\n' % q(RB))
    r.append("  INSERT INTO pg_temp.p4243_out VALUES ('R2_rollback_clean', pg_temp.rb_clean());\n")
    r.append("  INSERT INTO pg_temp.p4243_out VALUES ('R2_rollback_ledger_rows', (SELECT count(*)::text FROM supabase_migrations.schema_migrations WHERE version IN ('20261112180000', '20261112190000')));\n")
    r.append('END\n$sw4243$;\n')
    # 2. upgrade fixture and rollback, from a clean base
    b = [DECL]
    b.append('  EXECUTE %s;\n  EXECUTE %s;\n  EXECUTE %s;\n' % (q(RB), q(M1), q(M2_OLD)))
    b.append("  INSERT INTO pg_temp.p4243_out VALUES ('U0_old_catalog', pg_temp.old_catalog());\n")
    b.append(block('P_C02_upgrade', '    EXECUTE %s;\n    v := pg_temp.k6_catalog();' % q(M2)))
    for name, old, tag in [w for w in WRITES if C02_ONLY is None or w[2] in C02_ONLY]:
        mut = apply(M2, 'DROP FUNCTION IF EXISTS public.%s(%s);\n' % (name, old), '', 1, 'C02_no_drop_' + tag)
        # the mutant re-runs the file from the write functions on (tables, helpers and reads are unchanged
        # by the edit and already present from the earlier file); the pristine block above runs it whole
        sect = mut[mut.index(WRITES_SECTION):]
        assert 'CREATE OR REPLACE FUNCTION public.%s(p_expected_user_id uuid, ' % name in sect
        b.append(block('M_C02_no_drop_' + tag, '    EXECUTE %s;\n    v := pg_temp.k6_catalog();' % q(sect)))
    b.append(STOP_AFTER_C02)
    # rollback over the old state (an install that never got the edited migration)
    b.append(block('P_C04_rollback_on_old_state', '    EXECUTE %s;\n    v := pg_temp.rb_clean();' % q(RB)))
    rb_mut = apply(RB, 'DROP FUNCTION IF EXISTS public.cloud_upsert_deal(jsonb);\n', '', 1, 'C04_rollback_keeps_old_deal')
    b.append(block('M_C04_rollback_keeps_old_deal_on_old_state', '    EXECUTE %s;\n    v := pg_temp.rb_clean();' % q(rb_mut)))
    # new state: rollback -> apply -> apply leaves the same catalog; rollback leaves nothing
    b.append('  EXECUTE %s;\n' % q(M2))
    b.append("  t0 := pg_temp.cat_fp();\n")
    b.append(block('P_C04_rollback_apply_apply', ('    EXECUTE %s;\n    v := pg_temp.rb_clean();\n    EXECUTE %s;\n    EXECUTE %s;\n    EXECUTE %s;\n'
                                                   "    v := v || CASE WHEN pg_temp.cat_fp() = t0 THEN '' ELSE ' catalog_differs' END;\n"
                                                   "    IF v <> 'PASS' THEN v := 'FAIL: ' || v; END IF;") % (q(RB), q(M1), q(M2), q(M2))))
    rb_mut2 = apply(RB, 'DROP FUNCTION IF EXISTS public.cloud_upsert_deal(uuid, jsonb);\n', '', 1, 'C04_rollback_keeps_new_deal')
    b.append(block('M_C04_rollback_keeps_new_deal', '    EXECUTE %s;\n    v := pg_temp.rb_clean();' % q(rb_mut2)))
    # the earlier signatures and grants come back with the rollback and the earlier file
    b.append(block('P_C04_rollback_then_old_file', '    EXECUTE %s;\n    EXECUTE %s;\n    EXECUTE %s;\n    v := pg_temp.old_catalog();' % (q(RB), q(M1), q(M2_OLD))))
    b.append('END\n$sw4243$;\n')
    if C02_SOLO:
        return pre + ''.join(b[:b.index(STOP_AFTER_C02)]) + 'END\n$sw4243$;\n' + FINAL
    return pre + ''.join(r) + ''.join(b) + FINAL


WITHHELD_FROM = 'd170183aa'   # the migration as applied before details_withheld existed


def sweep_withheld():
    prev = subprocess.check_output(['git', '-C', root, 'show', '%s:%s' % (WITHHELD_FROM, M2P)], text=True)
    assert TAG not in prev
    col = "(SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cloud_deal_parties' AND column_name = 'details_withheld')"
    # the probe library names the new column; on the committed state it does not exist until the re-run below
    pre = HEAD + "SET LOCAL check_function_bodies = off;\n" + HL + '\n' + FX + '\n' + K6 + '\n' + RB_CLEAN + MCP_PROBE + OUT_TABLE
    b = [None]
    # rehearsal over the committed state of the test project (the migration as at WITHHELD_FROM)
    b.append("  INSERT INTO pg_temp.p4243_out VALUES ('R0_live_column', %s::text);\n" % col)
    b.append('  EXECUTE %s;\n' % 'm2')
    b.append("  INSERT INTO pg_temp.p4243_out VALUES ('R1_rerun_column', %s::text);\n" % col)
    b.append("  INSERT INTO pg_temp.p4243_out VALUES ('R1_rerun_catalog', pg_temp.k6_catalog());\n")
    b.append("  INSERT INTO pg_temp.p4243_out VALUES ('R1_rerun_mcp_status', pg_temp.mcp_status_probe());\n")
    b.append("  INSERT INTO pg_temp.p4243_out VALUES ('R1_rerun_ledger_rows', (SELECT count(*)::text FROM supabase_migrations.schema_migrations WHERE version = '20261112190000'));\n")
    # (f) in-place re-run over the earlier file with a party row stored under the old shape
    fbody = ('    EXECUTE %s;\n    EXECUTE %s;\n    EXECUTE %s;\n    base := pg_temp.base();\n'
             "    t0 := %s::text || '/' || (SELECT count(*) FROM public.cloud_deal_parties)::text;\n"
             '    EXECUTE %s;\n    EXECUTE %s;\n'
             "    IF t0 <> '0/1' OR %s <> 1\n"
             "       OR (SELECT count(*) FROM pg_constraint WHERE conname = 'cloud_deal_parties_withheld_ck') <> 1 THEN\n"
             "      v := 'FAIL: before=' || t0 || ' after_column=' || %s;\n"
             "    ELSIF (SELECT count(*) FROM public.cloud_deal_parties WHERE details_withheld OR display_name IS NULL) <> 0 THEN\n"
             "      v := 'FAIL: an existing party row did not default to false with its details';\n"
             "    ELSE\n      v := pg_temp.w_probe();\n    END IF;")
    b.append(block('P_F_rerun_over_earlier_file', fbody % ('rb', 'm1', 'prev', col, 'm2', 'm2', col, col)))
    no_alter = apply(M2, 'ALTER TABLE public.cloud_deal_parties ADD COLUMN IF NOT EXISTS details_withheld boolean NOT NULL DEFAULT false;\n', '', 1, 'F_no_add_column')
    b.append(block('M_F_no_add_column', fbody % ('rb', 'm1', 'prev', col, 'no_alter', q('SELECT 1'), col, col)))
    # mutant: the CHECK removed -> a direct UPDATE planting a name on a flagged row is accepted
    CK = ('ALTER TABLE public.cloud_deal_parties DROP CONSTRAINT IF EXISTS cloud_deal_parties_withheld_ck;\n'
          'ALTER TABLE public.cloud_deal_parties ADD CONSTRAINT cloud_deal_parties_withheld_ck\n'
          '  CHECK (NOT details_withheld OR (display_name IS NULL AND company IS NULL AND emails IS NULL AND phones IS NULL));\n')
    no_ck = apply(M2, CK, '', 1, 'F_no_withheld_check')
    b.append(block('M_F_no_withheld_check', '    EXECUTE ' + 'rb' + ';\n    EXECUTE ' + 'm1' + ';\n    EXECUTE ' + 'no_ck'
                   + ';\n    base := pg_temp.base();\n    v := pg_temp.w_probe();'))
    # (g) rollback then the earlier file: the column is gone and the earlier parties body is back
    _, prev_src, _ = unit(prev, 'cloud_upsert_parties')
    gbody = ('    EXECUTE %s;\n    EXECUTE %s;\n    EXECUTE %s;\n    EXECUTE %s;\n'
             "    IF %s <> 0 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.cloud_upsert_parties(uuid,uuid,uuid,jsonb)')) IS DISTINCT FROM %s THEN\n"
             "      v := 'FAIL: column=' || %s;\n    ELSE\n      v := 'PASS';\n    END IF;")
    b.append(block('P_G_rollback_then_earlier_file', gbody % ('rb', 'm1', 'm2', 'rb' + ';\n    EXECUTE ' + 'm1' + ';\n    EXECUTE ' + 'prev', col, lit(md5(prev_src)), col)))
    # mutant: the earlier file re-run without the rollback first (the column stays)
    print('MUTATION APPLIED G_earlier_file_without_rollback (sequence: the rollback step before the earlier file removed)')
    b.append(block('M_G_earlier_file_without_rollback', gbody % ('rb', 'm1', 'm2', 'm1' + ';\n    EXECUTE ' + 'prev', col, lit(md5(prev_src)), col)))
    b[0] = ('DO $sw4243$\nDECLARE v text; t0 text; base jsonb;\n  m2 text := %s;\n  prev text := %s;\n  rb text := %s;\n  m1 text := %s;\n'
            '  no_alter text := %s;\n  no_ck text := %s;\nBEGIN\n') % (q(M2), q(prev), q(RB), q(M1), q(no_alter), q(no_ck))
    b.append('END\n$sw4243$;\n')
    return pre + ''.join(b) + FINAL


def main():
    global C02_ONLY, C02_SOLO
    mode = sys.argv[1]
    for a in sys.argv[2:]:
        if a == '--c02-solo':
            C02_SOLO = True
        if a.startswith('--c02='):
            C02_ONLY = a.split('=', 1)[1].split(',')
    sql = {'fn': sweep_fn, 'ddl': sweep_ddl, 'withheld': sweep_withheld}[mode]().replace('__RUN__', secrets.token_hex(12))
    assert '__RUN__' not in sql
    print('composed %s: %d bytes' % (mode, len(sql)))
    if '--print' in sys.argv:
        return
    import tempfile, time
    d = tempfile.mkdtemp()
    p = os.path.join(d, 'sweep.sql')
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
    m = re.search(r'P4243_SWEEP (\{.*\})', msg, re.S)
    print('wall_s=%d' % (time.time() - t0))
    if not m:
        print('NO RESULT: ' + msg[:3000]); sys.exit(1)
    res, _ = json.JSONDecoder().raw_decode(m.group(1))
    caught = missed = 0
    for k in sorted(res):
        v = res[k]
        if k.startswith('M_'):
            ok = v.startswith('FAIL')
            caught += ok; missed += (not ok)
            print('%-58s %s  %s' % (k, 'RED (caught)' if ok else 'STAYED GREEN / NOT APPLIED', v[:220]))
        else:
            print('%-58s %s' % (k, v[:300]))
    print('MUTANTS caught=%d missed=%d total=%d' % (caught, missed, caught + missed))
    sys.exit(1 if missed or caught + missed == 0 else 0)


main()
