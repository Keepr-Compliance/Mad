#!/usr/bin/env python3
"""BACKLOG-4236 two-session mutants: one function each, for run-concurrency.sh on a committed apply.

Usage: mutants.py list
       mutants.py emit <outdir>      writes, per mode, <mode>.mutant.sql and <mode>.pristine.sql, plus
                                     md5.sql (catalog md5(prosrc) and ACL of every target function)
                                     and expected.json (pristine and mutant md5 per mode)

Each fragment is an exact string that must match the migration at HEAD exactly once AND the target
function exactly once, else the script exits non-zero. Each emitted file is one CREATE OR REPLACE of
the one function (with its REVOKE/GRANT lines from the migration) followed by a check that raises
unless the catalog md5(prosrc) equals the expected value, so a wrong text is rolled back in the same
call. The mutant observed values below are PREDICTED from the code; none has been run.
"""
import hashlib, json, os, re, subprocess, sys

here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
MIG = 'supabase/migrations/20261112190000_backlog_4236_cloud_autosave_schema.sql'


def head_text(path):
    return subprocess.check_output(['git', '-C', root, 'show', 'HEAD:' + path], text=True)


def span(text, start, end):
    """The exact substring from `start` through `end` (each must occur once)."""
    assert text.count(start) == 1 and text.count(end) == 1, (start, end)
    i = text.index(start)
    j = text.index(end, i) + len(end)
    return text[i:j]


T = head_text(MIG)
LOCKBLOBS = span(T, '  -- every blob this call can attach or replace, locked once, in id order\n', '/*FILE:lockblobs*/\n')
SETOFF = '    UPDATE public.cloud_autosave_settings SET enabled = false, disabled_at = now(), updated_at = now() WHERE user_id = v_uid;\n'
DEAL_HEAD = ("  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;\n"
             "  IF public.cloud_autosave_entitled() IS NOT TRUE THEN                                       /*ENTITLED:deal*/\n"
             "    RETURN jsonb_build_object('ok', false, 'error', 'not_entitled');\n"
             "  END IF;\n")
DEAL_HEAD_MUT = DEAL_HEAD.split('\n', 1)[1] + DEAL_HEAD.split('\n', 1)[0] + '\n'

# mode: (case, function name, [(old, new)], correct observed, predicted mutant observed)
MODES = {
  'S_C1a_turnoff_unlocked_update_late': ('C1a', 'set_my_cloud_autosave', [
      ('  PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR UPDATE;\n  IF p_enabled THEN\n',
       '  IF p_enabled THEN\n'),
      (SETOFF, ''),
      ('/*SET:fence*/\n    GET DIAGNOSTICS v_fenced = ROW_COUNT;\n', '/*SET:fence*/\n    GET DIAGNOSTICS v_fenced = ROW_COUNT;\n' + SETOFF)],
    'deal applied, blob ok, turn-off success; deals=0 live_new_blob=0 -> PASS',
    'turn-off DELETE and fence run before the writes commit; deals=1 (cc-new) live_new_blob=1 -> FAIL'),
  'S_C1b_deal_share_after_check': ('C1b', 'cloud_upsert_deal', [(DEAL_HEAD, DEAL_HEAD_MUT)],
    'turn-off success; deal and blob {"error":"not_entitled"}; new_deal=0 live_new_blob=0 -> PASS',
    'deal check passes on the old state, waits, inserts after the turn-off: d applied, b not_entitled (unmutated); new_deal=1 -> FAIL'),
  'S_C2_tombstone_no_deal_lock': ('C2', 'cloud_tombstone', [
      (span(T, '  EXECUTE format(\n    \'SELECT array_agg(x.id) FROM (SELECT d.id FROM public.cloud_deals d', '/*TOMB:lockdeals*/\n'), '')],
    'no 40P01; upsert applied; tombstone removed -> PASS',
    'tombstone locks the message, then waits on the deal; the upsert waits on the message: 40P01 in one session -> FAIL'),
  'S_C3_register_no_on_conflict': ('C3', 'cloud_register_blob', [
      ('\n  ON CONFLICT (owner_user_id, sha256) WHERE purge_requested_at IS NULL DO NOTHING;\n', ';\n')],
    'both ok, same blob_id; live_cc_blob=1 -> PASS',
    'second registration waits, then ERROR 23505 (cloud_blobs_live_uq) -> FAIL'),
  'S_C4_blobs_locked_per_row_payload_order': ('C4', 'cloud_upsert_files', [
      (LOCKBLOBS, ''),
      ("         AND b.purge_requested_at IS NULL;                                                    /*FILE:unfenced*/",
       "         AND b.purge_requested_at IS NULL FOR UPDATE;                                         /*FILE:unfenced*/")],
    'no 40P01; both results ok with [applied, applied] -> PASS',
    'session 2 locks the high blob, waits on low; session 1 then waits on high: 40P01 in one session -> FAIL'),
  'S_C5_child_touch_transaction_start': ('C5', 'cloud_upsert_parties', [
      ("  UPDATE public.cloud_deals SET last_synced_at = greatest(last_synced_at, clock_timestamp()) WHERE id = v_deal;   /*CLOCK:parties*/\n",
       "  UPDATE public.cloud_deals SET last_synced_at = now() WHERE id = v_deal;   /*CLOCK:parties*/\n")],
    'upsert applied, mark ok; synced_after_full=true -> PASS',
    'the upsert stamps its transaction start, earlier than the mark: synced_after_full=false -> FAIL'),
}


