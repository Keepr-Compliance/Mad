#!/usr/bin/env python3
"""BACKLOG-4263 PR-2: controls and mutants for the todo server core in ONE kt-sql call each (one transaction
ending in RAISE, so nothing persists).

Usage: harness.py run [--print] [--controls | --mutants=<a-b> | --only=<mode,...>] | harness.py check | harness.py list

Order in a call: a record of the anon-callable functions, the rollback (objects created fresh), the migration,
lib/helpers.sql, lib/fixtures.sql, lib/probes.sql, the fixtures (written through the earlier one-way functions),
the migration again (proves the re-run and backfills the fixture rows), then each control (C_*) and/or mutant
(M_*) in its own subtransaction, undone at its end. A mutant is an exact-string replace on one unit of the
migration read from the working tree: a fragment that does not match its stated count stops the script before
anything is sent. In the database each mutant is checked by md5(prosrc), ACL or catalogue presence before its
probe runs. A mutant is caught when its probe returns FAIL; want=green marks a mutant measured equivalent.
The call ends with a RAISE carrying the results, then harness.py resets pg_stat_statements.
"""
import hashlib, json, os, re, secrets, subprocess, sys

here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
rd = lambda p: open(os.path.join(root, p)).read()
MIGP = 'supabase/migrations/20261118110000_backlog_4263_todo_server_core.sql'
MIG = rd(MIGP)
RB = rd('supabase/tests/backlog-4263/rollback-4263.sql')
HL, FX, PR = (rd('supabase/tests/backlog-4263/lib/' + f) for f in ('helpers.sql', 'fixtures.sql', 'probes.sql'))
TAG, TAG2 = '$sw4263$', '$ud4263$'
for t in (MIG, RB, HL, FX, PR):
    assert TAG not in t and TAG2 not in t
READERS = ['_mcp_r_list_deals', '_mcp_r_get_deal', '_mcp_r_deal_checklists']


def lit(s):
    return "'" + s.replace("'", "''") + "'"


def q(s):
    return TAG + s + TAG


def md5(s):
    return hashlib.md5(s.encode('utf-8')).hexdigest()


def unit(text, name):
    start = 'CREATE OR REPLACE FUNCTION public.%s(' % name
    assert text.count(start) == 1, name
    i = text.index(start)
    tag = '$fn$' if name in READERS else '$f$'
    b0 = text.index('AS ' + tag, i) + len('AS ' + tag)
    b1 = text.index(tag + ';', b0)
    end = b1 + len(tag) + 1
    acl = []
    for line in text[end:].lstrip('\n').split('\n'):
        if re.match(r'(REVOKE|GRANT) .* ON FUNCTION public\.%s\(' % re.escape(name), line):
            acl.append(line)
        else:
            break
    sig = re.search(r'ON FUNCTION (public\.%s\([^)]*\))' % re.escape(name), acl[0]).group(1)
    return text[i:end] + '\n' + '\n'.join(acl) + '\n', text[b0:b1], sig


UNITS, WANT, OUT = {}, {}, []


def lp(s):
    """a literal that holds any text"""
    return q(s)


def block(key, body):
    return ('  v := NULL;\n  BEGIN\n%s\n    RAISE EXCEPTION USING ERRCODE = %s;\n'
            '  EXCEPTION WHEN SQLSTATE %s THEN NULL;\n    WHEN OTHERS THEN EXECUTE %s; v := %s || SQLSTATE || %s || SQLERRM;\n  END;\n'
            '  INSERT INTO pg_temp.p4263_out VALUES (%s, coalesce(v, %s));\n'
            ) % (body, lit('T4263'), lit('T4263'), lit('RESET ROLE'), lit('CRASH '), lit(' '), lit(key), lit('NULL (body set nothing)'))


def create_expr(name, expr):
    if name in READERS:
        return ("    EXECUTE 'GRANT CREATE ON SCHEMA public TO mcp_reader';\n    EXECUTE 'SET ROLE mcp_reader';\n"
                "    EXECUTE %s;\n    EXECUTE 'RESET ROLE';\n    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM mcp_reader';\n") % expr
    return '    EXECUTE %s;\n' % expr


