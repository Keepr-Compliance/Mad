/**
 * @jest-environment node
 *
 * BACKLOG-4007 PR-3 (C-A1): the Billing step's server action.
 *  - terms acceptance and completion run in ONE request with the signed-in user's client, for
 *    the version the step showed (acceptance is caller-scoped: migration 20261020100000 :849-853);
 *  - only the documented contact/company keys travel; price and seats never do;
 *  - refused before any RPC: no Terms tick, impersonation, not a broker/admin;
 *  - version_conflict asks the page to reload.
 * RPC result shapes transcribed from supabase/tests/backlog-4007-pr3/results-2026-10-20.txt (E4) and
 * the migration's RETURN statements.
 */

const mockRpc = jest.fn();
const mockGetUser = jest.fn();
const mockGate = jest.fn();
const mockBlocked = jest.fn();
const mockEnqueue = jest.fn();
const mockDeal = { data: { stripe_mode: 'test', status: 'draft' } as unknown, error: null as unknown };

jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));
jest.mock('@/lib/impersonation-guards', () => ({ blockWriteDuringImpersonation: () => mockBlocked() }));
jest.mock('@/lib/auth/memberAccess', () => ({ requireActiveOrgRole: (...a: unknown[]) => mockGate(...a) }));
jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ rpc: mockRpc, auth: { getUser: mockGetUser } }),
}));
jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => mockDeal }) }) }),
  }),
}));
jest.mock('@/lib/billing/outboxEnqueue', () => ({ enqueueOutbox: (...a: unknown[]) => mockEnqueue(...a) }));

import { askAboutPrice, completeBillingSetup, type CompleteBillingSetupInput } from '@/lib/actions/billingSetup';

const ORG = 'ORG-4007-A';
const USER = 'USER-4007-A';

function input(over: Partial<CompleteBillingSetupInput> = {}): CompleteBillingSetupInput {
  return {
    organizationId: ORG,
    expectedVersion: 3,
    acceptTerms: true,
    contact: { who: 'other', name: 'billing team', email: 'billing@example.test', phone: '(206) 555-0100' },
    company: { legal_name: ' Realty LLC ', address_line1: '1 Main St', city: 'Seattle', region: 'WA', postal_code: '98101', country: 'us', po_number: 'PO-1' },
    ...over,
  };
}

