#!/usr/bin/env python3
"""BACKLOG-3991 jest mutation runner. Each mutant: exact-once replace (raises on 0 or 2+),
MUTATION APPLIED + the mutated line, git diff --numstat, jest run with a non-zero test
count, then the file is restored byte-for-byte and the restore is verified."""
import json, subprocess, sys, re
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
BP = ROOT / 'broker-portal'
SUITES = ['__tests__/member-name-3991', '__tests__/invite-without-license-3851/callback.test.ts']
AUDIT = ['__tests__/agentFloor-3080/route-audit.test.tsx']

M = [
 ('J1', 'C24', 'lib/auth/idpNames.ts', [("p_first: str(claims.given_name), p_last: str(claims.family_name)", "p_first: str(m.given_name), p_last: str(m.family_name)")], 'azure reads given_name at the top level (v1 mapping)', SUITES),
 ('J2', 'C25', 'app/auth/callback/route.ts', [("      await syncIdpNames(supabase, user, exchanged?.session?.provider_token ?? null);\n", ""),
                                             ("        // User has valid role - redirect to dashboard\n", "        await syncIdpNames(supabase, user, exchanged?.session?.provider_token ?? null);\n        // User has valid role - redirect to dashboard\n")], 'sync call moved inside the full-portal branch', SUITES),
 ('J3', 'SR-4', 'app/auth/callback/route.ts', [("await syncIdpNames(supabase, user,", "await syncIdpNames(createServiceClient(), user,"),
                                              ("import { syncIdpNames } from '@/lib/auth/idpNames';\n", "import { syncIdpNames } from '@/lib/auth/idpNames';\nimport { createServiceClient } from '@/lib/supabase/service';\n")], 'sync called on the service client', SUITES),
 ('J4', 'SR-4', 'lib/auth/idpNames.ts', [("    if (reply?.success !== true) {\n      console.error(", "    if (false) {\n      console.error(")], 'a success:false reply is not logged', SUITES),
 ('J5', 'C26', 'lib/auth/idpNames.ts', [("    console.error('sync_profile_names_from_idp failed: exception');", "    throw new Error('rethrown');")], 'a thrown error is rethrown', SUITES),
 ('J7', 'C27', 'lib/auth/idpNames.ts', [("  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? GOOGLE_USERINFO_TIMEOUT_MS);", "  const timer = undefined as unknown as ReturnType<typeof setTimeout>;")], 'no timeout', SUITES),
 ('J8', 'C27', 'lib/auth/idpNames.ts', [("      signal: controller.signal,\n", "")], 'signal not passed to fetch', SUITES),
 ('J9', 'C27', 'lib/auth/idpNames.ts', [("console.error(`google userinfo unavailable: ${controller.signal.aborted ? 'timeout' : 'error'}`);", "console.error(`google userinfo unavailable: ${providerToken}`);")], 'the token logged in the catch', SUITES),
 ('J9b', 'C27', 'lib/auth/idpNames.ts', [("    return { given_name: str(b.given_name), family_name: str(b.family_name) };", "    return { given_name: str(b.given_name) ?? '', family_name: str(b.family_name) ?? '' };")], "failure-ish: '' instead of null (SQL skips it; C21 pins that)", SUITES),
 ('J10', 'C28', 'lib/auth/idpNames.ts', [("provider === 'google' && providerToken ? await fetchGoogleNames", "providerToken ? await fetchGoogleNames")], 'fetch for every provider', SUITES),
 ('J11', 'C29', 'app/auth/desktop/callback/page.tsx', [("      await syncDesktopIdpNames(session.access_token, session.provider_token ?? null).catch(() => undefined);\n", ""),
                                                     ("      const minted = await mintDesktopSession(session.access_token);\n", "      const minted = await mintDesktopSession(session.access_token);\n      await syncDesktopIdpNames(session.access_token, session.provider_token ?? null).catch(() => undefined);\n")], 'sync placed after the mint', SUITES),
 ('J12', 'C29', 'app/auth/desktop/callback/page.tsx', [("session.provider_token ?? null).catch(() => undefined);", "session.provider_token ?? null);")], 'an awaited throw (catch removed)', SUITES),
 ('J13', 'C30', 'app/auth/callback/route.ts', [("              oauth_id: oauthId,\n            },", "              oauth_id: oauthId,\n              display_name: (user.user_metadata?.full_name as string | undefined) ?? null,\n            },")], 'accept upsert writes a name again', SUITES),
 ('J14', 'C18', 'lib/users/memberName.ts', [("  if (!input.namesEditable || input.isCurrentUser) return false;", "  if (input.isCurrentUser) return false;")], 'button shown without namesEditable', SUITES),
 ('J15', 'C18', 'lib/users/memberName.ts', [("  return !memberStatusIsDeactivated(input.licenseStatus);", "  return true;")], 'button shown for a deactivated target', SUITES),
 ('J15b', 'C18', 'lib/users/memberName.ts', [("  if (input.callerRole === 'admin' && input.targetRole === 'it_admin') return false;\n", "")], 'admin sees the button on an it_admin', SUITES),
 ('J16', 'C16', 'lib/actions/memberName.ts', [("  if (inputError) return { success: false, error: inputError };\n", "")], 'input check removed before the call', SUITES),
 ('J16b', 'C16', 'lib/actions/memberName.ts', [("    case 'directory_managed':\n      return { success: false, error: MEMBER_NAME_ERRORS.directoryManaged };\n", "")], 'directory_managed not mapped', SUITES),
 ('J17', 'C17', '__tests__/agentFloor-3080/route-audit.test.tsx', [("  'lib/actions/memberName.ts#setMemberName': failed('Not authorized'),\n", "")], 'route-audit refusal for setMemberName removed', AUDIT),
 ('J19', 'desktop', 'lib/actions/syncDesktopIdpNames.ts', [("      global: { headers: { Authorization: `Bearer ${accessToken}` } },\n", "")], 'name write without the user token (anon client)', SUITES),
]

