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
    const view = await getAccountView();
    expect(view?.identity.organizationName).toBe('Northwind Realty');
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
    const stub = serviceClientStub();
    mockCreateServiceClient.mockReturnValue(stub.client);
    await getAccountView();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});
