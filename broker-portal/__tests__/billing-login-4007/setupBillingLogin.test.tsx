/**
 * BACKLOG-4007 PR-4 / People v2: the billing-only login from the setup guide's Billing step.
 *  - People v2: there is no checkbox. "Someone else" who is not a member always gets the
 *    billing-only login; p_billing_login is always false (ignored by the database);
 *  - a created login (the RPC's billing_login, shape from keepr-test control
 *    S1_setup_other_creates_login: {success, token, email, name, org_name}) is emailed through
 *    the invite template with the billing-only line;
 *  - a refusal stops setup (success false) with the founder's sentence (b7f3cefe);
 *  - the Done step words a created login's email outcome;
 *  - SR F3: an account with a Microsoft identity is offered "Connect Microsoft" even when its
 *    first provider was Google.
 */

import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';

const mockRpc = jest.fn();
const mockSendInvite = jest.fn();
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));
jest.mock('@/lib/impersonation-guards', () => ({ blockWriteDuringImpersonation: async () => null }));
jest.mock('@/lib/auth/memberAccess', () => ({ requireActiveOrgRole: async () => ({ ok: true, role: 'admin' }) }));
jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: mockRpc,
    auth: { getUser: async () => ({ data: { user: { id: 'u-1', email: 'broker@example.test' } } }) },
  }),
}));
jest.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({}) }));
jest.mock('@/lib/billing/outboxEnqueue', () => ({ enqueueOutbox: jest.fn() }));
jest.mock('@/lib/email', () => ({ sendInviteEmail: (...a: unknown[]) => mockSendInvite(...a) }));
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush, refresh: jest.fn() }) }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

import { completeBillingSetup, type CompleteBillingSetupInput } from '@/lib/actions/billingSetup';
import { BillingStep } from '@/components/setup/BillingStep';
import { billingLoginNote } from '@/components/setup/SetupGuide';
import { signInProviderOf, setupStepFor } from '@/lib/billing/setupSteps';
import { buildInviteEmail } from '@/lib/email/templates/invite';
import { BILLING_ONLY_INVITE_LINE, UNLICENSED_INVITE_LINE } from '@/lib/invite/validateResult';
import { SETUP_VIEW_WAITING } from '../billing-setup-4007/fixtures';

const CREATED = {
  name: 'payer team',
  email: 'payer@example.test',
  token: 'a'.repeat(64),
  success: true,
  org_name: 'fixture realty',
};

function input(over: Partial<CompleteBillingSetupInput> = {}): CompleteBillingSetupInput {
  return {
    organizationId: 'ORG-1',
    expectedVersion: 1,
    acceptTerms: true,
    contact: { who: 'other', name: 'payer team', email: 'payer@example.test', phone: '202-555-0123' },
    company: { legal_name: 'Realty LLC', address_line1: '1 Main St', city: 'Seattle', region: 'WA', postal_code: '98101', country: 'US' },
    ...over,
  };
}

