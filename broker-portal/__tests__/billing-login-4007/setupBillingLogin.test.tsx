/**
 * BACKLOG-4007 PR-4: the billing-only login from the setup guide's Billing step.
 *  - the action sends p_billing_login only for "Someone else" with the box ticked;
 *  - a created login (the RPC's billing_login, shape transcribed from keepr-test
 *    supabase/tests/backlog-4007-pr4: {success, token, email, name, org_name}) is emailed through
 *    the invite template with the billing-only line; a refusal ({success:false, error}) is reported
 *    and setup still counts as complete;
 *  - the checkbox shows for "Someone else" only;
 *  - the Done step words each outcome;
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
  name: 'Payer Person',
  email: 'payer@example.test',
  token: 'a'.repeat(64),
  success: true,
  org_name: 'Fixture Realty',
};

function input(over: Partial<CompleteBillingSetupInput> = {}): CompleteBillingSetupInput {
  return {
    organizationId: 'ORG-1',
    expectedVersion: 1,
    acceptTerms: true,
    contact: { who: 'other', name: 'Payer Person', email: 'payer@example.test', phone: '202-555-0123' },
    company: { legal_name: 'Realty LLC', address_line1: '1 Main St', city: 'Seattle', region: 'WA', postal_code: '98101', country: 'US' },
    billingLogin: true,
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
  it('"Someone else" + box: asks for the login, emails the invitation, reports sent', async () => {
    completion(CREATED);
    const r = await completeBillingSetup(input());
    expect(mockRpc.mock.calls[1][1]).toMatchObject({ p_billing_login: true });
    expect(r).toEqual({ success: true, billingStartsOn: '2026-10-30', billingLogin: 'sent' });
    expect(mockSendInvite).toHaveBeenCalledTimes(1);
    expect(mockSendInvite.mock.calls[0][0]).toMatchObject({
      recipientEmail: 'payer@example.test',
      organizationName: 'Fixture Realty',
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

  it('a refusal (open invitation elsewhere): setup complete, code reported, no email', async () => {
    completion({ success: false, error: 'duplicate_invitation' });
    expect(await completeBillingSetup(input())).toEqual({ success: true, billingStartsOn: '2026-10-30', billingLogin: 'duplicate_invitation' });
    expect(mockSendInvite).not.toHaveBeenCalled();
  });

  it('"Me", or the box unticked: the login is never asked for', async () => {
    completion(null);
    await completeBillingSetup(input({ contact: { who: 'me', phone: '202-555-0123' } }));
    expect(mockRpc.mock.calls[1][1]).toMatchObject({ p_billing_login: false });
    mockRpc.mockClear();
    completion(null);
    const r = await completeBillingSetup(input({ billingLogin: false }));
    expect(mockRpc.mock.calls[1][1]).toMatchObject({ p_billing_login: false });
    expect(r).toEqual({ success: true, billingStartsOn: '2026-10-30' });
    expect(mockSendInvite).not.toHaveBeenCalled();
  });
});

describe('BillingStep checkbox', () => {
  it('shows only for "Someone else"', () => {
    render(<BillingStep organizationId="ORG-1" view={SETUP_VIEW_WAITING} />);
    expect(screen.queryByLabelText('Give them a billing-only login')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Someone else'));
    expect(screen.getByLabelText('Give them a billing-only login')).not.toBeChecked();
    expect(screen.getByText(/It does not use a seat\./)).toBeInTheDocument();
  });
});

describe('Done step note', () => {
  it.each([
    ['sent', 'info', /emailed the billing contact an invitation/],
    ['created', 'warning', /did not send/],
    ['duplicate_invitation', 'warning', /already has an open invitation.*was not created/],
    ['something-else', 'warning', /could not be created.*was not created/],
  ])('%s', (outcome, tone, text) => {
    const n = billingLoginNote(outcome);
    expect(n?.tone).toBe(tone);
    expect(n?.text).toMatch(text);
  });
  it('nothing when there was no login', () => {
    expect(billingLoginNote(null)).toBeNull();
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
  const base = { recipientEmail: 'payer@example.test', organizationName: 'Fixture Realty', inviterName: 'Broker', role: 'Billing only', inviteLink: 'https://app.example.test/invite/x', expiresInDays: 7 };
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
