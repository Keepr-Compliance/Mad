"""BACKLOG-3962 PR1: portal mutation controls. Each mutation is an exact, once-only replacement
(prints MUTATION APPLIED and git diff --numstat, else MUTATION NOT APPLIED), the domain-claims-3962
jest suites run with --bail=0, the file is restored and the tree checked clean.
Run from a committed tree: python3 supabase/tests/backlog-3962/ts_mutations.py [name ...]
"""
import json, os, re, subprocess, sys, tempfile

W = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
BP = W + '/broker-portal'
T = '__tests__/domain-claims-3962'
OUT = os.path.join(tempfile.mkdtemp(), 'jest-3962.json')
M = [
  ('TM1_R2_begin_refusal_ignored', 'broker-portal/lib/actions/domainClaim.ts',
   "  if (started.success !== true || typeof started.domain !== 'string') {\n",
   "  if (false) {\n"),
  ('TM2_b_role_gate_dropped', 'broker-portal/lib/domain/access.ts',
   "  if (access.kind !== 'full' || !seesOrgPolicy(access.role)) return { ok: false };\n",
   "  if (access.kind !== 'full') return { ok: false };\n"),
  ('TM2b_b_both_role_checks_dropped', 'broker-portal/lib/domain/access.ts',
   "  if (access.kind !== 'full' || !seesOrgPolicy(access.role)) return { ok: false };\n"
   "  if (portal.suspended === true || portal.orgSuspended === true) return { ok: false };\n\n"
   "  const organizationId = access.organizationId;\n"
   "  const membership = await requireActiveOrgRole(supabase, user.id, organizationId, ORG_SETTINGS_ROLES);\n",
   "  if (access.kind !== 'full') return { ok: false };\n"
   "  if (portal.suspended === true || portal.orgSuspended === true) return { ok: false };\n\n"
   "  const organizationId = access.organizationId;\n"
   "  const membership = await requireActiveOrgRole(supabase, user.id, organizationId, ['admin', 'it_admin', 'agent', 'broker']);\n"),
  ('TM3_b_row_recheck_dropped', 'broker-portal/lib/domain/access.ts',
   "  if (!membership.ok) return { ok: false };\n",
   "  void membership;\n"),
  ('TM4_C1_apex_name', 'broker-portal/lib/domain/doh.ts',
   "  return `_keepr.${domain}`;\n",
   "  return domain;\n"),
  ('TM5_R3_google_quote_parse', 'broker-portal/lib/domain/doh.ts',
   "    values.push(a.data);\n",
   "    const j = joinQuotedTxt(a.data);\n    if (j !== null) values.push(j);\n"),
  ('TM6_R3_nodata_is_error', 'broker-portal/lib/domain/doh.ts',
   "  if (body.Status === 3 || body.Answer === undefined) return { ok: true, answers: [] };\n",
   "  if (body.Status === 3) return { ok: true, answers: [] };\n  if (body.Answer === undefined) return { ok: false, answers: [] };\n"),
  ('TM7_R4_cache_dropped', 'broker-portal/lib/domain/doh.ts',
   "    cache: 'no-store',\n", ""),
  ('TM8_R3_cname_not_filtered', 'broker-portal/lib/domain/doh.ts',
   "    if (a.type !== TXT_TYPE || typeof a.data !== 'string') continue;\n    values.push(a.data);\n",
   "    if (typeof a.data !== 'string') continue;\n    values.push(a.data);\n"),
  ('TM9_C5_parity_comcast', 'supabase/migrations/20261112100000_backlog_3962_domain_claims.sql',
   "'fastmail.com', 'comcast.net', ", "'fastmail.com', "),
  ('TM10_R10_alabel_hidden', 'broker-portal/app/dashboard/settings/domain/DomainSettingsClient.tsx',
   ' <span className="text-sm font-normal text-gray-500">({claim.domain})</span>', ''),
  ('TM11_C7_refused_chars', 'broker-portal/lib/domain/normalize.ts',
   "const REFUSED_CHARACTERS = /[\\s/:@?#\\\\]/;\n", "const REFUSED_CHARACTERS = /[\\s]/;\n"),
  ('TM12_C7_no_idn', 'broker-portal/lib/domain/normalize.ts',
   "  const ascii = domainToASCII(value);\n", "  const ascii = value.toLowerCase();\n"),
  ('TM13_C8_too_soon_ignored', 'broker-portal/lib/actions/domainClaim.ts',
   "    if (started.error === 'too_soon') return fail(DOMAIN_CLAIM_TOO_SOON);\n    return fail(DOMAIN_CLAIM_NOT_FOUND);\n",
   "    if (started.error !== 'too_soon') return fail(DOMAIN_CLAIM_NOT_FOUND);\n"),
]

def run():
    p = subprocess.run(['npx', 'jest', T, '--bail=0', '--json', '--outputFile=' + OUT], cwd=BP, capture_output=True, text=True)
    if not os.path.exists(OUT):
        print('NO JSON', p.returncode, p.stderr[-1500:]); raise SystemExit(3)
    j = json.load(open(OUT))
    os.remove(OUT)
    reds = [a['fullName'] for s in j['testResults'] for a in s['assertionResults'] if a['status'] == 'failed']
    return j['numTotalTests'], j['numPassedTests'], j['numFailedTests'], j['numRuntimeErrorTestSuites'], reds

only = sys.argv[1:]
for name, f, old, new in M:
    if only and name not in only: continue
    path = os.path.join(W, f)
    src = open(path).read()
    n = src.count(old)
    if n != 1:
        print(f'{name}: MUTATION NOT APPLIED (pattern found {n} times)'); continue
    open(path, 'w').write(src.replace(old, new))
    ns = subprocess.run(['git', '-C', W, 'diff', '--numstat'], capture_output=True, text=True).stdout.strip()
    print(f'MUTATION APPLIED {name}: {new.strip()[:90]!r}  numstat: {ns}')
    try:
        tot, ok, bad, broken, reds = run()
    finally:
        open(path, 'w').write(src)
    assert subprocess.run(['git', '-C', W, 'diff', '--quiet']).returncode == 0, 'restore failed'
    print(f'  => total {tot} passed {ok} failed {bad} suites-errored {broken}  {"RED" if bad or broken else "GREEN"}')
    for r in reds[:4]: print('     red:', r[:110])
tot, ok, bad, broken, _ = run()
print(f'RESTORED BASELINE: total {tot} passed {ok} failed {bad}')