function completion(billingLogin: unknown) {
  mockRpc.mockImplementation(async (fn: string) => ({
    data:
      fn === 'broker_accept_terms'
        ? { success: true }
        : { success: true, version: 2, billing_starts_on: '2026-10-30', billing_login: billingLogin },
    error: null,
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSendInvite.mockResolvedValue({ success: true, outcome: 'sent' });
});

describe('completeBillingSetup with the billing-only login', () => {
  it('"Someone else" not yet a member: the database creates the login; it is emailed and reported sent', async () => {
    completion(CREATED);
    const r = await completeBillingSetup(input());
    expect(mockRpc.mock.calls[1][1]).toMatchObject({ p_billing_login: false });
    expect(r).toEqual({ success: true, billingStartsOn: '2026-10-30', billingLogin: 'sent' });
    expect(mockSendInvite).toHaveBeenCalledTimes(1);
    expect(mockSendInvite.mock.calls[0][0]).toMatchObject({
      recipientEmail: 'payer@example.test',
      organizationName: 'fixture realty',
      role: 'Billing only',
      billingOnly: true,
      withoutLicense: true,
      inviteLink: expect.stringMatching(new RegExp(`/invite/${CREATED.token}$`)),
    });
  });

  it('email not sent: setup complete, login reported as created', async () => {
    completion(CREATED);
    mockSendInvite.mockResolvedValue({ success: false, outcome: 'failed' });
    expect((await completeBillingSetup(input())) as { billingLogin?: string }).toMatchObject({ success: true, billingLogin: 'created' });
  });

  it('a refusal stops setup with the founder sentence; no email', async () => {
    mockRpc.mockImplementation(async (fn: string) => ({
      data: fn === 'broker_accept_terms' ? { success: true } : { success: false, error: 'has_personal_account' },
      error: null,
    }));
    expect(await completeBillingSetup(input())).toMatchObject({
      success: false,
      code: 'has_personal_account',
      error: 'This person already has their own Keepr account. Pick another billing contact or invite them as a member.',
    });
    expect(mockSendInvite).not.toHaveBeenCalled();
  });

  it('"Me", or an existing member: no login is created and nothing is emailed', async () => {
    completion(null);
    const r = await completeBillingSetup(input({ contact: { who: 'me', phone: '202-555-0123' } }));
    expect(mockRpc.mock.calls[1][1]).toMatchObject({ p_billing_login: false });
    expect(r).toEqual({ success: true, billingStartsOn: '2026-10-30' });
    expect(mockSendInvite).not.toHaveBeenCalled();
  });
});

describe('BillingStep: no billing-only login checkbox', () => {
  it('"Someone else" says what they get; there is no box', () => {
    render(<BillingStep organizationId="ORG-1" view={SETUP_VIEW_WAITING} />);
    fireEvent.click(screen.getByLabelText('Someone else'));
    expect(screen.queryByLabelText('Give them a billing-only login')).not.toBeInTheDocument();
    expect(screen.getByText(/they get a billing-only login: Billing and Support only, no seat\./)).toBeInTheDocument();
  });
});

describe('Done step note', () => {
  it.each([
    ['sent', 'info', /emailed the billing contact an invitation/],
    ['created', 'warning', /did not send/],
  ])('%s', (outcome, tone, text) => {
    const n = billingLoginNote(outcome);
    expect(n?.tone).toBe(tone);
    expect(n?.text).toMatch(text);
  });
  it('nothing when there was no login, or for any other value (a refusal never reaches Done)', () => {
    expect(billingLoginNote(null)).toBeNull();
    expect(billingLoginNote('duplicate_invitation')).toBeNull();
  });
});

describe('SR F3: Microsoft step from any Microsoft identity', () => {
  it('Google-first account with a Microsoft identity reads azure and is offered Connect', () => {
    const user = { app_metadata: { provider: 'google', providers: ['google', 'azure'] }, identities: [{ provider: 'google' }, { provider: 'azure' }] };
    expect(signInProviderOf(user)).toBe('azure');
    expect(setupStepFor({ state: 'active', role: 'admin', hasMicrosoftTenant: false, signInProvider: signInProviderOf(user), requested: null })).toBe('microsoft');
  });
  it('Google only stays google; no metadata is null', () => {
    expect(signInProviderOf({ app_metadata: { provider: 'google', providers: ['google'] }, identities: [{ provider: 'google' }] })).toBe('google');
    expect(signInProviderOf({})).toBeNull();
  });
});

describe('invite email for the billing-only login', () => {
  const base = { recipientEmail: 'payer@example.test', organizationName: 'fixture realty', inviterName: 'Broker', role: 'Billing only', inviteLink: 'https://app.example.test/invite/x', expiresInDays: 7 };
  it('says what the login opens, not "until your admin assigns one"', () => {
    const e = buildInviteEmail({ ...base, withoutLicense: true, billingOnly: true });
    expect(e.text).toContain(BILLING_ONLY_INVITE_LINE);
    expect(e.text).not.toContain(UNLICENSED_INVITE_LINE);
    expect(e.text).toContain('Role: Billing only');
  });
  it('an ordinary unlicensed invite is unchanged', () => {
    const e = buildInviteEmail({ ...base, role: 'agent', withoutLicense: true });
    expect(e.text).toContain(UNLICENSED_INVITE_LINE);
    expect(e.text).not.toContain(BILLING_ONLY_INVITE_LINE);
  });
});
