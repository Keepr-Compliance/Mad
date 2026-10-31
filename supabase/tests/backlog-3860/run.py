#!/usr/bin/env python3
"""BACKLOG-3860 PR-1 harness. Venue: keepr-test through ~/.claude/bin/kt-sql.

Every kt-sql call is ONE transaction that ends in RAISE, so nothing persists.

  python3 run.py controls                 # every function-level check on the unmutated files
  python3 run.py scenarios                # apply-level scenarios (pins, apply twice, rollback)
  python3 run.py mutants [fragment]       # baseline first, then every mutant: KILLED / SURVIVED / INVALID

Function mutants live in controls.sql (apply_mode). Migration-text and rollback-text mutants live
here (TEXT_MUTANTS): an exact-count replace that raises when the pattern does not match exactly
once, and the composed text must differ from the clean one, else INVALID.
Exit 0 only when every control passes / every scenario matches / every mutant is KILLED.
"""
import json, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
MIG = os.path.join(HERE, '..', '..', 'migrations', '20261031140000_backlog_3860_solo_trial.sql')
RB = os.path.join(HERE, 'rollback-3860.sql')
CTL = os.path.join(HERE, 'controls.sql')
KT = os.path.expanduser('~/.claude/bin/kt-sql')

FN_MODES = [
    'm01_no_ledger_check', 'm02_no_paid_through', 'm03_setter_rewrites_running', 'm04_start_in_internal',
    'm05_exec_authenticated', 'm05b_ledger_select_authenticated', 'm05c_setter_no_permission',
    'm06_start_any_status', 'm07_no_switch_check', 'm07b_switch_not_null_safe', 'm08_grant_refuses_trial',
    'm08b_only_sourceless_protected', 'm08c_not_in_null_trap', 'm09_trial_replaces_override',
    'm10_no_membership_check', 'm11_no_suspended_check', 'm13_no_exception_block', 'm14_no_length_check',
]


def drift(sig):
    return ("DO $d$ BEGIN EXECUTE replace(pg_get_functiondef('%s'::regprocedure), 'DECLARE', 'DECLARE -- drift'); END $d$;\n" % sig)


DRIFT_CONSTRAINT = ("ALTER TABLE public.billing_settings DROP CONSTRAINT billing_settings_key_ck;\n"
                    "ALTER TABLE public.billing_settings ADD CONSTRAINT billing_settings_key_ck "
                    "CHECK (key IN ('brokerage_billing_live', 'x_other'));\n")

TRIAL_FIXTURE = """
DO $fx$
DECLARE o uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.organizations (id, name, slug, max_seats, is_test) VALUES (o, 'P3860 rb', 'p3860-rb-' || left(o::text, 8), 1, true);
  INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides)
  SELECT o, p.id, jsonb_build_object('unlimited_transactions', jsonb_build_object('enabled', true, 'source', 'trial', 'paid_through', now() + interval '3 days'))
    FROM public.plans p WHERE p.tier = 'individual' AND p.is_default AND p.is_active LIMIT 1;
END $fx$;
"""

CHECK_APPLIED = """
DO $ck$ BEGIN
  IF (SELECT enabled FROM public.billing_settings WHERE key = 'solo_trial') IS NOT FALSE
     OR (SELECT days FROM public.billing_settings WHERE key = 'solo_trial') IS DISTINCT FROM 14
     OR to_regclass('public.solo_trials') IS NULL
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.ensure_personal_organization()'::regprocedure) NOT LIKE '%BACKLOG-3860%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.grant_unlimited_from_subscription(uuid,timestamptz,text)'::regprocedure) NOT LIKE '%BACKLOG-3860%'
     OR (SELECT count(*) FROM public.billing_settings) <> 2
  THEN RAISE EXCEPTION 'SCN_BAD applied state wrong'; END IF;
  RAISE EXCEPTION 'SCN_OK';
END $ck$;
"""

RB_OK = "DO $z$ BEGIN RAISE EXCEPTION 'RB_OK %', (SELECT count(*) FROM public.organization_plans WHERE feature_overrides -> 'unlimited_transactions' ->> 'source' = 'trial'); END $z$;\n"