def function_unit(text, name):
    """(full CREATE ... $tag$; text plus its REVOKE/GRANT lines, prosrc, signature for regprocedure)."""
    start_pat = 'CREATE OR REPLACE FUNCTION public.%s(' % name
    assert text.count(start_pat) == 1, (name, text.count(start_pat))
    i = text.index(start_pat)
    m = re.compile(r'AS (\$[a-z0-9_]*\$)').search(text, i)
    tag = m.group(1)
    b0 = m.end()
    b1 = text.index(tag, b0)
    end = b1 + len(tag) + 1
    assert text[end - 1] == ';', name
    unit = text[i:end] + '\n'
    rest = text[end:].lstrip('\n').split('\n')
    acl = []
    for line in rest:
        if re.match(r'(REVOKE|GRANT) .* ON FUNCTION public\.%s\(' % re.escape(name), line):
            acl.append(line)
        else:
            break
    assert acl, name
    sig = re.search(r'ON FUNCTION (public\.%s\([^)]*\))' % re.escape(name), acl[0]).group(1)
    return unit + '\n'.join(acl) + '\n', text[b0:b1], sig


def md5(s):
    return hashlib.md5(s.encode('utf-8')).hexdigest()


def sql_file(mode, kind, unit, prosrc, sig):
    h = md5(prosrc)
    return ('-- BACKLOG-4236 %s: %s %s (one function, one call; the check rolls the call back on a mismatch)\n'
            '%s'
            'DO $chk4236$ BEGIN\n'
            "  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = '%s'::regprocedure) IS DISTINCT FROM '%s' THEN\n"
            "    RAISE EXCEPTION 'P4236_CATALOG_MISMATCH %s %s';\n"
            '  END IF;\nEND $chk4236$;\n'
            "SELECT '%s' AS fn, '%s' AS state, md5(prosrc) AS md5 FROM pg_catalog.pg_proc WHERE oid = '%s'::regprocedure;\n"
            ) % (kind.upper(), mode, sig, unit, sig, h, mode, kind, sig, kind, sig)


def build():
    out = {}
    for mode, (case, fn, edits, good, bad) in MODES.items():
        unit, prosrc, sig = function_unit(T, fn)
        mut_unit, mut_src = unit, prosrc
        for old, new in edits:
            n_file, n_fn = T.count(old), unit.count(old)
            if n_file != 1 or n_fn != 1:
                sys.exit('%s: fragment matched migration %d times, function %d times (want 1, 1): %r' % (mode, n_file, n_fn, old[:80]))
            mut_unit = mut_unit.replace(old, new)
            mut_src = mut_src.replace(old, new)
        assert mut_src != prosrc and mut_unit.count('CREATE OR REPLACE FUNCTION') == 1
        out[mode] = dict(case=case, fn=fn, sig=sig, unit=unit, prosrc=prosrc, mut_unit=mut_unit, mut_src=mut_src, good=good, bad=bad)
    return out


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'list'
    b = build()
    if cmd == 'list':
        for mode, d in b.items():
            print('%s  %s  %s\n  correct: %s\n  mutant (predicted, not run): %s' % (d['case'], mode, d['sig'], d['good'], d['bad']))
        return
    if cmd != 'emit' or len(sys.argv) < 3:
        sys.exit(__doc__)
    od = sys.argv[2]
    os.makedirs(od, exist_ok=True)
    exp = {}
    for mode, d in b.items():
        open(os.path.join(od, mode + '.mutant.sql'), 'w').write(sql_file(mode, 'mutant', d['mut_unit'], d['mut_src'], d['sig']))
        open(os.path.join(od, mode + '.pristine.sql'), 'w').write(sql_file(mode, 'pristine', d['unit'], d['prosrc'], d['sig']))
        exp[mode] = dict(case=d['case'], sig=d['sig'], pristine_md5=md5(d['prosrc']), mutant_md5=md5(d['mut_src']))
    sigs = sorted({d['sig'] for d in b.values()})
    open(os.path.join(od, 'md5.sql'), 'w').write(
        '-- BACKLOG-4236 target functions: catalog md5(prosrc) and ACL (read-only)\n'
        'SELECT p.oid::regprocedure::text AS fn, md5(p.prosrc) AS md5, p.proacl::text AS acl FROM pg_catalog.pg_proc p\n'
        ' WHERE p.oid IN (%s) ORDER BY 1;\n' % ', '.join("to_regprocedure('%s')" % s for s in sigs))
    json.dump(exp, open(os.path.join(od, 'expected.json'), 'w'), indent=1, sort_keys=True)
    print(json.dumps(exp, indent=1, sort_keys=True))


main()
