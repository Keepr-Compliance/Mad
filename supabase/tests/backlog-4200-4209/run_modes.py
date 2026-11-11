#!/usr/bin/env python3
"""Run controls.sql on keepr-test in batches via kt-sql and print one line per mode.

Usage: run_modes.py [--with-migration] <out.txt>
"""
import json, os, re, subprocess, sys, tempfile
here = os.path.dirname(os.path.abspath(__file__))
MODES = [
    'base',
    'f1_no_enqueue', 'f2_staff_any', 'f3_any_caller', 'f4_before_early_return', 'f5_no_status_test',
    'f6_no_p_notify', 'f7_no_contact', 'f8_no_on_conflict', 'f9_log_wrapper_on_only', 'f10_result_wrapper_on_only',
    'c1_no_enqueue', 'c2_staff_any', 'c3_any_caller', 'c4_before_early_return', 'c5_no_status_test', 'c6_no_on_conflict',
    'n1_default_false', 'n1b_overload', 'n2_no_p_notify', 'n3_no_contact', 'n4_key_every_caller', 'n6_reader_no_key',
    'n7_audit_no_key', 'n8_grant_internal', 'n9_no_null_check',
    'r1_no_enqueue', 'a1_internal_default_false', 'a1b_gate_actor', 'a2_auto_double', 'a3_via_constant',
    'r3_no_p_notify', 'r4_no_contact', 'r5_key_version', 'r6_before_refusal', 'r8_no_null_check', 'r9_overload',
    'r10_no_on_conflict', 'r11_no_suspended_at',
]
flags = [a for a in sys.argv[1:] if a.startswith('--')]
out = [a for a in sys.argv[1:] if not a.startswith('--')][0]
res = {}
for i in range(0, len(MODES), 8):
    batch = MODES[i:i + 8]
    fd, path = tempfile.mkstemp(suffix='.sql')
    os.close(fd)
    subprocess.run([sys.executable, os.path.join(here, 'compose.py'), path, ','.join(batch)] + flags, check=True, capture_output=True)
    p = subprocess.run([os.path.expanduser('~/.claude/bin/kt-sql'), path], capture_output=True, text=True)
    os.unlink(path)
    m = re.search(r'P4200_4209_RESULT (\{.*\})\\nCONTEXT', p.stdout)
    if not m:
        raise SystemExit('no result: ' + p.stdout[:500] + p.stderr[:300])
    res.update(json.loads(m.group(1).encode().decode('unicode_escape')))
lines = []
for k in MODES:
    v = res[k]
    if isinstance(v, str):
        lines.append(f'{k}: {v}')
        continue
    lines.append(f"{k}: pass={v['pass']} fail={v['fail']} reds={v['reds']}")
    lines.append(f"   {v['mutation']}")
open(out, 'w').write('\n'.join(lines) + '\n')
print('\n'.join(lines))