def fn_mutant(mode, name, reps, probe, want='red'):
    """reps: [(old, new, count)]"""
    u, src, sig = unit(MIG, name)
    UNITS[name] = u
    mu = u
    expr = 'pg_temp.u_%s()' % name.lstrip('_')
    for old, new, cnt in reps:
        n = mu.count(old)
        if n != cnt:
            raise SystemExit('MUTATION NOT APPLIED %s: fragment matched %d times in %s (want %d): %r' % (mode, n, name, cnt, old[:120]))
        mu = mu.replace(old, new)
        expr = 'replace(%s, %s, %s)' % (expr, q(old), q(new))
    assert mu != u
    msrc = unit(mu, name)[1]
    print('MUTATION APPLIED %s (%s, mutated body md5 %s)' % (mode, name, md5(msrc)))
    for old, new, _ in reps:
        for l in old.splitlines():
            print('  - ' + l.strip()[:150])
        for l in new.splitlines():
            print('  + ' + l.strip()[:150])
    WANT['M_' + mode] = want
    body = create_expr(name, expr) + (
        "    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(%s)) IS DISTINCT FROM %s THEN\n"
        "      v := 'NOT APPLIED IN DB';\n    ELSE\n      v := %s;\n    END IF;") % (lit(sig), lit(md5(msrc)), probe)
    return block('M_' + mode, body)


def ddl_mutant(mode, sql, verify, probe, want='red'):
    WANT['M_' + mode] = want
    print('MUTATION APPLIED %s (ddl)\n  + %s' % (mode, sql.strip()[:200]))
    body = ("    EXECUTE %s;\n    IF (%s) IS NOT TRUE THEN\n      v := 'NOT APPLIED IN DB';\n    ELSE\n      v := %s;\n    END IF;"
            % (q(sql), verify, probe))
    return block('M_' + mode, body)


def unit_decls():
    return ''.join("CREATE FUNCTION pg_temp.u_%s() RETURNS text LANGUAGE sql IMMUTABLE AS %s SELECT %s::text %s;\n"
                   % (n.lstrip('_'), TAG2, q(u), TAG2) for n, u in sorted(UNITS.items()))


CONTROLS = ['p_parts', 'p_later_wins', 'p_equal', 'p_replay', 'p_edit_seq', 'p_parents', 'p_removal_wins', 'p_ai_rules', 'p_strip',
            "p_lock('reason')", "p_lock('sub')", 'p_cross_owner', 'p_e2', 'p_a1', 'p_f4', 'p_feed', 'p_install', 'p_install_restore',
            'p_soft_delete', 'p_reader_counts', 'p_purge', 'p_purge_now', 'p_claims', 'p_turnoff', 'p_idem', 'p_create',
            'p_my_items_unique', 'p_pull', 'p_grants', 'p_seq_catalog', 'p_lock_order', 'p_old_path']

AO = '_cloud_todo_apply_op'