# name -> (pieces, expected regex on the final message). 'MIG' / 'RB' are the files under test.
SCENARIOS = {
    'S1_apply_once':        (['MIG', CHECK_APPLIED], r'SCN_OK'),
    'S2_apply_twice':       (['MIG', 'MIG', CHECK_APPLIED], r'SCN_OK'),
    'S3_drift_wrapper':     ([drift('public.ensure_personal_organization()'), 'MIG', CHECK_APPLIED], r'ensure_personal_organization body changed'),
    'S4_drift_grant':       ([drift('public.grant_unlimited_from_subscription(uuid,timestamptz,text)'), 'MIG', CHECK_APPLIED], r'grant_unlimited_from_subscription body changed'),
    'S5_drift_internal':    ([drift('public._ensure_personal_organization_for(uuid)'), 'MIG', CHECK_APPLIED], r'_ensure_personal_organization_for body changed'),
    'S6_drift_constraint':  ([DRIFT_CONSTRAINT, 'MIG', CHECK_APPLIED], r'billing_settings_key_ck differs'),
    'S7_rollback_clean':    (['MIG', 'RB', RB_OK], r'RB_OK 0'),
    'S8_rollback_stops_on_trial': (['MIG', TRIAL_FIXTURE, 'RB', RB_OK], r'1 trial override\(s\) exist'),
    'S9_rollback_flag_removes':   (['MIG', TRIAL_FIXTURE, "SET LOCAL keepr.rollback_3860_remove_trial_overrides = 'yes';\n", 'RB', RB_OK], r'RB_OK 0'),
}

# name -> (file 'mig' | 'rb', [(from, to)], targets: scenario names and/or 'controls')
TEXT_MUTANTS = {
    't12a_no_wrapper_pin': ('mig', [(
        "  IF v_src IS NULL OR (md5(v_src) <> '52a3b051fd7f1b464e929fecdc4a90f8' AND v_src NOT LIKE '%BACKLOG-3860%') THEN",
        "  IF false THEN")], ['S3_drift_wrapper']),
    't12a_no_grant_pin': ('mig', [(
        "  IF v_src IS NULL OR (md5(v_src) <> '7a38ab6b47b2c66d85b0f920d74ee68a' AND v_src NOT LIKE '%BACKLOG-3860%') THEN",
        "  IF false THEN")], ['S4_drift_grant']),
    't12a_no_internal_pin': ('mig', [(
        "  IF v_src IS DISTINCT FROM '831f08148d71458c8aa66e106304d6af' THEN",
        "  IF false THEN")], ['S5_drift_internal']),
    't12a_no_constraint_pin': ('mig', [(
        "  IF v_def IS DISTINCT FROM 'CHECK ((key = ''brokerage_billing_live''::text))'\n     AND v_def",
        "  IF false\n     AND v_def")], ['S6_drift_constraint']),
    't12b_key_not_widened': ('mig', [(
        "    ALTER TABLE public.billing_settings DROP CONSTRAINT billing_settings_key_ck;\n"
        "    ALTER TABLE public.billing_settings ADD CONSTRAINT billing_settings_key_ck\n"
        "      CHECK (key IN ('brokerage_billing_live', 'solo_trial'));\n",
        "    NULL;\n")], ['S1_apply_once']),
    't12c_days_null_allowed': ('mig', [(
        "(days IS NOT NULL AND days BETWEEN 1 AND 90)", "(days BETWEEN 1 AND 90)")], ['controls']),
    'rb_no_count_stop': ('rb', [(
        "  IF n > 0 THEN\n    IF coalesce", "  IF false THEN\n    IF coalesce")], ['S8_rollback_stops_on_trial']),
    'rb_through_setter': ('rb', [(
        "    UPDATE public.billing_settings SET enabled = false, updated_at = now() WHERE key = 'solo_trial';",
        "    PERFORM public.admin_set_solo_trial_setting(false, 14);")], ['S7_rollback_clean']),
    'rb_check_restored_before_row_removed': ('rb', [
        ("DELETE FROM public.billing_settings WHERE key = 'solo_trial';\n", ""),
        ("  CHECK (key IN ('brokerage_billing_live'));\n",
         "  CHECK (key IN ('brokerage_billing_live'));\nDELETE FROM public.billing_settings WHERE key = 'solo_trial';\n")],
        ['S7_rollback_clean']),
    'rb_flag_ignored': ('rb', [(
        "    IF coalesce(current_setting('keepr.rollback_3860_remove_trial_overrides', true), '') = 'yes' THEN",
        "    IF false THEN")], ['S9_rollback_flag_removes']),
}


def strip_tx(text):
    return '\n'.join(l for l in text.split('\n') if not re.match(r'^\s*(begin|commit);\s*$', l, re.I))


def kt(sql):
    with tempfile.NamedTemporaryFile('w', suffix='.sql', delete=False) as f:
        f.write(sql)
        p = f.name
    try:
        out = subprocess.run([KT, p], capture_output=True, text=True, timeout=320)
    finally:
        os.unlink(p)
    t = out.stdout
    try:
        return json.loads(t.split('\nkt-sql:')[0])['message']
    except Exception:
        return t + out.stderr


