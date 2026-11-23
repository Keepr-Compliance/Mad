#!/usr/bin/env python3
"""BACKLOG-4263 sync plan P3 (E1 erase functions, E3 schedule): controls and mutants in ONE kt-sql call each
(one transaction that ends in RAISE, so nothing persists).

Usage: harness.py run [--print] [--controls] [--mutants] [--only=<name,...>] | harness.py check

Needs on the test project: 20261123100000 (S1) applied (E1 refuses without it). E1/E3 need not be applied: the call
runs both rollback files first, then E1 from the working tree, so it always tests this checkout.

Order in a call: lock and statement timeouts; the E3 and E1 rollback files; E1; lib/helpers.sql; lib/probes.sql; each
control (C_*) and/or mutant (M_*) in its own subtransaction, undone at its end; a RAISE carrying the results. A mutant
is an exact-string replace on one function of E1, read from the working tree: a fragment that does not match exactly
once stops the script before anything is sent (MUTATION NOT APPLIED). In the database each mutant is checked by
md5(prosrc) (or a catalogue probe for a DDL mutant) before its probe runs ('NOT APPLIED IN DB' otherwise). A mutant is
caught only when its probe returns FAIL; a CRASH (the mutated function or the probe raised) or a PRECONDITION result
is reported as such and makes the run not-ok. want=green marks a mutant expected to be equivalent. Zero controls and
mutants run is a failure. Afterwards harness.py resets pg_stat_statements.

Load on the shared test database: lock_timeout 3 s on every statement; no table-level lock on an existing table (E1
creates its own two tables; the rollback drops only those); the live claim inside a control takes row locks
(FOR UPDATE SKIP LOCKED) on any eligible row in the database, real rows included, for the length of the call, and
rolls everything back. Cap: 3 full runs per batch.
"""
import hashlib, json, os, re, secrets, subprocess, sys

here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
rd = lambda p: open(os.path.join(root, p)).read()
E1P = 'supabase/migrations/20261123110000_backlog_4263_cloud_blob_erase.sql'
E3P = 'supabase/migrations/20261123120000_backlog_4263_cloud_blob_erase_schedule.sql'
E1, E3 = rd(E1P), rd(E3P)
RB1 = rd('supabase/tests/backlog-4263-sync2-erase/rollback-20261123110000.sql')
RB3 = rd('supabase/tests/backlog-4263-sync2-erase/rollback-20261123120000.sql')
HL = rd('supabase/tests/backlog-4263-sync2-erase/lib/helpers.sql')
PR = rd('supabase/tests/backlog-4263-sync2-erase/lib/probes.sql')
TAG, TAG2 = '$sw4263e$', '$ud4263e$'
for t in (E1, E3, RB1, RB3, HL, PR):
    assert TAG not in t and TAG2 not in t


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
    b0 = text.index('AS $f$', i) + len('AS $f$')
    b1 = text.index('$f$;', b0)
    sig = re.search(r'REVOKE ALL ON FUNCTION (public\.%s\([^)]*\))' % re.escape(name), text[b1:]).group(1)
    return text[i:b1 + 4], text[b0:b1], sig


WANT = {}
UNITS = {}


def block(key, body):
    return ('  v := NULL;\n  BEGIN\n%s\n    RAISE EXCEPTION USING ERRCODE = %s;\n'
            '  EXCEPTION WHEN SQLSTATE %s THEN NULL;\n    WHEN OTHERS THEN EXECUTE %s; v := %s || SQLSTATE || %s || SQLERRM;\n  END;\n'
            '  INSERT INTO pg_temp.p4263e_out VALUES (%s, coalesce(v, %s));\n'
            ) % (body, lit('T4263'), lit('T4263'), lit('RESET ROLE'), lit('CRASH '), lit(' '), lit(key), lit('NULL (body set nothing)'))


