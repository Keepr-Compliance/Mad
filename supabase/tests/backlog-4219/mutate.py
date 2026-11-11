#!/usr/bin/env python3
"""BACKLOG-4219 PR1 mutations (S13_*: admin list names users by user id, PR3 server change). For each mode: exact-string replace on the migration (or rollback)
FILE, each fragment required to match exactly the stated number of times (else exit), print
MUTATION APPLIED + the changed lines + `git diff --numstat`, run the controls with
--with-migration (one keepr-test transaction ending in RAISE, so nothing persists), print the
reds, then restore the file with `git checkout --` and assert it is clean.
Commit the migration and rollback BEFORE running this: the restore is a checkout.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
"""
import os, subprocess, sys, json
here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
MIG = 'supabase/migrations/20261112130000_backlog_4219_learn_pilot_report.sql'
RB = 'supabase/tests/backlog-4219/rollback-4219.sql'

GATE = "public.report_my_access('learn-pilot') IS NULL"
CAP = ("  DELETE FROM public.learn_pilot_reports\n"
       "  WHERE user_id = v_uid\n"
       "    AND sender_rules_version NOT IN (\n"
       "      SELECT x.sender_rules_version FROM public.learn_pilot_reports x\n"
       "      WHERE x.user_id = v_uid\n")
JOB = ("SELECT cron.schedule(\n  'purge-learn-pilot-reports',\n  '17 4 * * *',\n"
       "  $$DELETE FROM public.learn_pilot_reports WHERE submitted_at < now() - interval '180 days'$$\n);\n")
