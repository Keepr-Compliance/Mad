/**
 * The four SCIM server actions refuse when the feature is off — BACKLOG-3087.
 *
 * Hiding the settings card and 404-ing the route protect the person who
 * navigates. They do nothing for a caller who knows the action name: server
 * actions are addressable endpoints. Before this item the four below checked
 * role only, so an admin at ANY org could mint a SCIM bearer token for an
 * endpoint that returns 404.
 *
 * The gate is NOT mocked here. Only the Supabase client and the impersonation
 * guard are. Each test drives the real requireScimAccess -> real
 * isFeatureEnabledFailClosed -> stubbed RPC.
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
  generateScimToken,
  revokeScimToken,
  listScimTokens,
  listScimSyncLogs,
  getScimFeatureStatus,
} from '@/lib/actions/scim';
import {
  NOT_AUTHENTICATED_PAYLOAD,
  ORG_WITHOUT_PLAN_FEATURES,
  SCIM_DISABLED_FEATURES,
  SCIM_ENABLED_FEATURES,
  TEST_ORG_ID,
  TEST_USER_ID,
  makeSupabaseStub,
  type StubOptions,
} from '../../fixtures/orgFeatures';

const ADMIN: Pick<StubOptions, 'user' | 'membership'> = {
  user: { id: TEST_USER_ID },
  membership: { organization_id: TEST_ORG_ID, role: 'admin' },
};

const TOKEN_ROWS = [{ id: 't1', description: 'Okta', request_count: 3 }];
const LOG_ROWS = [{ id: 'l1', operation: 'create', resource_type: 'User' }];

const TABLES = {
  scim_tokens: { data: TOKEN_ROWS, error: null },
  scim_sync_log: { data: LOG_ROWS, error: null },
};

function stub(rpc: StubOptions['rpc']) {
  const s = makeSupabaseStub({ ...ADMIN, rpc, tables: TABLES });
  mockCreateClient.mockResolvedValue(s.client);
  return s;
}

/**
 * Every action, with a call that is valid apart from the feature state.
 * Enumerated rather than described so a fifth SCIM action added later is a
 * visible omission here, not a silent one.
 */
const ACTIONS: Array<[string, () => Promise<unknown>]> = [
  ['generateScimToken', () => generateScimToken('Entra')],
  ['revokeScimToken', () => revokeScimToken('token-1')],
  ['listScimTokens', () => listScimTokens()],
  ['listScimSyncLogs', () => listScimSyncLogs()],
];

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  mockCreateClient.mockReset();
  mockBlockWrite.mockReset();
  mockBlockWrite.mockResolvedValue(null);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errorSpy.mockRestore());

// ---------------------------------------------------------------------------
// Refusals — the four states the brief says must not let SCIM through
// ---------------------------------------------------------------------------

describe.each([
  ['the scim_provisioning row does not exist [CONTROL b]', { data: ORG_WITHOUT_PLAN_FEATURES, error: null }],
  ['the feature is seeded but disabled', { data: SCIM_DISABLED_FEATURES, error: null }],
  ['broker_get_org_features errors [CONTROL a]', { data: null, error: { message: 'RPC exploded' } }],
  ['broker_get_org_features returns its error payload [CONTROL a]', { data: NOT_AUTHENTICATED_PAYLOAD, error: null }],
])('when %s', (_label, rpc) => {
  it.each(ACTIONS)('%s refuses', async (_name, call) => {
    stub(rpc);
    await expect(call()).rejects.toThrow('Not authorized');
  });

  it('generateScimToken writes no scim_tokens row', async () => {
    const s = stub(rpc);
    await expect(generateScimToken('Entra')).rejects.toThrow('Not authorized');
    expect(s.from).not.toHaveBeenCalledWith('scim_tokens');
  });

  it('listScimSyncLogs reads no scim_sync_log row', async () => {
    const s = stub(rpc);
    await expect(listScimSyncLogs()).rejects.toThrow('Not authorized');
    expect(s.from).not.toHaveBeenCalledWith('scim_sync_log');
  });

  it('getScimFeatureStatus reports disabled rather than throwing', async () => {
    stub(rpc);
    await expect(getScimFeatureStatus()).resolves.toEqual({ enabled: false });
  });
});

// ---------------------------------------------------------------------------
// The gate is not simply "always no"
// ---------------------------------------------------------------------------

describe('when scim_provisioning is enabled', () => {
  it('generateScimToken mints a 64-char hex token for the caller\'s own org', async () => {
    const s = stub({ data: SCIM_ENABLED_FEATURES, error: null });
    const { token } = await generateScimToken('Entra');
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const insert = (s.from.mock.results.find(
      (_r, i) => s.from.mock.calls[i][0] === 'scim_tokens'
    )!.value as Record<string, jest.Mock>).insert;
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: TEST_ORG_ID,
        created_by: TEST_USER_ID,
        description: 'Entra',
      })
    );
    // The plaintext token is returned to the caller, never stored.
    const stored = insert.mock.calls[0][0] as { token_hash: string };
    expect(stored.token_hash).not.toBe(token);
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('revokeScimToken succeeds', async () => {
    stub({ data: SCIM_ENABLED_FEATURES, error: null });
    await expect(revokeScimToken('token-1')).resolves.toEqual({ success: true });
  });

  it('listScimTokens returns the org\'s tokens', async () => {
    stub({ data: SCIM_ENABLED_FEATURES, error: null });
    await expect(listScimTokens()).resolves.toEqual(TOKEN_ROWS);
  });

  it('listScimSyncLogs returns the org\'s log rows', async () => {
    stub({ data: SCIM_ENABLED_FEATURES, error: null });
    await expect(listScimSyncLogs()).resolves.toEqual(LOG_ROWS);
  });

  it('getScimFeatureStatus reports enabled', async () => {
    stub({ data: SCIM_ENABLED_FEATURES, error: null });
    await expect(getScimFeatureStatus()).resolves.toEqual({ enabled: true });
  });
});

// ---------------------------------------------------------------------------
// Guards that existed before this item still hold
// ---------------------------------------------------------------------------

describe('pre-existing guards are not weakened', () => {
  it('impersonation still blocks the writes, before the gate runs', async () => {
    mockBlockWrite.mockResolvedValue({ error: 'Read-only during support session' });
    stub({ data: SCIM_ENABLED_FEATURES, error: null });
    await expect(generateScimToken('Entra')).rejects.toThrow('Read-only during support session');
    await expect(revokeScimToken('t1')).rejects.toThrow('Read-only during support session');
  });

  it('an unauthenticated caller is refused by every action', async () => {
    const s = makeSupabaseStub({ user: null, rpc: { data: SCIM_ENABLED_FEATURES, error: null } });
    mockCreateClient.mockResolvedValue(s.client);
    for (const [, call] of ACTIONS) {
      await expect(call()).rejects.toThrow('Not authenticated');
    }
  });

  it('a member who is neither admin nor it_admin is refused by every action', async () => {
    const s = makeSupabaseStub({
      user: { id: TEST_USER_ID },
      membership: null,
      rpc: { data: SCIM_ENABLED_FEATURES, error: null },
    });
    mockCreateClient.mockResolvedValue(s.client);
    for (const [, call] of ACTIONS) {
      await expect(call()).rejects.toThrow('Not authorized');
    }
  });
});