def fn_mutant(mode, name, reps, probe, want='red'):
    """reps: [(old, new)], each old must match exactly once in the function's CREATE statement"""
    u, src, sig = unit(E1, name)
    regp = sig
    mu = u
    for old, new in reps:
        n = mu.count(old)
        if n != 1:
            raise SystemExit('MUTATION NOT APPLIED %s: fragment matched %d times in %s: %r' % (mode, n, name, old[:120]))
        mu = mu.replace(old, new)
    assert mu != u
    msrc = mu[mu.index('AS $f$') + 6:mu.rindex('$f$;')]
    print('MUTATION APPLIED %s (%s, mutated body md5 %s)' % (mode, name, md5(msrc)))
    for old, new in reps:
        for l in old.splitlines():
            print('  - ' + l.strip()[:150])
        for l in new.splitlines():
            print('  + ' + l.strip()[:150])
    WANT['M_' + mode] = want
    body = ('    EXECUTE %s;\n'
            "    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(%s)) IS DISTINCT FROM %s THEN\n"
            "      v := 'NOT APPLIED IN DB';\n    ELSE\n      v := %s;\n    END IF;") % (
        q(mu), lit(re.sub(r'\s+', '', regp)), lit(md5(msrc)), probe)
    return block('M_' + mode, body)


def ddl_mutant(mode, sql, verify, probe, want='red'):
    WANT['M_' + mode] = want
    print('MUTATION APPLIED %s (ddl)\n  + %s' % (mode, sql.strip()[:200]))
    body = ("    EXECUTE %s;\n    IF (%s) IS NOT TRUE THEN\n      v := 'NOT APPLIED IN DB';\n    ELSE\n      v := %s;\n    END IF;"
            % (q(sql), verify, probe))
    return block('M_' + mode, body)


CONTROLS = ['p_grants()', 'p_invoke_url()', 'p_secrets(%s)' % q(E1), 'p_c6a()', 'p_c6b()', 'p_c6c()', 'p_c6d()', 'p_c6e()',
            'p_c6f()', 'p_capped()', 'p_note()', 'p_scrub_off()', 'p_owners()', 'p_c6g_seq()', 'p_dry_run()', 'p_e3(%s)' % q(E3),
            'p_rollback(%s, %s)' % (q(RB3), q(RB1))]
CNAME = lambda c: c.split('(')[0]


