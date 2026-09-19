/**
 * The SCIM gate, end to end — BACKLOG-3087.
 *
 * Nothing in this file is mocked below the gate: requireScimAccess calls the
 * real isFeatureEnabledFailClosed, which calls the real fetchOrgFeatures. Only
 * the Supabase client is a stand-in. So deleting the feature check in
 * lib/scim-access.ts turns these red — which is the point, and is the control
 * recorded in the PR.
 *
 * An IT admin at a brokerage with the right role and a working RPC is still
 * refused while scim_provisioning is absent, because the endpoint that page
 * hands out returns 404.
 */

const mockCreateClient = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

import { requireScimAccess, isScimProvisioningEnabled, SCIM_FEATURE_KEY } from '@/lib/scim-access';
import {
  NOT_AUTHENTICATED_PAYLOAD,
  ORG_WITHOUT_PLAN_FEATURES,
  SCIM_DISABLED_FEATURES,
  SCIM_ENABLED_FEATURES,
  TEST_ORG_ID,
  TEST_USER_ID,
  makeSupabaseStub,
  type StubOptions,
} from '../fixtures/orgFeatures';

let errorSpy: jest.SpyInstance;

function stub(opts: StubOptions) {
  const s = makeSupabaseStub(opts);
  mockCreateClient.mockResolvedValue(s.client);
  return s;
}

/** The happy path every refusal case below is a single mutation away from. */
const ADMIN_WITH_SCIM: StubOptions = {
  user: { id: TEST_USER_ID },
  membership: { organization_id: TEST_ORG_ID, role: 'admin' },
  rpc: { data: SCIM_ENABLED_FEATURES, error: null },
};

beforeEach(() => {
  mockCreateClient.mockReset();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errorSpy.mockRestore());

describe('SCIM_FEATURE_KEY', () => {
  it('matches the key the migration seeds', () => {
    // 20260903_backlog_3087_scim_provisioning_feature.sql
    expect(SCIM_FEATURE_KEY).toBe('scim_provisioning');
  });
});

describe('requireScimAccess — allows', () => {
  it('an admin whose org has scim_provisioning enabled', async () => {
    stub(ADMIN_WITH_SCIM);
    await expect(requireScimAccess()).resolves.toMatchObject({
      userId: TEST_USER_ID,
      organizationId: TEST_ORG_ID,
      role: 'admin',
    });
  });

  it('an it_admin whose org has scim_provisioning enabled', async () => {
    stub({ ...ADMIN_WITH_SCIM, membership: { organization_id: TEST_ORG_ID, role: 'it_admin' } });
    await expect(requireScimAccess()).resolves.toMatchObject({ role: 'it_admin' });
  });

  it('restricts the membership lookup to admin and it_admin', async () => {
    const s = stub(ADMIN_WITH_SCIM);
    await requireScimAccess();
    const q = s.from.mock.results[0].value as Record<string, jest.Mock>;
    expect(q.in).toHaveBeenCalledWith('role', ['admin', 'it_admin']);
  });

  it('checks the feature for the caller\'s own org', async () => {
    const s = stub(ADMIN_WITH_SCIM);
    await requireScimAccess();
    expect(s.rpc).toHaveBeenCalledWith('broker_get_org_features', { p_org_id: TEST_ORG_ID });
  });
});

describe('requireScimAccess — refuses', () => {
  it('an unauthenticated caller, before touching the DB', async () => {
    const s = stub({ user: null });
    await expect(requireScimAccess()).rejects.toThrow('Not authenticated');
    expect(s.from).not.toHaveBeenCalled();
    expect(s.rpc).not.toHaveBeenCalled();
  });

  it('a signed-in user with no admin/it_admin membership', async () => {
    const s = stub({ user: { id: TEST_USER_ID }, membership: null });
    await expect(requireScimAccess()).rejects.toThrow('Not authorized');
    // Never asks about the plan of an org the caller may not belong to.
    expect(s.rpc).not.toHaveBeenCalled();
  });

  // CONTROL (b) at the gate: the feature row has never been created. This is
  // prod's state today, transcribed.
  it('an admin when the scim_provisioning row does not exist [CONTROL b]', async () => {
    stub({ ...ADMIN_WITH_SCIM, rpc: { data: ORG_WITHOUT_PLAN_FEATURES, error: null } });
    await expect(requireScimAccess()).rejects.toThrow('Not authorized');
  });

  it('an admin when the feature is seeded but disabled', async () => {
    stub({ ...ADMIN_WITH_SCIM, rpc: { data: SCIM_DISABLED_FEATURES, error: null } });
    await expect(requireScimAccess()).rejects.toThrow('Not authorized');
  });

  // CONTROL (a) at the gate: broker_get_org_features fails.
  it('an admin when broker_get_org_features errors [CONTROL a]', async () => {
    stub({ ...ADMIN_WITH_SCIM, rpc: { data: null, error: { message: 'RPC exploded' } } });
    await expect(requireScimAccess()).rejects.toThrow('Not authorized');
  });

  it('an admin on the RPC\'s own error payload [CONTROL a]', async () => {
    stub({ ...ADMIN_WITH_SCIM, rpc: { data: NOT_AUTHENTICATED_PAYLOAD, error: null } });
    await expect(requireScimAccess()).rejects.toThrow('Not authorized');
  });

  it('an admin when the RPC returns null', async () => {
    stub({ ...ADMIN_WITH_SCIM, rpc: { data: null, error: null } });
    await expect(requireScimAccess()).rejects.toThrow('Not authorized');
  });
});

describe('isScimProvisioningEnabled', () => {
  it('is true exactly when requireScimAccess would allow', async () => {
    stub(ADMIN_WITH_SCIM);
    await expect(isScimProvisioningEnabled()).resolves.toBe(true);
  });

  it.each([
    ['unauthenticated', { user: null } as StubOptions],
    ['not an admin', { user: { id: TEST_USER_ID }, membership: null } as StubOptions],
    ['feature row absent', { ...ADMIN_WITH_SCIM, rpc: { data: ORG_WITHOUT_PLAN_FEATURES, error: null } }],
    ['feature disabled', { ...ADMIN_WITH_SCIM, rpc: { data: SCIM_DISABLED_FEATURES, error: null } }],
    ['rpc error', { ...ADMIN_WITH_SCIM, rpc: { data: null, error: { message: 'x' } } }],
    ['rpc error payload', { ...ADMIN_WITH_SCIM, rpc: { data: NOT_AUTHENTICATED_PAYLOAD, error: null } }],
  ])('is false when %s', async (_label, opts) => {
    stub(opts);
    await expect(isScimProvisioningEnabled()).resolves.toBe(false);
  });

  it('is false — never throws — when the client itself blows up', async () => {
    mockCreateClient.mockRejectedValue(new Error('cookies() unavailable'));
    await expect(isScimProvisioningEnabled()).resolves.toBe(false);
  });
});
