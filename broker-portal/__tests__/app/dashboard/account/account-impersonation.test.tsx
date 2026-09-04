/**
 * A support session actually loads the account page. BACKLOG-3079.
 *
 * ---------------------------------------------------------------------------
 * NOTHING BELOW getImpersonationSession IS MOCKED.
 * ---------------------------------------------------------------------------
 * The real getDataClient runs, builds the real createScopedClient over a
 * service-client stand-in, and getAccountView reads through it. That is the
 * whole point: the access tests in account-page.test.tsx stub getDataClient, so
 * they prove the page ADMITS a support session and nothing about whether it can
 * then read anything.
 *
 * It could not. `users`, `user_preferences` and `organizations` were absent from
 * ALLOWED_TABLES in lib/scoped-client.ts, and a missing table there does not
 * read as empty — createBlockedQueryBuilder throws on every method, so the page
 * 500s. Support reading a customer's settings is the only route that exists
 * (RLS on user_preferences is own-rows plus service_role, with no internal-role
 * read policy), which makes it the one path that had to work.
 */

const mockGetImpersonationSession = jest.fn();
const mockCreateServiceClient = jest.fn();
const mockCreateClient = jest.fn();

jest.mock('@/lib/impersonation', () => ({
  getImpersonationSession: () => mockGetImpersonationSession(),
}));
jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => mockCreateServiceClient(),
}));
jest.mock('@/lib/supabase/server', () => ({
  createClient: () => mockCreateClient(),
}));

import { getAccountView } from '@/lib/account/getAccountView';
import { FULL_PREFERENCES, OTHER_USER_ID } from '../../../fixtures/account';
import { ORG_WITHOUT_PLAN_FEATURES, withFeature } from '../../../fixtures/orgFeatures';

/** DERIVED from the transcribed no-plan base: the same org, able to submit. */
const CAN_SUBMIT_FEATURES = withFeature(
  ORG_WITHOUT_PLAN_FEATURES,
  'broker_submission',
  true,
  'Broker Submission'
);

/**
 * The SUPPORT ADMIN's own session client. Since the retention gate it is built
 * during a support session — for broker_get_org_features and nothing else. It
 * carries getUser purely so the test can assert getUser is never called.
 */
function sessionClientStub(opts: { rpc?: { data?: unknown; error?: unknown }; throws?: boolean } = {}) {
  const getUser = jest.fn(async () => ({ data: { user: { id: 'support-admin' } } }));
  const rpc = jest.fn(async () => {
    if (opts.throws) throw new Error('rpc transport failure');
    return opts.rpc ?? { data: CAN_SUBMIT_FEATURES, error: null };
  });
  return { client: { auth: { getUser }, rpc }, getUser, rpc };
}

/** pii-allow-uuid: invented, not from any live row. */
const TARGET_ORG_ID = '00000000-3079-4000-8000-000000000009';

const ROWS: Record<string, unknown> = {
  organization_members: { role: 'agent', organization_id: TARGET_ORG_ID },
  users: {
    id: OTHER_USER_ID,
    email: 'jordan.lee@example.test',
    display_name: 'Jordan Lee',
    first_name: 'Jordan',
    last_name: 'Lee',
    oauth_provider: 'azure',
    created_at: '2026-02-01T00:00:00.000Z',
  },
  user_preferences: { preferences: FULL_PREFERENCES, updated_at: '2026-08-30T12:00:00.000Z' },
  organizations: { name: 'Northwind Realty', retention_years: 5 },
};

/** A service-role client stand-in. Unscoped by design — the scoping under test
 *  is the Proxy's, not this stub's. */
function serviceClientStub() {
  const seen: string[] = [];
  const from = jest.fn((table: string) => {
    seen.push(table);
    const q: Record<string, unknown> = {};
    const chain = () => q;
    for (const m of ['select', 'eq', 'in', 'order', 'limit']) q[m] = jest.fn(chain);
    q.maybeSingle = jest.fn(async () => ({ data: ROWS[table] ?? null, error: null }));
    q.single = q.maybeSingle;
    return q;
  });
  return { client: { from, auth: {} }, seen };
}

beforeEach(() => {
  mockGetImpersonationSession.mockReset();
  mockCreateServiceClient.mockReset();
  mockCreateClient.mockReset();
  mockGetImpersonationSession.mockResolvedValue({ target_user_id: OTHER_USER_ID });
  mockCreateClient.mockResolvedValue(sessionClientStub().client);
});

