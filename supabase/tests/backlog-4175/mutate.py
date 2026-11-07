#!/usr/bin/env python3
"""BACKLOG-4175 migration A mutations. For each mode: exact-string replace on the migration (or
rollback) FILE, each fragment required to match exactly the stated number of times (else exit),
print MUTATION APPLIED + the changed lines + `git diff --numstat`, run the controls with
--with-migration (one keepr-test transaction ending in RAISE, so nothing persists), print the
reds, then restore the file with `git checkout --` and assert it is clean.
Commit the migration and rollback BEFORE running this: the restore is a checkout.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
"""
import os, subprocess, sys, json
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
MIG = 'supabase/migrations/20261108100000_backlog_4175_sender_rule_sets.sql'
RB = 'supabase/tests/backlog-4175/rollback-4175.sql'

GATE = "public.report_my_access('sender-rules') IS DISTINCT FROM 'owner'"
NOT_EXISTS = ("      WHERE NOT EXISTS (\n"
              "        SELECT 1 FROM jsonb_array_elements(coalesce(CASE WHEN l.dir = 'add' THEN p_old ELSE p_new END #> l.path, '[]'::jsonb)) AS y(v)\n"
              "        WHERE y.v = x.v)\n")
REL_INSERT = ("    INSERT INTO public.sender_rule_sets (version, content, released, bundled, canary_org, published_by)\n"
              "    VALUES (v_new, v_content, true, false, NULL, v_uid);\n")
PIN_BELOW = ("  IF p_version < (SELECT max(version) FROM public.sender_rule_sets WHERE released) THEN\n"
             "    RAISE EXCEPTION 'Cannot pin below the latest released version; roll back by publishing the old content as a new version'\n"
             "      USING ERRCODE = '22023';\n"
             "  END IF;\n")