# mode -> list of (file, old, new, expected match count)
MUT = {
  'S8_pk_user_only': [(MIG, "  PRIMARY KEY (user_id, sender_rules_version),\n", "  PRIMARY KEY (user_id),\n", 1),
      (MIG, "ON CONFLICT (user_id, sender_rules_version) DO UPDATE\n    SET org_id",
       "ON CONFLICT (user_id) DO UPDATE\n    SET sender_rules_version = EXCLUDED.sender_rules_version, org_id", 1)],
  'S9_cap_keeps_highest_versions': [(MIG, "      ORDER BY x.submitted_at DESC, x.sender_rules_version DESC\n",
      "      ORDER BY x.sender_rules_version DESC\n", 1)],
  'S9_cap_ignores_user': [(MIG, CAP,
      "  DELETE FROM public.learn_pilot_reports\n"
      "  WHERE (user_id, sender_rules_version) NOT IN (\n"
      "      SELECT x.user_id, x.sender_rules_version FROM public.learn_pilot_reports x\n", 1)],
  'S9_cap_removed': [(MIG, CAP + "      ORDER BY x.submitted_at DESC, x.sender_rules_version DESC\n      LIMIT 5);\n", "", 1)],
  'S10_withdraw_newest_only': [(MIG, "  DELETE FROM public.learn_pilot_reports WHERE user_id = v_uid;\n",
      "  DELETE FROM public.learn_pilot_reports WHERE user_id = v_uid AND submitted_at = (SELECT max(submitted_at) FROM public.learn_pilot_reports WHERE user_id = v_uid);\n", 1)],
  'S10_withdraw_any_user': [(MIG, "  DELETE FROM public.learn_pilot_reports WHERE user_id = v_uid;\n",
      "  DELETE FROM public.learn_pilot_reports WHERE true;\n", 1)],
  'S3_withdraw_needs_membership': [(MIG, "  DELETE FROM public.learn_pilot_reports WHERE user_id = v_uid;\n",
      "  IF NOT EXISTS (SELECT 1 FROM public.organization_members om WHERE om.user_id = v_uid AND om.license_status = 'active') THEN\n"
      "    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';\n  END IF;\n"
      "  DELETE FROM public.learn_pilot_reports WHERE user_id = v_uid;\n", 1)],
  'S1_by_signal_values_only': [(MIG, "OR NOT public._learn_pilot_counts_ok(m->part->'by_signal', v_signals) THEN",
      "OR EXISTS (SELECT 1 FROM jsonb_each(m->part->'by_signal') e WHERE NOT public._learn_pilot_int_ok(e.value)) THEN", 1)],
  'S1_int_allows_float': [(MIG, "x = trunc(x) AND x >= 0", "x >= 0", 1)],
  'S1_int_allows_negative': [(MIG, "x = trunc(x) AND x >= 0", "x = trunc(x)", 1)],
  'S1_int_no_upper_bound': [(MIG, " AND x <= 10000000\n", "\n", 1)],
  'S1_top_keys_not_exact': [(MIG, "    RETURN 'report keys';\n", "    NULL;\n", 1)],
  'S1_no_schema_check': [(MIG, "  IF p->'schema' IS DISTINCT FROM '1'::jsonb THEN\n    RETURN 'schema';\n  END IF;\n", "", 1)],
  'S1_source_any_string': [(MIG, "     OR (p->>'sender_rules_source') NOT IN ('download', 'cache', 'bundled') THEN", " THEN", 1)],
  'S1_provider_any_string': [(MIG, "       OR (m->>'provider') NOT IN ('gmail', 'outlook', 'unknown') THEN", " THEN", 1)],
  'S1_app_version_any_string': [(MIG, "     OR (p->>'app_version') !~ '^[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,6}$' THEN", " THEN", 1)],
  'S1_coverage_keys_not_exact': [(MIG, "  IF NOT public._sender_rule_set_keys_exact(c->'coverage', ARRAY['gmail', 'outlook', 'unknown'])\n     OR EXISTS",
      "  IF EXISTS", 1)],
  'S1_mailboxes_uncapped': [(MIG, " OR jsonb_array_length(c->'mailboxes') > 10 THEN", " THEN", 1)],
  'S1_size_cap_dropped': [(MIG, "  IF octet_length(p::text) > 32768 THEN\n    RETURN 'too large';\n  END IF;\n", "", 1)],
  'S1_detector_block_unchecked': [(MIG, "  FOREACH k IN ARRAY ARRAY['learn_questions', 'detector'] LOOP\n",
      "  FOREACH k IN ARRAY ARRAY['learn_questions'] LOOP\n", 1)],
  'S2_org_no_brokerage_first': [(MIG, "ORDER BY (o.personal_owner_user_id IS NOT NULL), om.created_at", "ORDER BY om.created_at", 1)],
  'S6_org_no_active_filter': [(MIG, "\n    AND om.license_status = 'active'\n  ORDER BY", "\n  ORDER BY", 1)],
  'S6_no_feature_check': [(MIG, "  IF (public.check_feature_access(v_org, 'autodetect_eval') ->> 'allowed') IS DISTINCT FROM 'true' THEN\n"
      "    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';\n  END IF;\n", "", 1)],
  'S12_version_zero_allowed': [(MIG, "  IF (p->>'sender_rules_version')::numeric < 1 THEN\n    RETURN 'sender_rules_version';\n  END IF;\n", "", 1)],
  'S12_column_from_other_field': [(MIG, "  v_version := (p_report->>'sender_rules_version')::bigint;", "  v_version := (p_report->>'learn_rules_version')::bigint;", 1)],
  'S4_gate_not_in': [(MIG, GATE, "public.report_my_access('learn-pilot') NOT IN ('owner', 'editor', 'viewer')", 1)],
  'S4_gate_ne': [(MIG, GATE, "public.report_my_access('learn-pilot') <> 'none'", 1)],
  'S4_gate_dropped': [(MIG, "\n     OR " + GATE + " THEN", " THEN", 1)],
  'S4_internal_roles_exists_dropped': [(MIG, "\n     OR NOT EXISTS (SELECT 1 FROM public.internal_roles ir WHERE ir.user_id = v_uid)", "", 1)],
  'S4_seed_missing': [(MIG, "INSERT INTO public.reports (report_key) VALUES ('learn-pilot') ON CONFLICT (report_key) DO NOTHING;\n", "", 1)],
  'S4_no_active_member_filter': [(MIG, "\n      AND EXISTS (SELECT 1 FROM public.organization_members om\n                  WHERE om.user_id = r.user_id AND om.organization_id = r.org_id\n                    AND om.license_status = 'active')\n", "\n", 1)],
  'S7_no_read_filter': [(MIG, "    WHERE r.submitted_at >= now() - interval '180 days'\n      AND EXISTS", "    WHERE EXISTS", 1)],
  'S7_job_dropped': [(MIG, JOB, "", 1)],
  'S7_job_flipped': [(MIG, "WHERE submitted_at < now() - interval '180 days'$$", "WHERE submitted_at > now() - interval '180 days'$$", 1)],
  'S7_no_submit_sweep': [(MIG, "  DELETE FROM public.learn_pilot_reports WHERE submitted_at < now() - interval '180 days';\nEND", "END", 1)],
  'S11_inner_join_versions': [(MIG, "  LEFT JOIN public.sender_rule_sets s ON", "  JOIN public.sender_rule_sets s ON", 1)],
  'S11_canary_any_org': [(MIG, "coalesce(s.canary_org = pg.org_id, false)", "coalesce(s.canary_org IS NOT NULL, false)", 1)],
  'S11_leaks_published_by': [(MIG, "      'version_canary_org', s.canary_org,\n", "      'version_canary_org', s.canary_org,\n      'published_by', s.published_by,\n", 1)],
  'S5_table_select_granted': [(MIG, "ALTER TABLE public.learn_pilot_reports ENABLE ROW LEVEL SECURITY;\n",
      "ALTER TABLE public.learn_pilot_reports ENABLE ROW LEVEL SECURITY;\nGRANT SELECT ON public.learn_pilot_reports TO authenticated;\n", 1)],
  'S5_table_truncate_granted': [(MIG, "ALTER TABLE public.learn_pilot_reports ENABLE ROW LEVEL SECURITY;\n",
      "ALTER TABLE public.learn_pilot_reports ENABLE ROW LEVEL SECURITY;\nGRANT TRUNCATE ON public.learn_pilot_reports TO authenticated;\n", 1)],
  'S5_validator_authenticated': [(MIG, "REVOKE EXECUTE ON FUNCTION public._learn_pilot_report_invalid(JSONB) FROM PUBLIC, anon, authenticated;",
      "REVOKE EXECUTE ON FUNCTION public._learn_pilot_report_invalid(JSONB) FROM PUBLIC, anon;", 1)],
  'S5_submit_revoke_dropped': [(MIG, "REVOKE EXECUTE ON FUNCTION public.learn_pilot_report_submit(JSONB) FROM PUBLIC, anon;\n", "", 1)],
  'S5_list_anon_granted': [(MIG, "GRANT EXECUTE ON FUNCTION public.learn_pilot_report_admin_list() TO authenticated;",
      "GRANT EXECUTE ON FUNCTION public.learn_pilot_report_admin_list() TO authenticated, anon;", 1)],
  'S13_revert_to_email_label': [(MIG, "      'user_id', pg.user_id,\n", "      'user_label', u.email,\n", 1),
      (MIG, "  LEFT JOIN public.sender_rule_sets s ON", "  LEFT JOIN auth.users u ON u.id = pg.user_id\n  LEFT JOIN public.sender_rule_sets s ON", 1)],
  'S13_user_id_holds_email': [(MIG, "      'user_id', pg.user_id,\n", "      'user_id', (SELECT u.email FROM auth.users u WHERE u.id = pg.user_id),\n", 1)],
  'S13_email_beside_user_id': [(MIG, "      'user_id', pg.user_id,\n", "      'user_id', pg.user_id,\n      'user_email', (SELECT u.email FROM auth.users u WHERE u.id = pg.user_id),\n", 1)],
  'S13_name_falls_back_to_email': [(MIG, "nullif(pu.last_name, '')), ''))", "nullif(pu.last_name, '')), ''), pu.email)", 1)],
  'S13_name_email_guard_dropped': [(MIG, "CASE WHEN nm.name LIKE '%@%' THEN NULL ELSE nm.name END", "nm.name", 1)],
  'S13_name_display_only': [(MIG, "nullif(concat_ws(' ', nullif(pu.first_name, ''), nullif(pu.last_name, '')), '')) AS name", "NULL::text) AS name", 1)],
  'S13_name_first_last_before_display': [(MIG, "coalesce(nullif(pu.display_name, ''),\n                                     nullif(concat_ws(' ', nullif(pu.first_name, ''), nullif(pu.last_name, '')), ''))",
      "coalesce(nullif(concat_ws(' ', nullif(pu.first_name, ''), nullif(pu.last_name, '')), ''),\n                                     nullif(pu.display_name, ''))", 1)],
  'S13_user_id_is_org_id': [(MIG, "      'user_id', pg.user_id,\n", "      'user_id', pg.org_id,\n", 1)],
  'S20_rollback_misses_validator': [(RB, "DROP FUNCTION IF EXISTS public._learn_pilot_int_ok(JSONB);\n", "", 1)],
  'S20_rollback_keeps_job': [(RB, "    PERFORM cron.unschedule('purge-learn-pilot-reports');\n", "    NULL;\n", 1)],
  'S20_rollback_keeps_catalog_key': [(RB, "DELETE FROM public.reports WHERE report_key = 'learn-pilot';\n", "", 1)],
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
