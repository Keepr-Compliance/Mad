/**
 * BACKLOG-4007 PR-4 / People v2: every refusal the billing-only login can get
 * (_org_billing_login_refusal) has its own sentence in both places that show it: the setup
 * guide's Billing step (billingSetupErrorMessage, setup stops) and the People panel
 * (orgPeopleErrorMessage, "Invite new person"). Every code org_people_invite returns has People
 * words too. Reads the migration, so a new refusal code without words fails here.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { orgPeopleErrorMessage } from '@keepr/ui';
import { billingSetupErrorMessage } from '@/lib/billing/setupCopy';

const MIGRATION = readFileSync(
  join(__dirname, '..', '..', '..', 'supabase', 'migrations', '20261020200000_backlog_4007_people_v2.sql'),
  'utf8'
);

function body(fn: string): string {
  const start = MIGRATION.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  return MIGRATION.slice(start, MIGRATION.indexOf('$function$;', start));
}

const refusalCodes = [...body('_org_billing_login_refusal').matchAll(/RETURN '([a-z_]+)'/g)].map((m) => m[1]);
const inviteCodes = [...body('org_people_invite').matchAll(/'success', false, 'error', '([a-z_]+)'/g)].map((m) => m[1]);

describe('billing-only login refusals are worded', () => {
  it('the migration returns the refusals this test expects to read', () => {
    expect(refusalCodes.sort()).toEqual(['already_member', 'duplicate_invitation', 'has_personal_account', 'user_in_other_brokerage']);
    expect(inviteCodes).toEqual(expect.arrayContaining(['seat_limit_reached', 'billing_set_in_setup', 'it_contact_exists']));
  });

  it.each(refusalCodes)('%s has its own sentence in the setup guide and the People panel', (code) => {
    expect(billingSetupErrorMessage(code)).not.toBe(billingSetupErrorMessage('__none__'));
    expect(orgPeopleErrorMessage(code)).not.toBe(orgPeopleErrorMessage('__none__'));
  });

  it.each([...new Set(inviteCodes)])('org_people_invite %s has People words', (code) => {
    expect(orgPeopleErrorMessage(code)).not.toBe(orgPeopleErrorMessage('__none__'));
  });

  it('F6: the founder sentence, exactly, in both', () => {
    const t = 'This person already has their own Keepr account. Pick another billing contact or invite them as a member.';
    expect(billingSetupErrorMessage('has_personal_account')).toBe(t);
    expect(orgPeopleErrorMessage('has_personal_account')).toBe(t);
  });
});