# mode -> list of (file, old, new, expected match count)
MUT = {
  'TABLE_select_granted': [(MIG, "ALTER TABLE public.sender_rule_sets ENABLE ROW LEVEL SECURITY;\n",
      "ALTER TABLE public.sender_rule_sets ENABLE ROW LEVEL SECURITY;\nGRANT SELECT ON public.sender_rule_sets TO authenticated;\n", 1)],
  'CURRENT_anon_revoke_dropped': [(MIG, "REVOKE EXECUTE ON FUNCTION public.sender_rule_set_current() FROM PUBLIC, anon;\n", "", 1)],
  'CURRENT_returns_extra_key': [(MIG, "RETURN jsonb_build_object('version', v_version, 'content', v_content);",
      "RETURN jsonb_build_object('version', v_version, 'content', v_content, 'org', v_org);", 1)],
  'VALIDATOR_authenticated_execute': [(MIG, "REVOKE EXECUTE ON FUNCTION public._sender_rule_set_invalid(JSONB) FROM PUBLIC, anon, authenticated;",
      "REVOKE EXECUTE ON FUNCTION public._sender_rule_set_invalid(JSONB) FROM PUBLIC, anon;", 1)],
  'GATE_any_access': [(MIG, GATE, "public.report_my_access('sender-rules') IS NULL", 3)],
  'GATE_ne_owner': [(MIG, GATE, "public.report_my_access('sender-rules') <> 'owner'", 3)],
  'ORG_no_brokerage_first': [(MIG, "ORDER BY (o.personal_owner_user_id IS NOT NULL), om.created_at", "ORDER BY om.created_at", 1)],
  'ORG_no_active_filter': [(MIG, "\n    AND om.license_status = 'active'\n", "\n", 1)],
  'PIN_below_released_allowed': [(MIG, PIN_BELOW, "", 1)],
  'CURRENT_serves_canary': [(MIG, "    FROM public.sender_rule_sets s\n    WHERE s.released\n", "    FROM public.sender_rule_sets s\n", 1)],
  'VALIDATOR_suppress_subset': [(MIG,
      "IF NOT public._sender_rule_set_keys_exact(p->'suppress', ARRAY['exactAddresses', 'hosts', 'localParts', 'bulkHeaders']) THEN",
      "IF NOT coalesce((p->'suppress') ?& ARRAY['exactAddresses', 'hosts', 'localParts', 'bulkHeaders'], false) THEN", 1)],
  'PUBLISH_no_validate': [(MIG, "  v_reason := public._sender_rule_set_invalid(p_content);\n", "", 1)],
  'STR_no_typeof': [(MIG, "    WHEN jsonb_typeof(v) IS DISTINCT FROM 'string' THEN false\n", "    WHEN v IS NULL THEN false\n", 1)],
  'STR_null_passes': [(MIG, "    WHEN jsonb_typeof(v) IS DISTINCT FROM 'string' THEN false\n", "    WHEN false THEN false\n", 1),
                      (MIG, "      FROM (SELECT v #>> '{}' AS s) x), false)\n", "      FROM (SELECT v #>> '{}' AS s) x), NULL)\n", 1)],
  'GUARD_vs_seed': [(MIG, "  FROM public.sender_rule_sets WHERE released ORDER BY version DESC LIMIT 1;\n",
      "  FROM public.sender_rule_sets WHERE version = 1;\n", 1)],
  'GUARD_measure_to_live_only': [(MIG, "AND (p_old #> ARRAY['modes', s.key, f.key]) IS DISTINCT FROM '\"live\"'::jsonb",
      "AND (p_old #> ARRAY['modes', s.key, f.key]) = '\"measure\"'::jsonb", 1)],
  'GUARD_hardcoded_signals': [(MIG, "FROM jsonb_each(p_new->'modes') s, jsonb_each(s.value) f",
      "FROM jsonb_each(p_new->'modes' - 'gmailSocial') s, jsonb_each(s.value) f", 1)],
  'PROMOTE_keeps_pins': [(MIG, "    DELETE FROM public.sender_rule_set_pins WHERE version < v_new;\n", "", 1)],
  'GUARD_stale_canary_counts': [(MIG, "      WHERE NOT k.released AND k.version > p_after\n        AND k.content #> ARRAY['modes', c.sig, c.surf]",
      "      WHERE NOT k.released\n        AND k.content #> ARRAY['modes', c.sig, c.surf]", 1)],
  'GUARD_no_hosts': [(MIG, "      ('{suppress,hosts}'::text[], 'add', 'approvedHost'),\n", "", 1)],
  'GUARD_ignores_liveness': [(MIG, "ELSE l.sig = ANY (v_live) END);", "ELSE true END);", 1)],
  'GUARD_length_compare': [(MIG, NOT_EXISTS,
      "      WHERE jsonb_array_length(CASE WHEN l.dir = 'add' THEN p_new ELSE p_old END #> l.path)\n"
      "          > jsonb_array_length(coalesce(CASE WHEN l.dir = 'add' THEN p_old ELSE p_new END #> l.path, '[]'::jsonb))\n", 1)],
  'GUARD_localpart_by_value': [(MIG, "        WHERE y.v = x.v)\n", "        WHERE y.v = x.v OR y.v->'value' = x.v->'value')\n", 1)],
  'GUARD_no_keep_removal': [(MIG, "      ('{keep,platformHosts}'::text[], 'remove', NULL),\n", "", 1)],
  'GUARD_no_freemail': [(MIG, "      ('{keep,platformAddresses}'::text[], 'remove', NULL),\n      ('{freeMailDomains}'::text[], 'add', NULL)\n",
      "      ('{keep,platformAddresses}'::text[], 'remove', NULL)\n", 1)],
  'GUARD_no_auto_submitted_flag': [(MIG, "  IF 'bulkHeaders' = ANY (v_live)\n", "  IF false AND 'bulkHeaders' = ANY (v_live)\n", 1)],
  'REVERT_via_publish': [(MIG,
      "  INSERT INTO public.sender_rule_sets (version, content, released, bundled, canary_org, published_by)\n"
      "  VALUES (v_new, jsonb_set(v_bundled, '{version}', to_jsonb(v_new)), true, false, NULL, v_uid);\n",
      "  PERFORM public.sender_rule_set_publish(v_bundled);\n", 1)],
  'REVERT_keeps_pins': [(MIG, "  DELETE FROM public.sender_rule_set_pins WHERE true;\n", "", 1)],
  'REVERT_copies_latest_released': [(MIG, "  FROM public.sender_rule_sets WHERE bundled ORDER BY version DESC LIMIT 1;",
      "  FROM public.sender_rule_sets WHERE released ORDER BY version DESC LIMIT 1;", 1)],
  'REVERT_copies_v1': [(MIG, "  FROM public.sender_rule_sets WHERE bundled ORDER BY version DESC LIMIT 1;",
      "  FROM public.sender_rule_sets WHERE version = 1;", 1)],
  'PUBLISH_overwrites_released_row': [(MIG, REL_INSERT,
      "    UPDATE public.sender_rule_sets SET content = jsonb_set(v_content, '{version}', to_jsonb(v_rel_version)) WHERE version = v_rel_version;\n"
      "    v_new := v_rel_version;\n", 1)],
  'PUBLISH_keeps_client_version': [(MIG, "  v_content := jsonb_set(p_content, '{version}', to_jsonb(v_new));\n", "  v_content := p_content;\n", 1)],
  'SR_remove_polarity': [(MIG, "              = (l.dir = 'add')\n", "              = true\n", 1)],
  'SR_list_any_canary': [(MIG, "          AND (EXISTS (SELECT 1 FROM jsonb_array_elements(k.content #> l.path) AS z(v) WHERE z.v = e))\n              = (l.dir = 'add')\n", "", 1)],
  'SR_mode_any_canary': [(MIG, "      WHERE NOT k.released AND k.version > p_after\n        AND k.content #> ARRAY['modes', c.sig, c.surf] = '\"live\"'::jsonb\n", "      WHERE NOT k.released AND k.version > p_after\n", 1)],
  'SR_liveness_from_old': [(MIG, "  FROM jsonb_each(p_new->'modes') s\n  WHERE EXISTS", "  FROM jsonb_each(p_old->'modes') s\n  WHERE EXISTS", 1)],
  'SEED_host_edited': [(MIG, '"springcm.net"', '"springcm.org"', 1)],
  'SEED_not_idempotent': [(MIG, "::jsonb, true, true)\nON CONFLICT (version) DO NOTHING;\n", "::jsonb, true, true);\n", 1)],
  'CHECK_dropped': [(MIG, "  CONSTRAINT sender_rule_sets_content_valid CHECK (public._sender_rule_set_invalid(content) IS NULL),\n", "", 1)],
  'CATALOG_key_missing': [(MIG, "INSERT INTO public.reports (report_key) VALUES ('sender-rules') ON CONFLICT (report_key) DO NOTHING;\n", "", 1)],
  'ROLLBACK_misses_function': [(RB, "DROP FUNCTION IF EXISTS public._sender_rule_set_str_ok(JSONB, TEXT);\n", "", 1)],
  'ROLLBACK_validators_first': [(RB, "DROP TABLE IF EXISTS public.sender_rule_set_pins;\n",
      "DROP FUNCTION IF EXISTS public._sender_rule_set_invalid(JSONB);\nDROP TABLE IF EXISTS public.sender_rule_set_pins;\n", 1),
      (RB, "DROP TABLE IF EXISTS public.sender_rule_sets;\nDROP FUNCTION IF EXISTS public._sender_rule_set_invalid(JSONB);\n",
       "DROP TABLE IF EXISTS public.sender_rule_sets;\n", 1)],
}

