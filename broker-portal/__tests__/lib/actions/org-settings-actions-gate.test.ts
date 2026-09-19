/**
 * The org-policy server actions refuse when their feature is off.
 * BACKLOG-3078 (retention) / BACKLOG-3094 (JIT).
 *
 * A GRAYED OR HIDDEN CONTROL IS NOT A GATE. Server actions are addressable
 * endpoints: a caller who knows the name never sees the card at all.
 *
 *   - updateRetentionPolicy had NO feature check before this item. The Email
 *     Retention Policy card was simply always rendered, so an admin at a
 *     team-plan org could set an org-wide retention period that locks every
 *     member's desktop setting — a feature their plan does not include.
 *   - getJitStatus / updateJitStatus checked role only. Every JIT join fails
 *     (BACKLOG-3094), so leaving the toggle callable lets an admin switch on
 *     automatic joining that bounces every agent with org_not_setup.
 *
 * The gates are NOT mocked. Only the Supabase client and the impersonation
 * guard are: each test drives the real requireJitAccess /
 * isFeatureEnabledFailClosed against a stubbed RPC.
 */

const mockCreateClient = jest.fn();
const mockBlockWrite = jest.fn(async () => null as { error: string } | null);

jest.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
jest.mock('@/lib/impersonation-guards', () => ({
  blockWriteDuringImpersonation: () => mockBlockWrite(),
}));

import {
  updateRetentionPolicy,
  getRetentionPolicy,
  getJitStatus,
  updateJitStatus,
  getJitFeatureStatus,
} from '@/lib/actions/scim';
import {
  ENTERPRISE_PLAN_FEATURES,
  NOT_AUTHENTICATED_PAYLOAD,
  ORG_WITHOUT_PLAN_FEATURES,
  TEAM_PLAN_FEATURES,
  TEST_ORG_ID,
  TEST_USER_ID,
  makeSupabaseStub,
  withFeature,
  type StubOptions,
} from '../../fixtures/orgFeatures';

const ADMIN: Pick<StubOptions, 'user' | 'membership'> = {
  user: { id: TEST_USER_ID },
  membership: { organization_id: TEST_ORG_ID, role: 'admin' },
};

const TABLES = {
  organizations: {
    data: { retention_years: 7, jit_provisioning_enabled: true },
    error: null,
  },
};

function stub(rpc: StubOptions['rpc'], who: Partial<StubOptions> = {}) {
  const s = makeSupabaseStub({ ...ADMIN, ...who, rpc, tables: TABLES });
  mockCreateClient.mockResolvedValue(s.client);
  return s;
}

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  mockCreateClient.mockReset();
  mockBlockWrite.mockReset();
  mockBlockWrite.mockResolvedValue(null);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errorSpy.mockRestore());

// ---------------------------------------------------------------------------
// Email retention — grayed in the UI, refused on the server
// ---------------------------------------------------------------------------

describe('updateRetentionPolicy — custom_retention gate', () => {
  it.each([
    ['the org plan does not include it', { data: TEAM_PLAN_FEATURES, error: null }],
    [
      'the custom_retention row is missing entirely',
      { data: withFeature(ORG_WITHOUT_PLAN_FEATURES, 'placeholder', false), error: null },
    ],
    ['the RPC errors', { data: null, error: { message: 'boom' } }],
    ['the RPC reports not_authenticated as data', { data: NOT_AUTHENTICATED_PAYLOAD, error: null }],
    ['the payload is malformed', { data: { org_id: TEST_ORG_ID }, error: null }],
  ])('refuses when %s', async (_label, rpc) => {
    stub(rpc);
    await expect(updateRetentionPolicy(3)).rejects.toThrow('Not authorized');
  });

  it('writes nothing when it refuses', async () => {
    const s = stub({ data: TEAM_PLAN_FEATURES, error: null });
    await expect(updateRetentionPolicy(3)).rejects.toThrow('Not authorized');
    expect(s.from).not.toHaveBeenCalledWith('organizations');
  });

  it('allows an enterprise org through', async () => {
    stub({ data: ENTERPRISE_PLAN_FEATURES, error: null });
    await expect(updateRetentionPolicy(3)).resolves.toEqual({ success: true });
  });

  it('still refuses a non-admin at an org that HAS the feature', async () => {
    // The feature check is additional to the role check, never a replacement.
    stub({ data: ENTERPRISE_PLAN_FEATURES, error: null }, { membership: null });
    await expect(updateRetentionPolicy(3)).rejects.toThrow('Not authorized');
  });

  it('still rejects an out-of-range value at an org that HAS the feature', async () => {
    stub({ data: ENTERPRISE_PLAN_FEATURES, error: null });
    await expect(updateRetentionPolicy(99)).rejects.toThrow(
      'Retention must be between 1 and 10 years'
    );
  });

  it('reading the current policy is NOT gated — an admin may see what is set', async () => {
    // Graying a control the customer already has a stored value for must not
    // hide the value itself.
    stub({ data: TEAM_PLAN_FEATURES, error: null });
    await expect(getRetentionPolicy()).resolves.toEqual({ retentionYears: 7 });
  });
});

