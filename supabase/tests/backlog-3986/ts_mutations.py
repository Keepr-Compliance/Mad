#!/usr/bin/env python3
"""BACKLOG-3986 TS controls: each mutant is an exact, once-only replacement; the file is restored
from the text read before mutating (never git checkout). A run with 0 tests is a failure.
Run from the repo root: python3 supabase/tests/backlog-3986/ts_mutations.py"""
import re, subprocess, sys

SCIM = 'supabase/functions/scim/handlers/users.ts'
TEST = 'tests/edge-functions/scimSeats.test.ts'

HOIST = '''  {
    const { data: hoisted } = await supabaseAdmin
      .from("domain_claims")
      .select("id")
      .eq("organization_id", auth.orgId)
      .eq("status", "verified")
      .eq("domain", emailDomainOf(scimAccountEmail(body) ?? email) ?? "")
      .maybeSingle();
    if (!hoisted) return scimError(403, DOMAIN_NOT_VERIFIED_DETAIL);
  }
  if (existingByEmail) {
    // Check if this user is already a member'''

CASES = [
    # (name, the wrong implementation it stands for, old, new, controls expected to red)
    ('M1_no_domain_check', 'no domain check',
     '  if (!claimed) {\n', '  if (false) {\n', 'C2 C3 C4 C5 C15(b)'),
    ('M2_domain_on_userName', 'domain checked on userName, account created on the emails[] address',
     '  const accountDomain = emailDomainOf(accountEmail);\n', '  const accountDomain = emailDomainOf(email);\n', 'C15(a) C15(b)'),
    ('M3_account_on_userName', 'account created with userName instead of emails[]',
     '    email: accountEmail,\n    email_confirm: true,\n', '    email: email,\n    email_confirm: true,\n', 'C1 C15(a)'),
    ('M4_email_unconfirmed', 'email_confirm false',
     '    email_confirm: true,\n', '    email_confirm: false,\n', 'C1'),
    ('M5_no_deleteUser', 'orphaned auth user (cleanup never removes the account)',
     '    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(newUserId);\n',
     '    const deleteError = null as { message: string } | null;\n', 'C6 C7 C8 C9'),
    ('M6_row_removed_when_delete_fails', 'users row removed although the account stays (R1)',
     '      console.error(`[scim] orphan auth user ${newUserId}: could not remove it:`, deleteError.message);\n      return;\n',
     '      console.error(`[scim] orphan auth user ${newUserId}: could not remove it:`, deleteError.message);\n', 'C11'),
    ('M7_users_row_not_removed', 'cleanup removes the account but leaves the users row',
     '      .delete()\n      .eq("id", newUserId);\n', '      .delete()\n      .eq("id", "not-this-row");\n', 'C6 C7 C8 C9'),
    ('M8_domain_check_hoisted', 'domain rule applied to existing people too',
     '  if (existingByEmail) {\n    // Check if this user is already a member', HOIST, 'C12 (+ existing-person tests)'),
    ('M9_email_exists_generic', 'email_exists not told apart',
     '      errorMessage: isEmailExistsError(authCreateError)\n', '      errorMessage: false\n', 'C10'),
    ('M10_no_already_placed_mapping', 'guard refusal in the new-person branch read as a 500',
     '    await removeNewPerson();\n    if (isAlreadyPlacedError(newMemberError)) {\n',
     '    await removeNewPerson();\n    if (false) {\n', 'C8'),
    ('M11_externalId_error_ignored', 'BACKLOG-4138: failed externalId read read as no such person',
     '    if (extIdError) {\n', '    if (false) {\n', 'C14'),
    ('M12_cleanup_only_on_seat', 'cleanup only in the seat branch',
     '  if (newMemberError) {\n    await removeNewPerson();\n',
     '  if (newMemberError) {\n    if (isSeatLimitError(newMemberError)) await removeNewPerson();\n', 'C7 C8'),
    ('M13_no_cleanup_after_users_update', 'no cleanup when the users update fails',
     '[scim] could not remove membership of ${newUserId}:`, memberRemoveError.message);\n    }\n    await removeNewPerson();\n',
     '[scim] could not remove membership of ${newUserId}:`, memberRemoveError.message);\n    }\n', 'C9'),
    ('M14_status_filter_dropped', 'any claim status counts',
     '      .eq("status", "verified")\n      .eq("domain", accountDomain)\n', '      .eq("domain", accountDomain)\n', 'C3'),
    ('M15_org_filter_dropped', "another brokerage's claim counts",
     '      .eq("organization_id", auth.orgId)\n      .eq("status", "verified")\n      .eq("domain", accountDomain)\n',
     '      .eq("status", "verified")\n      .eq("domain", accountDomain)\n', 'C4'),
    ('M16_parent_domain_match', 'subdomain matched to its parent domain',
     '  const accountDomain = emailDomainOf(accountEmail);\n',
     '  const accountDomain = emailDomainOf(accountEmail)?.split(".").slice(-2).join(".") ?? null;\n', 'C5'),
    ('M17_claim_read_error_ignored', 'failed domain read read as no claim / claim',
     '    if (claimError) {\n', '    if (false) {\n', 'C16'),
    ('M18_no_explicit_membership_removal', 'users update fails and the account stays: its membership is left behind (retry 409)',
     '    const { error: memberRemoveError } = await supabaseAdmin\n      .from("organization_members")\n      .delete()\n      .eq("organization_id", auth.orgId)\n      .eq("user_id", newUserId);\n',
     '    const memberRemoveError = null as { message: string } | null;\n', 'C9 C9b'),
]


def jest():
    r = subprocess.run(['npx', 'jest', TEST, '--bail=0'], capture_output=True, text=True)
    out = r.stdout + r.stderr
    m = re.search(r'Tests:\s+(.*)', out)
    line = m.group(1).strip() if m else 'NO TESTS LINE'
    total = re.search(r'(\d+) total', line)
    if not total or int(total.group(1)) == 0:
        print(f'  ZERO OR NO TESTS: {line}'); sys.exit(3)
    red = sorted(set(re.findall(r'●\s+(.+?)\n', out)))
    return r.returncode, line, red


src = open(SCIM).read()
try:
    for name, wrong, old, new, expect in CASES:
        if src.count(old) != 1:
            print(f'{name}: MUTATION NOT APPLIED (pattern x{src.count(old)})'); sys.exit(2)
        mutated = src.replace(old, new)
        open(SCIM, 'w').write(mutated)
        added = [l for l in new.splitlines() if l.strip() and l not in old.splitlines()]
        removed = [l for l in old.splitlines() if l.strip() and l not in new.splitlines()]
        first = added[0] if added else f'REMOVED {removed[0].strip()}'
        assert mutated != src and (added or removed), name
        print(f'{name}: MUTATION APPLIED {SCIM}: {first.strip()}  [{wrong}]')
        code, line, red = jest()
        verdict = 'RED' if code != 0 and 'failed' in line else 'GREEN (control did not fire)'
        print(f'  exit={code} {line} -> {verdict}; expected red: {expect}')
        for t in red:
            print(f'    red: {t}')
        open(SCIM, 'w').write(src)
finally:
    open(SCIM, 'w').write(src)
code, line, red = jest()
print(f'restored scim suite: exit={code} {line}')