def mutants():
    P = lambda p: 'pg_temp.%s()' % p if '(' not in p else 'pg_temp.%s' % p
    m = []
    m.append(fn_mutant('C1_stale_base_applies', AO, [("IF v_base IS NOT DISTINCT FROM (cur ->> 'rev')::bigint                                     /*MERGE:causal*/",
                                                       "IF true /*MERGE:causal*/", 1)], P('p_parts')))
    m.append(fn_mutant('C1_retried_create_overwrites', AO, [("'edit_seq', op -> 'edit_seq'), p_recv);",
                                                             "'edit_seq', op -> 'edit_seq', 'base_rev', (public._cloud_todo_item_json(t) -> 'parts' -> pt ->> 'rev')::bigint), p_recv);", 1)], P('p_create')))
    m.append(fn_mutant('C7_loser_not_in_history', AO, [("PERFORM public._cloud_todo_hist(p_owner, d.id, ent, v_id, 'change', v_part, cur -> 'value', nv, 'lost',     /*MERGE:lost_history*/\n                    p_actor, cur ->> 'by', v_eff, p_recv, v_opid);",
                                                        "NULL; /*MERGE:lost_history*/", 1)], P('p_parts')))
    m.append(fn_mutant('C28_equal_is_conflict', AO, [("ELSIF public._cloud_todo_same(v_part, cur -> 'value', nv) THEN", "ELSIF false THEN", 1)], P('p_equal')))
    m.append(fn_mutant('C22_edit_seq_dropped', AO, [("AND v_es > coalesce((cur ->> 'edit_seq')::bigint, -1)) THEN", ") THEN", 1)], P('p_edit_seq')))
    m.append(fn_mutant('C29_parents_ignored', AO, [("v_rem_parent := d.removed_at IS NOT NULL OR (ent = 'item' AND c.removed_at IS NOT NULL);", "v_rem_parent := false;", 1)], P('p_parents')))
    m.append(fn_mutant('W_ai_edits_removed', AO, [("      IF NOT v_desk THEN\n        RETURN jsonb_build_object('op_id', v_opid, 'status', 'refused_removed', 'entity', ent, 'cloud_id', v_id);\n      END IF;\n      PERFORM public._cloud_todo_write_part(p_owner, ent, v_id, v_part, nv",
                                                   "      IF false THEN\n        RETURN NULL;\n      END IF;\n      PERFORM public._cloud_todo_write_part(p_owner, ent, v_id, v_part, nv", 1)], P('p_removal_wins')))
    m.append(fn_mutant('W_edit_resurrects', '_cloud_todo_write_part', [("SET note = p_value #>> '{}' WHERE", "SET note = p_value #>> '{}', removed_at = NULL WHERE", 1)], P('p_removal_wins')))
    m.append(fn_mutant('W_concurrent_always_wins', AO, [("v_wins := (v_eff, v_kind) > (v_cur_eff, split_part(coalesce(cur ->> 'by', ''), ':', 1));", "v_wins := true;", 1)], P('p_a1')))
    m.append(fn_mutant('F4_children_not_renumbered', '_cloud_todo_unremove_deal', [("UPDATE public.cloud_deal_checklist_items SET change_seq = (public._cloud_todo_take_seq(p_owner, 1))[1] WHERE id = v_id;   /*F4:items*/", "NULL; /*F4:items*/", 1)], P('p_f4')))
    m.append(fn_mutant('F4_unremove_only_on_new_hash', 'cloud_upsert_deal', [("IF d.removed_at IS NOT NULL THEN", "IF d.removed_at IS NOT NULL AND d.content_hash IS DISTINCT FROM v_hash THEN", 1)], P('p_f4')))
    m.append(fn_mutant('D8_history_shares_row_number', '_cloud_todo_hist', [("v_seq := (public._cloud_todo_take_seq(p_owner, 1))[1];",
                                                                            "v_seq := coalesce((SELECT max(x.change_seq) FROM public.cloud_deal_checklist_items x WHERE x.id = p_entity_id), (public._cloud_todo_take_seq(p_owner, 1))[1]);", 1)], P('p_feed')))
    m.append(fn_mutant('C38_age_from_receive_time', 'cloud_todo_push', [("v_age := v_sent - v_ed;", "v_age := v_recv - v_ed;", 1)], P('p_e2')))
    m.append(fn_mutant('C31_negative_age_valid', 'cloud_todo_push', [("OR v_age < interval '0' OR", "OR", 1)], P('p_e2')))
    m.append(fn_mutant('C31_wider_upper_bound', 'cloud_todo_push', [("v_age > interval '365 days'", "v_age > interval '366 days'", 1)], P('p_e2')))
    m.append(fn_mutant('C37_stepped_ignored', 'cloud_todo_push', [("OR (op ->> 'clock_stepped') = 'true'", "", 1)], P('p_e2')))
    m.append(fn_mutant('X_owner_filters_dropped', AO, [("WHERE x.owner_user_id = p_owner                                                          /*OWNER:item*/", "WHERE true /*OWNER:item*/", 1),
                                                        ("SELECT * INTO d FROM public.cloud_deals x WHERE x.id = c.cloud_deal_id AND x.owner_user_id = p_owner;", "SELECT * INTO d FROM public.cloud_deals x WHERE x.id = c.cloud_deal_id;", 1)], P('p_cross_owner')))
    m.append(fn_mutant('X_item_owner_only', AO, [("WHERE x.owner_user_id = p_owner                                                          /*OWNER:item*/", "WHERE true /*OWNER:item*/", 1)], P('p_cross_owner'), want='green'))
    m.append(fn_mutant('X_other_install', AO, [("IF d.id IS NULL OR (v_desk AND d.source_install_id IS DISTINCT FROM p_inst) THEN", "IF d.id IS NULL THEN", 1)], P('p_cross_owner')))
    m.append(fn_mutant('C8a_lock_reason_dropped', '_cloud_todo_deal_locked', [("SELECT d.lock_reason IS NOT NULL", "SELECT false", 1)], P("p_lock('reason')")))
    m.append(fn_mutant('C8b_submission_dropped', '_cloud_todo_deal_locked', [("s.status IN ('submitted', 'under_review', 'resubmitted', 'approved')", "false", 1)], P("p_lock('sub')")))
    m.append(fn_mutant('C8b_oldest_submission', '_cloud_todo_deal_locked', [("ORDER BY s.version DESC, s.id DESC LIMIT 1", "ORDER BY s.version ASC, s.id ASC LIMIT 1", 1)], P("p_lock('sub')")))
    m.append(fn_mutant('C8c_uploading_locked', '_cloud_todo_deal_locked', [("('submitted', 'under_review', 'resubmitted', 'approved')", "('uploading', 'submitted', 'under_review', 'resubmitted', 'approved')", 1)], P("p_lock('sub')")))
    m.append(fn_mutant('Q1_ai_renames_template', AO, [("IF NOT v_desk AND (v_part = 'order' OR (v_part = 'title' AND NOT v_my)) THEN", "IF NOT v_desk AND v_part = 'order' THEN", 1)], P('p_ai_rules')))
    m.append(fn_mutant('Q1_ai_removes_template', AO, [("IF NOT v_desk AND (ent = 'checklist' OR NOT v_my) THEN", "IF NOT v_desk AND ent = 'checklist' THEN", 1)], P('p_ai_rules')))
    m.append(fn_mutant('R10_6_strip_dropped', '_cloud_todo_norm', [("IF p_ai THEN v := btrim(public._mcp_strip(v)); END IF;", "IF p_ai THEN v := btrim(v); END IF;", 1)], P('p_strip')))
    m.append(fn_mutant('C19_window_dropped', AO, [("AND x.created_at > now() - interval '10 minutes'", "AND false", 1)], P('p_ai_rules')))
    m.append(fn_mutant('P_purge_before_30_days', '_cloud_todo_purge', [("v_cut timestamptz := now() - interval '30 days';", "v_cut timestamptz := now() - interval '1 day';", 1)], P('p_purge')))
    m.append(fn_mutant('P_purge_leaves_blobs', '_cloud_todo_purge_deal', [("PERFORM public._cloud_fence_unreferenced(p_owner, v_blobs);", "NULL;", 1)], P('p_purge')))
    m.append(fn_mutant('C36_purge_without_claim', '_cloud_todo_purge', [("PERFORM set_config('request.jwt.claim.role', 'service_role', true);", "NULL;", 1)], P('p_purge')))
    m.append(fn_mutant('C36_claim_not_restored', '_cloud_todo_purge', [("PERFORM set_config('request.jwt.claim.role', coalesce(v_role, ''), true);", "NULL;", 1)], P('p_purge')))
    m.append(fn_mutant('P_deal_purged_early', '_cloud_todo_purge', [("d.restorable_until < now()   /*PURGE:deal_age*/", "d.restorable_until < now() + interval '31 days'", 1)], P('p_purge')))
    m.append(fn_mutant('C27_resync_from_head_only', 'cloud_todo_pull', [("'resync_required', (v_after > 0 AND v_after < v_forgot) OR v_after > v_head);", "'resync_required', v_after > v_head);", 1)], P('p_purge')))
    m.append(fn_mutant('C16_restore_purged', AO, [("IF c.purged_at IS NOT NULL OR (ent = 'item' AND t.purged_at IS NOT NULL) THEN", "IF false THEN", 1)], P('p_purge')))
    m.append(fn_mutant('Q8_purge_live_deal', '_cloud_todo_purge_deal', [("IF v_rem IS NULL THEN RETURN 'not_removed'; END IF;", "", 1)], P('p_purge_now')))
    m.append(fn_mutant('Q8_purge_other_owner', '_cloud_todo_purge_deal', [("WHERE d.id = p_deal AND d.owner_user_id = p_owner FOR UPDATE;", "WHERE d.id = p_deal FOR UPDATE;", 1)], P('p_purge_now')))
    m.append(fn_mutant('CL_purge_deal_trusts_empty_claims', '_cloud_todo_purge_deal', [("AND auth.role() IS DISTINCT FROM 'service_role')", "AND auth.role() IS NOT NULL AND auth.role() IS DISTINCT FROM 'service_role')", 1)], P('p_claims')))
    m.append(fn_mutant('CL_core_owner_check', '_cloud_todo_apply', [("IF p_owner IS NULL OR p_owner IS DISTINCT FROM auth.uid() THEN", "IF p_owner IS NULL THEN", 1)], P('p_claims')))
    m.append(fn_mutant('C5_replay_dropped', '_cloud_todo_apply', [("WHERE o.owner_user_id = p_owner AND o.op_id = (op ->> 'op_id')::uuid;", "WHERE false;", 1)], P('p_replay')))
    m.append(fn_mutant('C30_upsert_ignores_register', 'cloud_upsert_deal', [("IF EXISTS (SELECT 1 FROM public.cloud_removed_installs ri", "IF false AND EXISTS (SELECT 1 FROM public.cloud_removed_installs ri", 1)], P('p_install')))
    m.append(fn_mutant('C30_push_ignores_register', 'cloud_todo_push', [("IF EXISTS (SELECT 1 FROM public.cloud_removed_installs ri", "IF false AND EXISTS (SELECT 1 FROM public.cloud_removed_installs ri", 1)], P('p_install')))
    m.append(fn_mutant('D2_reclaim_keys_on_argument', 'cloud_reclaim_install', [("WHERE ri.owner_user_id = auth.uid()", "WHERE true", 1)], P('p_install')))
    m.append(fn_mutant('R6_delete_is_hard', 'cloud_delete_deal', [("PERFORM public._cloud_todo_soft_remove_deal(v_uid, v_deal, 'deal',\n            jsonb_build_object('kind', 'desktop', 'ref', NULL, 'label', 'Keepr desktop'));", "DELETE FROM public.cloud_deals WHERE id = v_deal;", 1)], P('p_soft_delete')))
    m.append(fn_mutant('W23_lir_deal_not_removed', 'cloud_list_install_rows', [("'t.id',            't.removed_at IS NOT NULL'),", "'t.id', 'false'),", 1)], P('p_soft_delete')))
    m.append(fn_mutant('W23_installs_count_removed', 'cloud_list_installs', [("AND d.removed_at IS NULL", "", 1)], P('p_soft_delete')))
    m.append(fn_mutant('W23_get_deal_shows_removed', '_mcp_r_get_deal', [("AND x.removed_at IS NULL /*LIVE:get_deal*/", "", 1)], P('p_soft_delete')))
    m.append(fn_mutant('W23_list_shows_removed', '_mcp_r_list_deals', [("AND dl.removed_at IS NULL /*LIVE:list_deals*/", "", 1)], P('p_soft_delete')))
    m.append(fn_mutant('R6_counts_ignore_checklist', '_mcp_r_deal_checklists', [(" AND NOT EXISTS (SELECT 1 FROM public.cloud_deal_checklists cl WHERE cl.id = t.cloud_checklist_id AND cl.removed_at IS NOT NULL) /*LIVE:cl_total_parent*/", "", 1)], P('p_reader_counts')))
    m.append(fn_mutant('C17_ops_left', 'set_my_cloud_autosave', [("DELETE FROM public.cloud_todo_ops WHERE owner_user_id = v_uid;", "NULL;", 1)], P('p_turnoff')))
    m.append(fn_mutant('C17_head_left', 'set_my_cloud_autosave', [("DELETE FROM public.cloud_todo_feed_head WHERE owner_user_id = v_uid;", "NULL;", 1)], P('p_turnoff')))
    m.append(fn_mutant('C17_register_left', 'set_my_cloud_autosave', [("DELETE FROM public.cloud_removed_installs WHERE owner_user_id = v_uid;", "NULL;", 1)], P('p_turnoff')))
    m.append(fn_mutant('C17_history_left', 'set_my_cloud_autosave', [("DELETE FROM public.cloud_todo_history WHERE owner_user_id = v_uid;", "NULL;", 1)], P('p_turnoff'), want='green'))
    m.append(fn_mutant('LO_upsert_head_not_first', 'cloud_upsert_deal', [("PERFORM public._cloud_todo_take_seq(v_uid, 0);                                             /*HEAD:deal*/", "NULL; /*HEAD:deal*/", 1)], P('p_lock_order')))
    m.append(fn_mutant('LO_delete_head_not_first', 'cloud_delete_deal', [("PERFORM public._cloud_todo_take_seq(v_uid, 0);                                             /*HEAD:delete_deal*/", "NULL; /*HEAD:delete_deal*/", 1)], P('p_lock_order')))
    m.append(ddl_mutant('C15_my_items_index_dropped', 'DROP INDEX public.cloud_deal_checklists_my_items_uq',
                        "to_regclass('public.cloud_deal_checklists_my_items_uq') IS NULL", P('p_my_items_unique')))
    m.append(ddl_mutant('C26_direct_change_seq_writer',
                        "CREATE FUNCTION public._p4263_rogue() RETURNS void LANGUAGE sql SET search_path = '' AS $r$ UPDATE public.cloud_deals SET change_seq = 1 WHERE false $r$",
                        "to_regprocedure('public._p4263_rogue()') IS NOT NULL", P('p_seq_catalog')))
    m.append(ddl_mutant('R10_core_granted', 'GRANT EXECUTE ON FUNCTION public._cloud_todo_apply(uuid, jsonb, jsonb) TO authenticated',
                        "has_function_privilege('authenticated', 'public._cloud_todo_apply(uuid,jsonb,jsonb)'::regprocedure, 'EXECUTE')", P('p_grants')))
    m.append(ddl_mutant('R10_push_anon', 'GRANT EXECUTE ON FUNCTION public.cloud_todo_push(uuid, uuid, text, jsonb) TO anon',
                        "has_function_privilege('anon', 'public.cloud_todo_push(uuid,uuid,text,jsonb)'::regprocedure, 'EXECUTE')", P('p_grants')))
    m.append(ddl_mutant('C41_purge_now_anon', 'GRANT EXECUTE ON FUNCTION public.cloud_purge_deal_now(uuid, uuid) TO anon',
                        "has_function_privilege('anon', 'public.cloud_purge_deal_now(uuid,uuid)'::regprocedure, 'EXECUTE')", P('p_purge_now')))
    m.append(ddl_mutant('R10_table_select', 'GRANT SELECT ON public.cloud_todo_history TO authenticated',
                        "has_table_privilege('authenticated', 'public.cloud_todo_history', 'SELECT')", P('p_grants')))
    return m