// ---------------------------------------------------------------------------
// JIT — hidden in the UI, refused on the server
// ---------------------------------------------------------------------------

const JIT_ACTIONS: Array<[string, () => Promise<unknown>]> = [
  ['getJitStatus', () => getJitStatus()],
  ['updateJitStatus', () => updateJitStatus(true)],
];

describe.each([
  ['the jit_provisioning row does not exist', { data: ORG_WITHOUT_PLAN_FEATURES, error: null }],
  ['the feature is seeded and off', { data: TEAM_PLAN_FEATURES, error: null }],
  ['the RPC errors', { data: null, error: { message: 'boom' } }],
  ['the RPC reports not_authenticated as data', { data: NOT_AUTHENTICATED_PAYLOAD, error: null }],
])('JIT actions when %s', (_label, rpc) => {
  it.each(JIT_ACTIONS)('%s refuses', async (_name, call) => {
    stub(rpc);
    await expect(call()).rejects.toThrow('Not authorized');
  });

  it('getJitFeatureStatus reports disabled without throwing', async () => {
    stub(rpc);
    await expect(getJitFeatureStatus()).resolves.toEqual({ enabled: false });
  });
});

describe('JIT actions when the feature is on', () => {
  const ON = {
    data: withFeature(TEAM_PLAN_FEATURES, 'jit_provisioning', true),
    error: null,
  };

  it('getJitStatus returns the stored value', async () => {
    stub(ON);
    await expect(getJitStatus()).resolves.toEqual({ enabled: true });
  });

  it('updateJitStatus writes', async () => {
    stub(ON);
    await expect(updateJitStatus(false)).resolves.toEqual({ success: true });
  });

  it('getJitFeatureStatus reports enabled', async () => {
    stub(ON);
    await expect(getJitFeatureStatus()).resolves.toEqual({ enabled: true });
  });

  it('still refuses a non-admin', async () => {
    stub(ON, { membership: null });
    await expect(updateJitStatus(false)).rejects.toThrow('Not authorized');
  });

  it('still refuses an unauthenticated caller', async () => {
    stub(ON, { user: null });
    await expect(getJitStatus()).rejects.toThrow('Not authenticated');
  });

  it('still blocks the write during impersonation', async () => {
    mockBlockWrite.mockResolvedValue({ error: 'Write operations are not allowed during impersonation sessions' });
    stub(ON);
    await expect(updateJitStatus(false)).rejects.toThrow('impersonation');
  });
});

// ---------------------------------------------------------------------------
// The stored value is left alone
// ---------------------------------------------------------------------------

describe('organizations.jit_provisioning_enabled is untouched by the gate', () => {
  it('a refused updateJitStatus writes nothing', async () => {
    // BACKLOG-3094: hiding the control must not change any org's stored value.
    // The column matters again the moment BACKLOG-1954 lands.
    const s = stub({ data: TEAM_PLAN_FEATURES, error: null });
    await expect(updateJitStatus(false)).rejects.toThrow('Not authorized');
    expect(s.from).not.toHaveBeenCalledWith('organizations');
  });
});
