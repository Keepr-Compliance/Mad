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
import { impersonationFeatureView } from '@/lib/org-settings-access';
import {
  NOT_AUTHENTICATED_PAYLOAD,
  ORG_WITHOUT_PLAN_FEATURES,
  withFeature,
} from '../../../fixtures/orgFeatures';

/** DERIVED from the transcribed no-plan base: the same org, able to submit. */
const CAN_SUBMIT_FEATURES = withFeature(
  ORG_WITHOUT_PLAN_FEATURES,
  'broker_submission',
  true,
  'Broker Submission'
);

/**
 * The session client a support session actually has — WHICH IS NOT AN
 * AUTHENTICATED ONE.
 *
 * Traced, not assumed: the admin portal mints a token, /auth/impersonate
 * validates it with the SERVICE client ("no user session needed") and sets a
 * signed cookie in a NEW TAB on this origin, and middleware.ts lets /dashboard/*
 * through on that cookie alone without ever calling getUser. Nothing in that
 * flow establishes a Supabase session on this portal.
 *
 * So the retention gate's createClient().rpc() call runs with auth.uid() NULL,
 * and broker_get_org_features takes its first early return. That is why the
 * default here is the TRANSCRIBED not-authenticated payload and not a
 * hand-composed feature map: a fixture saying "this support session can read
 * features" describes a state the code cannot emit, and every assertion built
 * on it would be measuring nothing.
 */
function sessionClientStub(
  opts: { rpc?: { data?: unknown; error?: unknown }; throws?: boolean } = {}
) {
  const getUser = jest.fn(async () => ({ data: { user: null } }));
  const rpc = jest.fn(async () => {
    if (opts.throws) throw new Error('rpc transport failure');
    return opts.rpc ?? { data: NOT_AUTHENTICATED_PAYLOAD, error: null };
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

  it('reads the target organization, and still names it', async () => {
    // The organizations table is reachable through the scoped client — the
    // property this file exists for. The retention VALUE is a separate
    // question, asserted below.
    const stub = serviceClientStub();
    mockCreateServiceClient.mockReturnValue(stub.client);
    const view = await getAccountView();
    expect(view?.identity.organizationName).toBe('Northwind Realty');
  });

  it('SHOWS the retention card to support, matching org settings', async () => {
    // Founder, 2026-09-04, shown impersonationFeatureView()'s reasoning: "yeah
    // match that". A fail-closed check during impersonation cannot succeed —
    // there is no authenticated user — and a refusal would print a false
    // statement about the customer's plan. org-settings-access.ts decided that
    // before this page existed; this page routes to that decision instead of
    // taking its own, so My Account and Org Settings cannot disagree about the
    // same organization.
    const stub = serviceClientStub();
    mockCreateServiceClient.mockReturnValue(stub.client);
    mockCreateClient.mockResolvedValue(sessionClientStub().client);
    const view = await getAccountView();
    expect(view?.orgRetentionYears).toBe(5);
    expect(view?.identity.organizationName).toBe('Northwind Realty');
    expect(view?.preferences).toEqual(FULL_PREFERENCES);
  });

  it('shows it WITHOUT consulting the entitlement, whatever the RPC would have said', async () => {
    // The entitlement is not merely overridden — it is never asked. Both
    // payloads below are ignored, which is the whole point: what support sees
    // does not depend on a check that cannot run.
    for (const rpcPayload of [
      { data: NOT_AUTHENTICATED_PAYLOAD, error: null },
      { data: ORG_WITHOUT_PLAN_FEATURES, error: null },
      { data: CAN_SUBMIT_FEATURES, error: null },
    ]) {
      const stub = serviceClientStub();
      mockCreateServiceClient.mockReturnValue(stub.client);
      const session = sessionClientStub({ rpc: rpcPayload });
      mockCreateClient.mockResolvedValue(session.client);
      const view = await getAccountView();
      expect(view?.orgRetentionYears).toBe(5);
      expect(session.rpc).not.toHaveBeenCalled();
    }
  });

  it('takes the value from impersonationFeatureView, not from a hardcoded true', async () => {
    // Pins the reuse. If org settings ever decides support should NOT see the
    // retention card, this page must follow — and this goes red if someone has
    // replaced the shared call with a literal here.
    expect(impersonationFeatureView().retention.policy).toBe('enabled');
    expect(impersonationFeatureView().retention.unlockLabel).toBeNull();
  });

  it('renders the card even if the session client cannot be built at all', async () => {
    // The strongest form of "the entitlement is not consulted": no session
    // client, no RPC, and support still sees what org settings shows.
    const stub = serviceClientStub();
    mockCreateServiceClient.mockReturnValue(stub.client);
    mockCreateClient.mockRejectedValue(new Error('no session'));
    const view = await getAccountView();
    expect(view).not.toBeNull();
    expect(view?.identity.userId).toBe(OTHER_USER_ID);
    expect(view?.orgRetentionYears).toBe(5);
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

  it('never asks for an authenticated session', async () => {
    // Back to the original, strongest form. The retention gate briefly built
    // the session client here to resolve broker_submission; routing the
    // impersonation case to impersonationFeatureView() removed that, so a
    // support session touches no authenticated surface at all again.
    const stub = serviceClientStub();
    mockCreateServiceClient.mockReturnValue(stub.client);
    const session = sessionClientStub();
    mockCreateClient.mockResolvedValue(session.client);
    const view = await getAccountView();
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(session.getUser).not.toHaveBeenCalled();
    expect(session.rpc).not.toHaveBeenCalled();
    expect(view?.identity.userId).toBe(OTHER_USER_ID);
  });


});