def compose(sel):
    run = secrets.token_hex(12)
    parts = ["SET LOCAL pg_stat_statements.track = 'none';", "SET LOCAL lock_timeout = '10s';",
             "CREATE TEMP TABLE p4263_out (k text, v text);",
             "CREATE TEMP TABLE p4263_anon_before AS SELECT p.oid::regprocedure::text AS sig FROM pg_proc p "
             "WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege('anon', p.oid, 'EXECUTE');",
             RB, MIG, HL, FX, PR,
             "INSERT INTO pg_temp.p4263_out SELECT 'fixtures', pg_temp.base4263()::text;",
             MIG,
             "INSERT INTO pg_temp.p4263_out SELECT 'fixture_rows_numbered', (SELECT count(*) FILTER (WHERE change_seq IS NULL) || ' unnumbered of ' || count(*) "
             "FROM public.cloud_deal_checklist_items WHERE owner_user_id IN (pg_temp.id('A'), pg_temp.id('B')));"]
    blocks = []
    if sel.get('controls'):
        for c in CONTROLS:
            blocks.append(block('C_' + c, '    v := pg_temp.%s;' % (c if '(' in c else c + '()')))
    ms = mutants()
    if sel.get('mutants'):
        a, b = sel['mutants']
        blocks += ms[a:b]
    if sel.get('only'):
        keep = sel['only']
        blocks += [x for x in ms if any(("'M_" + k) in x for k in keep)]
    parts.append(unit_decls())
    parts.append('DO $drv4263$\nDECLARE v text; t0 text;\nBEGIN\n' + ''.join(blocks) + 'END\n$drv4263$;')
    parts.append("DO $fin4263$ BEGIN RAISE EXCEPTION 'P4263_RESULT %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.p4263_out); END $fin4263$;")
    text = '\n'.join(parts).replace('__RUN__', run)
    assert '__RUN__' not in text
    return text