function rpcs(map: Record<string, unknown>) {
  mockRpc.mockImplementation(async (fn: string) => ({ data: map[fn] ?? null, error: null }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBlocked.mockResolvedValue(null);
  mockGetUser.mockResolvedValue({ data: { user: { id: USER, email: 'broker@example.test' } } });
  mockGate.mockResolvedValue({ ok: true, role: 'admin' });
  rpcs({
    broker_accept_terms: { success: true, deal_version: 3, acceptance_id: 'a-1' },
    broker_complete_billing_setup: { success: true, version: 4, billing_starts_on: '2026-10-30' },
  });
  mockDeal.data = { stripe_mode: 'test', status: 'draft' };
});

describe('completeBillingSetup', () => {
  it('accepts the terms then completes, both for the version shown, with the same client', async () => {
    const r = await completeBillingSetup(input());
    expect(r).toEqual({ success: true, billingStartsOn: '2026-10-30' });
    expect(mockRpc.mock.calls.map((c) => c[0])).toEqual(['broker_accept_terms', 'broker_complete_billing_setup']);
    expect(mockRpc.mock.calls[0][1]).toEqual({
      p_org: ORG,
      p_expected_version: 3,
      p_terms_version: 'keepr-terms-2026-10',
      p_terms_url: 'https://keeprcompliance.com/terms',
    });
    expect(mockRpc.mock.calls[1][1]).toEqual({
      p_org: ORG,
      p_expected_version: 3,
      p_contact: { who: 'other', name: 'billing team', email: 'billing@example.test', phone: '(206) 555-0100' },
      p_company: {
        legal_name: 'Realty LLC', address_line1: '1 Main St', address_line2: '', city: 'Seattle', region: 'WA',
        postal_code: '98101', country: 'US', po_number: 'PO-1',
      },
      p_billing_login: false,
    });
    expect(mockGate).toHaveBeenCalledWith(expect.anything(), USER, ORG, ['broker', 'admin']);
  });

  it('C-S2 (client half): price and seat keys smuggled into the input never reach the RPC', async () => {
    const smuggled = input({
      contact: { who: 'me', phone: '2065550100', ...({ unit_price_cents: 1, seats: 99 } as object) } as never,
      company: { ...input().company, ...({ unit_price_cents: 1, monthly_total_cents: 1 } as object) } as never,
    });
    await completeBillingSetup(smuggled);
    const args = mockRpc.mock.calls[1][1];
    expect(args.p_contact).toEqual({ who: 'me', phone: '2065550100' });
    expect(Object.keys(args.p_company).sort()).toEqual(
      ['address_line1', 'address_line2', 'city', 'country', 'legal_name', 'po_number', 'postal_code', 'region'].sort()
    );
  });

  it('no Terms tick -> refused, no RPC', async () => {
    const r = await completeBillingSetup(input({ acceptTerms: false }));
    expect(r).toMatchObject({ success: false, code: 'terms_not_accepted' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('not a broker/admin of the organization -> refused, no RPC', async () => {
    mockGate.mockResolvedValue({ ok: false, reason: 'role' });
    expect(await completeBillingSetup(input())).toMatchObject({ success: false, code: 'not_authorized' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('impersonation -> refused, no RPC', async () => {
    mockBlocked.mockResolvedValue({ error: 'Write operations are not allowed during impersonation sessions' });
    expect(await completeBillingSetup(input())).toMatchObject({ success: false, code: 'impersonation' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('staff changed the order since it was shown -> version_conflict, reload, no completion', async () => {
    rpcs({ broker_accept_terms: { success: false, error: 'version_conflict', version: 4 } });
    const r = await completeBillingSetup(input());
    expect(r).toMatchObject({ success: false, code: 'version_conflict', reload: true });
    expect(mockRpc.mock.calls.map((c) => c[0])).toEqual(['broker_accept_terms']);
  });

  it.each(['invalid_phone', 'company_name_required', 'billing_address_required', 'terms_not_accepted', 'not_waiting'])(
    'completion refusal %s -> its own sentence',
    async (code) => {
      rpcs({ broker_accept_terms: { success: true }, broker_complete_billing_setup: { success: false, error: code } });
      const r = await completeBillingSetup(input());
      expect(r).toMatchObject({ success: false, code });
      expect((r as { error: string }).error).not.toBe('Something went wrong. Please try again.');
    }
  );
});

describe('askAboutPrice', () => {
  it('queues one account-manager email (price_question), keyed per person per day', async () => {
    mockEnqueue.mockResolvedValue('enqueued');
    expect(await askAboutPrice(ORG)).toEqual({ success: true });
    const [, job] = mockEnqueue.mock.calls[0];
    expect(job).toMatchObject({
      mode: 'test',
      kind: 'notify_account_manager',
      organizationId: ORG,
      payload: { organization_id: ORG, reason: 'price_question', stripe_object_id: null, detail: 'Asked by: broker@example.test' },
    });
    expect(job.dedupeKey).toMatch(new RegExp(`^notify_account_manager:test:${ORG}:price_question:${USER}:\\d{4}-\\d{2}-\\d{2}$`));
  });

  it('only while the deal waits, and only for a broker/admin', async () => {
    mockDeal.data = { stripe_mode: 'test', status: 'active' };
    expect((await askAboutPrice(ORG)).success).toBe(false);
    mockDeal.data = { stripe_mode: 'test', status: 'draft' };
    mockGate.mockResolvedValue({ ok: false, reason: 'refused' });
    expect((await askAboutPrice(ORG)).success).toBe(false);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
