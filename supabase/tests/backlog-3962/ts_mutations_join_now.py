#!/usr/bin/env python3
"""BACKLOG-3962 "Join now" portal controls. Needs a committed tree (restores with git checkout --).
Each mutation is an exact, once-only replacement; prints MUTATION APPLIED + numstat, then runs the
domain-capture-3962 suites plus the two middleware suites and prints the counts and every red test.
Usage: python3 supabase/tests/backlog-3962/ts_mutations_join_now.py [name ...]"""
import os, re, subprocess, sys
ROOT = subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip()
BP = os.path.join(ROOT, 'broker-portal')
TESTS = ['__tests__/domain-capture-3962', '__tests__/plan-summary-3863/middleware.test.ts',
         '__tests__/middleware.personalOrg-3364.test.ts']
A = 'broker-portal/lib/actions/domainCapture.ts'
J = 'broker-portal/lib/domain/captureJoinNow.ts'
S = 'broker-portal/lib/domain/captureSwitch.ts'
B = 'broker-portal/components/CaptureNoticeBanner.tsx'
MW = 'broker-portal/middleware.ts'
M = {
  'T_join_posted_user': (A, "    result = await runCaptureJoinNow({ service: createServiceClient({ actorId: userId }) }, userId, switchId);\n",
      "    const posted = (input as unknown as { userId?: string }).userId ?? userId;\n    result = await runCaptureJoinNow({ service: createServiceClient({ actorId: userId }) }, posted, switchId);\n"),
  'T_join_no_confirm': (A, "  if (input?.confirm !== true) return fail(DOMAIN_CAPTURE_JOIN_CONFIRM);\n", ""),
  'T_join_no_impersonation_guard': (A,
      "  const blocked = await blockWriteDuringImpersonation();\n  if (blocked) return fail(blocked.error);\n  const switchId = input?.switchId;\n  if (typeof switchId !== 'string' || !UUID.test(switchId)) return fail(DOMAIN_CAPTURE_NOT_FOUND);\n  if (input?.confirm !== true) return fail(DOMAIN_CAPTURE_JOIN_CONFIRM);\n",
      "  const switchId = input?.switchId;\n  if (typeof switchId !== 'string' || !UUID.test(switchId)) return fail(DOMAIN_CAPTURE_NOT_FOUND);\n  if (input?.confirm !== true) return fail(DOMAIN_CAPTURE_JOIN_CONFIRM);\n"),
  'T_join_copy_dns_unmapped': ('broker-portal/lib/domain/captureMessages.ts',
      "    case 'dns_not_fresh':\n      return `Keepr couldn't confirm", "    case 'dns_not_fresh_x':\n      return `Keepr couldn't confirm"),
  'T_join_no_recheck': (J, "    await recheckClaimDns(service, { claim_id: sw.claim_id, organization_id: sw.organization_id, domain: c.domain }, deps.lookup);\n", ""),
  'T_join_no_owner_filter': (J, "    .eq('user_id', userId)\n", ""),
  'T_join_dns_never_fresh': (J, "  const fresh = c.last_check_result === 'verified' &&", "  const fresh = false && c.last_check_result === 'verified' &&"),
  'T_join_dns_always_fresh': (J, "  const fresh = c.last_check_result === 'verified' &&", "  const fresh = true || c.last_check_result === 'verified' &&"),
  'T_join_no_notify': (J, "  await notifySwitched(service, [{ switchId, userId, organizationId: sw.organization_id, reply: r }], deps);\n", ""),
  'T_seat_alert_dropped': (S, "      if (!licensed) {\n        out.unassigned += 1;\n", "      if (false) {\n        out.unassigned += 1;\n"),
  'T_payer_gets_switched_email': (S, "      if (r.payer !== true && email) {\n", "      if (email) {\n"),
  'T_recheck_records_nothing': (S, "    await service.rpc('_domain_claim_record_check', {\n", "    void ({\n"),
  'T_joined_early_not_passed': (S, "          joinedEarly: r.joined_early === true,\n", ""),
  'T_banner_join_no_modal': (B, "onClick={() => { setError(null); setJoinOpen(true); }}", "onClick={() => { void handleJoin(); }}"),
  'T_banner_join_link_acts': (B, "    if (focus === 'join') joinRef.current?.focus();\n",
      "    if (focus === 'join') { joinRef.current?.focus(); void joinNowSelf({ switchId: notice.switchId, confirm: true }); }\n"),
  'T_banner_notice_link_dropped': (B, "capture === 'keep' || capture === 'notice' ? 'keep'", "capture === 'keep' ? 'keep'"),
  'T_mw_path_only': (MW, "      loginUrl.searchParams.set('redirectTo', nextPath);\n", "      loginUrl.searchParams.set('redirectTo', pathname);\n"),
  'T_mw_no_fallback': (MW, "      const nextPath = isSafeNextPath(withQuery) ? withQuery : pathname;\n", "      const nextPath = withQuery;\n"),
  'T_email_keep_link_dropped': ('broker-portal/lib/email/templates/domain-capture-notice.ts', "      { label: 'Keep my personal account', url: keepUrl },\n", ""),
  'T_get_route_joins': ('broker-portal/app/api/cron/domain-capture-switch/route.ts',
      "import { runCaptureSwitch } from '@/lib/domain/captureSwitch';\n",
      "import { runCaptureSwitch } from '@/lib/domain/captureSwitch';\nimport { runCaptureJoinNow } from '@/lib/domain/captureJoinNow';\nvoid runCaptureJoinNow;\n"),
}
names = sys.argv[1:] or list(M)
if subprocess.run(['git', 'diff', '--quiet'], cwd=ROOT).returncode != 0:
    sys.exit('tree not clean: commit first')
for n in names:
    rel, old, new = M[n]
    p = os.path.join(ROOT, rel); s = open(p).read()
    if s.count(old) != 1:
        print(f'{n}: MUTATION NOT APPLIED (found {s.count(old)})'); continue
    open(p, 'w').write(s.replace(old, new))
    ns = subprocess.check_output(['git', 'diff', '--numstat', '--', rel], cwd=ROOT, text=True).strip()
    print(f'{n}: MUTATION APPLIED [{ns}] -> {(new.strip() or "(line removed)")[:90]}')
    out = subprocess.run(['npx', 'jest', *TESTS], cwd=BP, capture_output=True, text=True)
    txt = out.stderr + out.stdout
    t = re.search(r'Tests:\s+(.*)', txt)
    fails = list(dict.fromkeys(re.findall(r'^\s*● (.+?)\s*$', txt, re.M)))
    fails = [f for f in fails if not f.startswith('Console')]
    print(f'  {t.group(1) if t else "NO TEST COUNT"} | red ({len(fails)}):')
    for f in fails:
        print(f'    - {f}')
    if t is None or ' 0 total' in t.group(1):
        print('  WARNING: no test count / zero tests')
    subprocess.run(['git', 'checkout', '--', rel], cwd=ROOT, check=True)