def jest(suites):
    out = BP / '.jest-3991.json'
    subprocess.run(['npx', 'jest', *suites, '--json', f'--outputFile={out}', '--silent', '--bail=0'], cwd=BP, capture_output=True, text=True)
    d = json.loads(out.read_text()); out.unlink()
    failed = [f"{Path(t['name']).name}::{a['fullName']}" for t in d['testResults'] for a in t['assertionResults'] if a['status'] == 'failed']
    suite_errs = [Path(t['name']).name + '::<suite failed: ' + t['message'][:120].replace('\n', ' ') + '>' for t in d['testResults'] if t['status'] == 'failed' and not any(a['status'] == 'failed' for a in t['assertionResults'])]
    return d['numTotalTests'], d['numFailedTests'], failed + suite_errs

only = set(sys.argv[1:])
base_total, base_failed, _ = jest(SUITES)
assert base_total > 0 and base_failed == 0, (base_total, base_failed)
print(f'BASE {base_total} tests, {base_failed} failed')
rows = []
for mid, ctl, rel, pairs, what, suites in M:
    if only and mid not in only: continue
    p = BP / rel; orig = p.read_text(); s = orig
    for a, r in pairs:
        n = s.count(a)
        if n != 1: raise SystemExit(f'{mid}: anchor occurs {n} times in {rel}')
        s = s.replace(a, r)
    p.write_text(s)
    ns = subprocess.run(['git', 'diff', '--numstat', '--', str(p)], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    line = next((l for l in s.split('\n') if pairs[0][1] and pairs[0][1].split('\n')[0].strip() and pairs[0][1].split('\n')[0].strip() in l), '<removal>')
    print(f'MUTATION APPLIED {mid} ({ctl}) {rel} numstat[{ns}] line: {line.strip()[:110]}')
    try:
        total, nfail, names = jest(suites)
    finally:
        p.write_text(orig)
    assert p.read_text() == orig
    assert subprocess.run(['git', 'diff', '--quiet', '--', str(p)], cwd=ROOT).returncode == 0, f'{mid}: restore left a diff'
    print(f'  -> {total} tests, {nfail} red: ' + ('; '.join(names[:6]) + (' ...' if len(names) > 6 else '') if names else 'NONE'))
    rows.append((mid, ctl, what, total, nfail, names))
print('\nSUMMARY')
for mid, ctl, what, total, nfail, names in rows:
    print(f'{mid}|{ctl}|{what}|{nfail}/{total} red')