def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, cwd=root)

if sh('git', 'status', '--porcelain', '--', MIG, RB).stdout.strip():
    sys.exit('migration/rollback have uncommitted changes; commit before mutating')

modes = list(MUT) if sys.argv[1] == 'all' else sys.argv[1].split(',')
for mode in modes:
    files = sorted({f for f, *_ in MUT[mode]})
    try:
        for fn, old, new, cnt in MUT[mode]:
            path = os.path.join(root, fn)
            body = open(path).read()
            n = body.count(old)
            if n != cnt:
                print('== %s\nMUTATION NOT APPLIED: fragment matched %d times (expected %d)' % (mode, n, cnt))
                raise SystemExit(2)
            open(path, 'w').write(body.replace(old, new))
        ns = sh('git', 'diff', '--numstat', '--', *files).stdout.strip()
        if not ns:
            print('== %s\nMUTATION NOT APPLIED: git diff empty' % mode)
            raise SystemExit(2)
        changed = [l for l in sh('git', 'diff', '-U0', '--', *files).stdout.splitlines()
                   if l[:1] in '+-' and not l.startswith(('+++', '---'))]
        print('== %s' % mode)
        print('MUTATION APPLIED numstat=%s' % ' '.join(x.split('\t')[0] + '/' + x.split('\t')[1] for x in ns.splitlines()))
        for l in changed:
            print('  %s %s' % (l[0], l[1:].strip()[:150]))
        out = subprocess.run([os.path.join(here, 'run.sh'), '--with-migration'], capture_output=True, text=True)
        o = out.stdout
        try:
            d = json.loads(o[o.index('{'):o.rindex('}') + 1])
            print('RESULT total=%s pass=%s fail=%s reds=%s' % (d['total'], d['pass'], d['fail'], ','.join(sorted(d['reds']))))
            if not d['total']:
                print('ZERO CONTROLS RAN')
        except Exception:
            print('NO RESULT ' + o[:400].replace('\n', ' ') + out.stderr[:200])
    finally:
        sh('git', 'checkout', '--', *files)
        st = sh('git', 'status', '--porcelain', '--', *files).stdout.strip()
        print('RESTORED clean=%s' % (st == ''))
        if st:
            sys.exit('restore failed')