def mutate(text, edits):
    for a, b in edits:
        n = text.count(a)
        if n != 1:
            raise ValueError('MUTATION NOT APPLIED: %d matches for %r' % (n, a[:60]))
        text = text.replace(a, b)
    return text


def run_controls(modes, mig_text):
    ctl = open(CTL).read()
    assert ctl.count('ARRAY[__MODES__]') == 1
    ctl = ctl.replace('ARRAY[__MODES__]', 'ARRAY[' + ','.join("'%s'" % m for m in modes) + ']')
    msg = kt(strip_tx(mig_text) + '\n' + ctl)
    m = re.search(r'P3860_RESULT (\{.*\})', msg, re.S)
    if not m:
        return {'_error': msg[:600]}
    d, _ = json.JSONDecoder().raw_decode(m.group(1))
    return d


def run_scenario(name, mig_text, rb_text):
    pieces, rx = SCENARIOS[name]
    sql = '\n'.join(strip_tx(mig_text) if p == 'MIG' else strip_tx(rb_text) if p == 'RB' else p for p in pieces)
    msg = kt(sql)
    first = msg.strip().split('\n')[0][:200]
    return (re.search(rx, msg) is not None), first


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'controls'
    frag = sys.argv[2] if len(sys.argv) > 2 else ''
    mig, rb = open(MIG).read(), open(RB).read()
    ok = True
    if mode in ('controls', 'mutants'):
        d = run_controls(['base'], mig)
        b = d.get('base')
        print('base controls:', json.dumps(b if b is not None else d, indent=1))
        if not isinstance(b, dict) or b['fail'] != 0 or b['pass'] == 0:
            print('BASELINE NOT GREEN'); sys.exit(1)
    if mode in ('scenarios', 'mutants'):
        for s in SCENARIOS:
            good, first = run_scenario(s, mig, rb)
            print('SCENARIO', 'PASS' if good else 'FAIL', s, '|', first)
            ok = ok and good
        if not ok:
            print('SCENARIOS NOT GREEN'); sys.exit(1)
    if mode == 'mutants':
        killed = survived = invalid = 0
        fn = [m for m in FN_MODES if frag in m]
        for i in range(0, len(fn), 6):
            d = run_controls(fn[i:i + 6], mig)
            for m in fn[i:i + 6]:
                v = d.get(m, d.get('_error', 'no result'))
                if isinstance(v, dict) and str(v.get('mutation', '')).startswith('MUTATION APPLIED'):
                    verdict = 'KILLED' if v['fail'] > 0 else 'SURVIVED'
                    print('%s|%s|%s|reds=%s' % (verdict, m, v['mutation'], v['reds']))
                else:
                    verdict = 'INVALID'
                    print('INVALID|%s|%s' % (m, str(v)[:300]))
                killed += verdict == 'KILLED'; survived += verdict == 'SURVIVED'; invalid += verdict == 'INVALID'
        for name, (which, edits, targets) in TEXT_MUTANTS.items():
            if frag not in name:
                continue
            try:
                mm = mutate(mig, edits) if which == 'mig' else mig
                rr = mutate(rb, edits) if which == 'rb' else rb
            except ValueError as e:
                print('INVALID|%s|%s' % (name, e)); invalid += 1; continue
            if (mm, rr) == (mig, rb):
                print('INVALID|%s|changed nothing' % name); invalid += 1; continue
            print('== %s MUTATION APPLIED (%s): %s' % (name, which, ' / '.join(repr(b[:70]) for _, b in edits)))
            red = []
            for t in targets:
                if t == 'controls':
                    d = run_controls(['base'], mm)
                    b = d.get('base')
                    if not isinstance(b, dict) or b['fail'] > 0:
                        red.append('controls:' + (json.dumps(b['reds']) if isinstance(b, dict) else str(b or d)[:200]))
                else:
                    good, first = run_scenario(t, mm, rr)
                    if not good:
                        red.append('%s: %s' % (t, first))
            verdict = 'KILLED' if red else 'SURVIVED'
            print('%s|%s|%s' % (verdict, name, ' ; '.join(red)[:400]))
            killed += verdict == 'KILLED'; survived += verdict == 'SURVIVED'
        print('MUTANTS: killed=%d survived=%d invalid=%d' % (killed, survived, invalid))
        ok = survived == 0 and invalid == 0 and killed > 0
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