describe('getAccountView through the real scoped impersonation client', () => {
  it('does not throw — every table it reads is reachable', async () => {
    const stub = serviceClientStub();
    mockCreateServiceClient.mockReturnValue(stub.client);
    await expect(getAccountView()).resolves.not.toBeNull();
  });

  it('returns the TARGET user, not the support agent', async () => {
    const stub = serviceClientStub();
    mockCreateServiceClient.mockReturnValue(stub.client);
    const view = await getAccountView();
    expect(view?.identity.userId).toBe(OTHER_USER_ID);
    expect(view?.identity.displayName).toBe('Jordan Lee');
    expect(view?.isImpersonating).toBe(true);
  });

  it('reads the target user\'s preferences rather than an empty state', async () => {
    // The regression this file was written for produced the empty state (or a
    // 500) for every support session — indistinguishable, from the outside,
    // from a customer who has never used the desktop app.
    const stub = serviceClientStub();
    mockCreateServiceClient.mockReturnValue(stub.client);
    const view = await getAccountView();
    expect(view?.preferences).toEqual(FULL_PREFERENCES);
    expect(view?.preferences).not.toBeNull();
  });

  it('reads the target organization, including its retention policy', async () => {
    const stub = serviceClientStub();
    mockCreateServiceClient.mockReturnValue(stub.client);
    const session = sessionClientStub({ rpc: { data: CAN_SUBMIT_FEATURES, error: null } });
    mockCreateClient.mockResolvedValue(session.client);
    const view = await getAccountView();
    expect(view?.identity.organizationName).toBe('Northwind Realty');
    expect(view?.orgRetentionYears).toBe(5);
    // Asked about the TARGET's org, not the support admin's.
    expect(session.rpc).toHaveBeenCalledWith('broker_get_org_features', {
      p_org_id: TARGET_ORG_ID,
    });
  });

  it('suppresses the retention policy when the target org cannot submit', async () => {
    // Support sees what the customer sees. A card the customer is not shown
    // must not appear for support either, or the two disagree about what the
    // customer's account says.
    const stub = serviceClientStub();
    mockCreateServiceClient.mockReturnValue(stub.client);
    mockCreateClient.mockResolvedValue(
      sessionClientStub({ rpc: { data: ORG_WITHOUT_PLAN_FEATURES, error: null } }).client
    );
    const view = await getAccountView();
    expect(view?.orgRetentionYears).toBeNull();
    expect(view?.identity.organizationName).toBe('Northwind Realty');
  });

  it('suppresses it, and still renders a page, when the session client cannot be built', async () => {
    // THIS is where the try/catch earns its place. In a support session the
    // subject comes from the impersonation cookie, so createClient() is called
    // only by the feature gate — an unguarded throw here would 500 the whole
    // page for support, and a fail-open catch would state a policy nobody can
    // vouch for. Neither: the page renders, without the card.
    const stub = serviceClientStub();
    mockCreateServiceClient.mockReturnValue(stub.client);
    mockCreateClient.mockRejectedValue(new Error('no session'));
    const view = await getAccountView();
    expect(view).not.toBeNull();
    expect(view?.identity.userId).toBe(OTHER_USER_ID);
    expect(view?.orgRetentionYears).toBeNull();
  });

  it('suppresses it when the feature RPC throws', async () => {
    const stub = serviceClientStub();
    mockCreateServiceClient.mockReturnValue(stub.client);
    mockCreateClient.mockResolvedValue(sessionClientStub({ throws: true }).client);
    const view = await getAccountView();
    expect(view).not.toBeNull();
    expect(view?.orgRetentionYears).toBeNull();
  });

  it('touches exactly the four tables the page needs', async () => {
    // Enumerated, not counted: a fifth table added later without a
    // scoped-client entry would throw at runtime, and this is where that shows.
    const stub = serviceClientStub();
    mockCreateServiceClient.mockReturnValue(stub.client);
    await getAccountView();
    expect(new Set(stub.seen)).toEqual(
      new Set(['organization_members', 'users', 'user_preferences', 'organizations'])
    );
  });

  it('never derives the subject from an authenticated session', async () => {
    // Was `expect(mockCreateClient).not.toHaveBeenCalled()`. The session client
    // IS now built during a support session — for broker_get_org_features and
    // nothing else. The property that mattered was never "no session client":
    // it was "the subject is the impersonation target, not the admin", and
    // auth.getUser is the only thing that could break it.
    const stub = serviceClientStub();
    mockCreateServiceClient.mockReturnValue(stub.client);
    const session = sessionClientStub();
    mockCreateClient.mockResolvedValue(session.client);
    const view = await getAccountView();
    expect(session.getUser).not.toHaveBeenCalled();
    expect(view?.identity.userId).toBe(OTHER_USER_ID);
    expect(session.rpc.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      'broker_get_org_features',
    ]);
  });
});
