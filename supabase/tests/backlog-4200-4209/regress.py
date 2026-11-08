#!/usr/bin/env python3
"""Re-run an older keepr-test harness (one rolled-back kt-sql call per batch) and print pass/fail/reds.

Usage: regress.py <harness dir> <compose script> <controls file> <RESULT marker> [extra compose args...]
Modes = 'base' + every "WHEN '<mode>' THEN" line in the controls file's apply_mode.
"""
import json, os, re, subprocess, sys, tempfile
d, comp, ctl, marker = sys.argv[1:5]
extra = sys.argv[5:]
src = open(os.path.join(d, ctl)).read()
a = src.index('apply_mode(')
b = src.index('END $b$$f$;', a)
modes = ['base'] + [m for m in re.findall(r"^\s+WHEN '([a-z0-9_]+)' THEN", src[a:b], re.M) if m != 'base']
res = {}
for i in range(0, len(modes), 8):
    batch = modes[i:i + 8]
    fd, path = tempfile.mkstemp(suffix='.sql'); os.close(fd)
    subprocess.run([sys.executable, os.path.join(d, comp), path, ','.join(batch)] + extra, check=True, capture_output=True)
    p = subprocess.run([os.path.expanduser('~/.claude/bin/kt-sql'), path], capture_output=True, text=True)
    os.unlink(path)
    m = re.search(marker + r' (\{.*\})\\nCONTEXT', p.stdout)
    if not m:
        for k in batch:
            res[k] = 'NO RESULT ' + (p.stdout[:300] + p.stderr[:200]).replace('\n', ' ')
        continue
    res.update(json.loads(m.group(1).encode().decode('unicode_escape')))
for k in modes:
    v = res.get(k)
    if not isinstance(v, dict):
        print(f'{k}: {v}'); continue
    reds = v.get('reds')
    if isinstance(reds, dict):
        reds = sorted(reds.keys()) if k != 'base' else {kk: str(vv)[:140] for kk, vv in reds.items()}
    print(f"{k}: pass={v.get('pass')} fail={v.get('fail')} reds={reds}")
print('modes:', len(modes))
