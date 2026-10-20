/**
 * BACKLOG-4007 PR-4: every refusal _org_billing_login_create can return has its own sentence in
 * both places that show it (the setup guide note and the People panel). Reads the migration, so
 * a new refusal code without words fails here.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { orgPeopleErrorMessage } from '@keepr/ui';
import { billingLoginErrorMessage } from '@/lib/billing/billingLoginErrors';

const MIGRATION = readFileSync(
  join(__dirname, '..', '..', '..', 'supabase', 'migrations', '20261020180000_backlog_4007_pr4_contacts_billing_login.sql'),
  'utf8'
);

function loginCreateCodes(): string[] {
  const start = MIGRATION.indexOf('CREATE OR REPLACE FUNCTION public._org_billing_login_create(');
  const end = MIGRATION.indexOf('$function$;', start);
  const body = MIGRATION.slice(start, end);
  return [...body.matchAll(/'success', false, 'error', '([a-z_]+)'/g)].map((m) => m[1]);
}

describe('billing-only login refusals are worded', () => {
  const codes = loginCreateCodes();

  it('the migration returns the refusals this test expects to read', () => {
    expect(codes).toEqual(expect.arrayContaining(['has_personal_account', 'already_member', 'duplicate_invitation']));
  });

  it.each(codes)('%s has its own sentence in the setup guide and the People panel', (code) => {
    expect(billingLoginErrorMessage(code)).not.toBe(billingLoginErrorMessage('__none__'));
    expect(orgPeopleErrorMessage(code)).not.toBe(orgPeopleErrorMessage('__none__'));
  });

  it('F6: the founder sentence, exactly, in both', () => {
    const t = 'This person already has their own Keepr account. Pick another billing contact or invite them as a member.';
    expect(billingLoginErrorMessage('has_personal_account')).toBe(t);
    expect(orgPeopleErrorMessage('has_personal_account')).toBe(t);
  });
});