def run(sel, show=False):
    text = compose(sel)
    if show:
        print(text)
        return 0
    import tempfile
    d = tempfile.mkdtemp()
    p = os.path.join(d, 'c.sql')
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as fh:
        fh.write(text)
    r = subprocess.run([os.path.expanduser('~/.claude/bin/kt-sql'), p], capture_output=True, text=True)
    os.remove(p); os.rmdir(d)
    subprocess.run([os.path.expanduser('~/.claude/bin/kt-sql'), '-c', 'select extensions.pg_stat_statements_reset()'], capture_output=True)
    msg = r.stdout
    try:
        msg = json.loads(r.stdout.strip().split('\n')[0]).get('message', r.stdout)
    except Exception:
        pass
    m = re.search(r'P4263_RESULT (\{.*\})\s*\nCONTEXT', msg, re.S)
    if not m:
        print('NO RESULT:', (msg + r.stderr)[:3000])
        return 2
    res = json.loads(m.group(1))
    bad = 0
    n_ctl = n_mut = 0
    for k in sorted(res):
        v = res[k]
        if k.startswith('C_'):
            n_ctl += 1
            ok = v == 'PASS'
            print('%-6s %s %s' % ('PASS' if ok else 'FAIL', k, '' if ok else v[:900]))
            bad += 0 if ok else 1
        elif k.startswith('M_'):
            n_mut += 1
            want = WANT.get(k, 'red')
            red = v.startswith('FAIL') or v.startswith('CRASH')
            ok = (red and want == 'red') or (v == 'PASS' and want == 'green')
            print('%-6s %s want=%s -> %s' % ('CAUGHT' if (red and want == 'red') else ('EQUIV' if ok else 'MISSED'), k, want, v[:300]))
            bad += 0 if ok else 1
        else:
            print('INFO   %s %s' % (k, v[:600]))
    print('controls=%d mutants=%d problems=%d' % (n_ctl, n_mut, bad))
    if n_ctl + n_mut == 0:
        print('FAIL: zero tests ran')
        return 3
    return 1 if bad else 0


if __name__ == '__main__':
    a = sys.argv[1:]
    if not a or a[0] not in ('run', 'check', 'list'):
        print(__doc__); sys.exit(2)
    if a[0] in ('check', 'list'):
        ms = mutants()
        print('%d mutants, every fragment matched its count' % len(ms))
        sys.exit(0)
    sel = {}
    for x in a[1:]:
        if x == '--controls':
            sel['controls'] = True
        elif x.startswith('--mutants='):
            lo, hi = x.split('=')[1].split('-')
            sel['mutants'] = (int(lo), int(hi))
        elif x.startswith('--only='):
            sel['only'] = x.split('=')[1].split(',')
    sys.exit(run(sel, show='--print' in a))