def mutants():
    P = lambda p: 'pg_temp.%s' % p
    m = []
    C, F, S = 'cloud_blob_erase_claim', 'cloud_blob_erase_finish', 'cloud_blob_erase_scrub'
    m.append(fn_mutant('C6a_finish_ignores_object', F, [(
        "     AND NOT EXISTS (SELECT 1 FROM storage.objects o\n                      WHERE o.bucket_id = 'cloud-deal-files' AND o.name = b.storage_path);   /*FINISH:object_gone*/",
        "     ;")], P('p_c6a()')))
    m.append(fn_mutant('C6a_finish_on_dry_run', F, [("    v_ids := '{}';                                                                           /*FINISH:live_only*/", "    NULL;")], P('p_c6a()')))
    m.append(fn_mutant('Erase_lists_unfenced', C, [(
        "       WHERE b.purge_requested_at IS NOT NULL                                                /*ERASE:fenced*/",
        "       WHERE (b.purge_requested_at IS NOT NULL OR b.uploaded_at IS NOT NULL)")], P('p_c6c()')))
    m.append(fn_mutant('Listing_cap_not_recorded', C, [(
        "    'listing_capped', (v_n_blobs >= p_limit)::integer + (v_n_rowless >= p_limit)::integer);   /*COUNT:listing_capped*/",
        "    'listing_capped', 0);")], P('p_capped()')))
    m.append(fn_mutant('Note_overwrites_counts', 'cloud_blob_erase_note', [(
        "     AND NOT (r.counts ? e.k);                                                               /*NOTE:new_keys_only*/", "     ;")], P('p_note()')))
    m.append(fn_mutant('Note_sets_any_outcome', 'cloud_blob_erase_note', [(
        "         outcome = CASE WHEN p_outcome = 'partial' AND r.outcome = 'ok' THEN 'partial' ELSE r.outcome END   /*NOTE:outcome*/",
        "         outcome = p_outcome")], P('p_note()')))
    m.append(fn_mutant('C6b_claim_lists_referenced', C, [(
        "         AND NOT EXISTS (SELECT 1 FROM public.cloud_deal_files f WHERE f.blob_id = b.id)     /*ERASE:unreferenced*/\n", "")], P('p_c6b()')))
    m.append(fn_mutant('C6b_finish_deletes_referenced', F, [(
        "     AND NOT EXISTS (SELECT 1 FROM public.cloud_deal_files f WHERE f.blob_id = b.id)         /*FINISH:unreferenced*/\n", "")], P('p_c6b()')))
    m.append(fn_mutant('C6c_orphan_age_registration_only', C, [(
        "AND greatest(x.created_at, coalesce(x.uploaded_at, x.created_at)) < v_cut   /*ORPHAN:age*/", "AND x.created_at < v_cut")], P('p_c6c()')))
    m.append(fn_mutant('C6c_orphan_no_age', C, [(
        "AND greatest(x.created_at, coalesce(x.uploaded_at, x.created_at)) < v_cut   /*ORPHAN:age*/", "AND true")], P('p_c6c()')))
    m.append(fn_mutant('C6d_hard_delete_without_age', C, [(
        "       WHERE m.removed_at < v_cut                                                            /*HARD:messages_age*/",
        "       WHERE m.removed_at IS NOT NULL"),
        ("    DELETE FROM public.cloud_deal_messages m WHERE m.id = ANY (v_msg) AND m.removed_at < v_cut;",
         "    DELETE FROM public.cloud_deal_messages m WHERE m.id = ANY (v_msg);")], P('p_c6d()')))
    m.append(fn_mutant('P3c4_message_files_left_live', C, [(
        "      UPDATE public.cloud_deal_files f SET removed_at = now(), version = f.version + 1, updated_at = now(),\n"
        "             filename = NULL, blob_id = NULL                                                 /*HARD:message_files*/\n"
        "       WHERE f.id = ANY (r.ids) AND f.removed_at IS NULL;", "      PERFORM 1;")], P('p_c6d()')))
    m.append(fn_mutant('C6e_rowless_arm_dropped', C, [(
        "         AND NOT EXISTS (SELECT 1 FROM public.cloud_blobs b WHERE b.storage_path = o.name)\n       ORDER BY o.created_at, o.name LIMIT p_limit) z;",
        "         AND false\n       ORDER BY o.created_at, o.name LIMIT p_limit) z;")], P('p_c6e()')))
    m.append(fn_mutant('C6e_rowless_no_age', C, [(
        "       WHERE o.bucket_id = 'cloud-deal-files' AND o.created_at < v_cut                       /*ROWLESS:age*/",
        "       WHERE o.bucket_id = 'cloud-deal-files'")], P('p_c6e()')))
    # the install filter is written twice (candidate select and UPDATE re-check); each alone is masked by the other
    m.append(fn_mutant('C6f_install_filter_select_only', S, [(
        "                    AND d.source_install_id IS DISTINCT FROM v_active)                       /*SCRUB:inactive_files*/", ")")],
        P('p_c6f()'), want='green'))
    m.append(fn_mutant('C6f_install_filter_both', S, [
        ("                    AND d.source_install_id IS DISTINCT FROM v_active)                       /*SCRUB:inactive_files*/", ")"),
        ("     AND EXISTS (SELECT 1 FROM public.cloud_deals d WHERE d.id = f.cloud_deal_id\n"
         "                  AND d.source_install_id IS DISTINCT FROM v_active);                        /*SCRUB:recheck_files*/", ";")], P('p_c6f()')))
    m.append(fn_mutant('C6f_switch_ignored', S, [(
        "    v_on := coalesce((SELECT bool_or(x.one_computer)\n                        FROM (SELECT w.one_computer FROM public.cloud_release_switches w FOR SHARE) x), false);   /*SCRUB:switch*/",
        "    v_on := true;")], P('p_scrub_off()')))
    m.append(fn_mutant('C6f_null_active_scrubs', S, [("  IF NOT v_on OR v_active IS NULL THEN                                                       /*SCRUB:applies*/",
                                                      "  IF NOT v_on THEN")], P('p_scrub_off()')))
    m.append(fn_mutant('C6f_batch_cap_raised', S, [("p_limit NOT BETWEEN 1 AND 1000 THEN", "p_limit NOT BETWEEN 1 AND 100000 THEN")], P('p_c6f()')))
    m.append(fn_mutant('C6f_blobs_not_fenced', S, [("  v_fenced := public._cloud_fence_unreferenced(p_owner, v_blobs);                            /*SCRUB:fence*/",
                                                    "  v_fenced := 0;")], P('p_c6f()')))
    m.append(fn_mutant('Owners_newest_first', C, [("jsonb_agg(o.user_id ORDER BY o.since NULLS FIRST, o.user_id)",
                                                   "jsonb_agg(o.user_id ORDER BY o.since DESC NULLS LAST, o.user_id)")], P('p_owners()')))
    m.append(fn_mutant('Dry_claim_does_live_work', C, [("  IF p_dry_run THEN                                                                          /*MODE:claim*/",
                                                        "  IF false THEN")], P('p_dry_run()')))
    m.append(fn_mutant('Dry_scrub_does_live_work', S, [("  IF p_dry_run THEN\n    SELECT count(*) INTO v_nf FROM (", "  IF false THEN\n    SELECT count(*) INTO v_nf FROM (")],
                       P('p_dry_run()')))
    m.append(fn_mutant('Invoke_without_url_check', 'cloud_blob_erase_invoke', [(
        "  IF v_url IS NULL OR btrim(v_url) = '' THEN                                                 /*INVOKE:url_required*/",
        "  IF false THEN")], P('p_invoke_url()')))
    m.append(ddl_mutant('Invoke_granted_service_role', 'GRANT EXECUTE ON FUNCTION public.cloud_blob_erase_invoke() TO service_role',
                        "has_function_privilege('service_role', 'public.cloud_blob_erase_invoke()', 'EXECUTE')", P('p_grants()')))
    m.append(ddl_mutant('Claim_granted_authenticated', 'GRANT EXECUTE ON FUNCTION public.cloud_blob_erase_claim(boolean, integer, integer) TO authenticated',
                        "has_function_privilege('authenticated', 'public.cloud_blob_erase_claim(boolean,integer,integer)', 'EXECUTE')", P('p_grants()')))
    return m


def compose(sel):
    run = secrets.token_hex(12)
    parts = ["SET LOCAL pg_stat_statements.track = 'none';", "SET LOCAL lock_timeout = '3s';", "SET LOCAL statement_timeout = '240s';",
             "CREATE TEMP TABLE p4263e_out (k text, v text);",
             RB3, RB1, E1, HL, PR]
    blocks = []
    if sel.get('controls'):
        for c in CONTROLS:
            blocks.append(block('C_' + CNAME(c), '    v := pg_temp.%s;' % c))
    ms = mutants()
    if sel.get('mutants'):
        blocks += ms
    if sel.get('only'):
        blocks += [x for x in ms if any(("'M_" + k + "'") in x for k in sel['only'])]
    parts.append('DO $drv4263e$\nDECLARE v text;\nBEGIN\n' + ''.join(blocks) + 'END\n$drv4263e$;')
    parts.append("DO $fin4263e$ BEGIN RAISE EXCEPTION 'P4263E_RESULT %', (SELECT jsonb_object_agg(k, v) FROM pg_temp.p4263e_out); END $fin4263e$;")
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
    m = re.search(r'P4263E_RESULT (\{.*\})\s*\nCONTEXT', msg, re.S)
    if not m:
        print('NO RESULT:', (msg + r.stderr)[:3000])
        return 2
    res = json.loads(m.group(1))
    bad = n_ctl = n_mut = 0
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
            # only a FAIL from the probe counts as caught; a CRASH (the mutated function or the probe errored) or a
            # PRECONDITION result says nothing about the mutant and is a problem of the run
            red = v.startswith('FAIL')
            ok = (red and want == 'red') or (v == 'PASS' and want == 'green')
            tag = 'CAUGHT' if (red and want == 'red') else ('EQUIV' if ok else ('CRASH' if v.startswith('CRASH') else
                  ('PRECOND' if v.startswith('PRECONDITION') else 'MISSED')))
            print('%-7s %s want=%s -> %s' % (tag, k, want, v[:300]))
            bad += 0 if ok else 1
    print('controls=%d mutants=%d problems=%d' % (n_ctl, n_mut, bad))
    if n_ctl + n_mut == 0:
        print('FAIL: zero tests ran')
        return 3
    return 1 if bad else 0


if __name__ == '__main__':
    a = sys.argv[1:]
    if not a or a[0] not in ('run', 'check'):
        print(__doc__); sys.exit(2)
    if a[0] == 'check':
        ms = mutants()
        print('%d mutants, every fragment matched exactly once; %d controls' % (len(ms), len(CONTROLS)))
        sys.exit(0)
    sel = {}
    for x in a[1:]:
        if x == '--controls':
            sel['controls'] = True
        elif x == '--mutants':
            sel['mutants'] = True
        elif x.startswith('--only='):
            sel['only'] = x.split('=')[1].split(',')
    sys.exit(run(sel, show='--print' in a))
