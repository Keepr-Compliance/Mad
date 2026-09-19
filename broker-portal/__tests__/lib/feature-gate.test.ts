/**
 * feature-gate: two policies, one RPC — BACKLOG-3087.
 *
 * Half of this file exists to pin behaviour that must NOT change. The
 * fail-open pair (getOrgFeatures / isFeatureEnabled) has 12 live call sites
 * across the submissions surfaces; the item that added the fail-closed pair
 * asserted it had none. It does. So the fail-open contract is asserted here
 * explicitly, and a future "let's just make it strict" edit turns this red.
 *
 * The other half sweeps every way the fail-closed path can be handed something
 * it cannot trust. Boundaries are swept, not sampled: one input per branch
 * cannot catch a branch that was never written.
 */

const mockRpc = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ rpc: (...args: unknown[]) => mockRpc(...args) }),
}));

import {
  getOrgFeatures,
  isFeatureEnabled,
  isFeatureEnabledStrict,
  isFeatureEnabledFailClosed,
  getFeatureValue,
  type OrgFeatures,
} from '@/lib/feature-gate';
import {
  NOT_AUTHENTICATED_PAYLOAD,
  ORG_WITHOUT_PLAN_FEATURES,
  ORG_WITHOUT_PLAN_KEY_COUNT,
  SCIM_DISABLED_FEATURES,
  SCIM_ENABLED_FEATURES,
  TEST_ORG_ID,
} from '../fixtures/orgFeatures';

const SCIM = 'scim_provisioning';

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  mockRpc.mockReset();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// The fixture is only as good as its provenance
// ---------------------------------------------------------------------------

describe('transcribed prod fixture', () => {
  it('carries exactly the key set prod resolves, and scim_provisioning is not in it', () => {
    const keys = Object.keys(ORG_WITHOUT_PLAN_FEATURES.features);
    expect(keys).toHaveLength(ORG_WITHOUT_PLAN_KEY_COUNT);
    expect(keys).not.toContain(SCIM);
    // Org has no organization_plans row, so everything resolves from
    // feature_definitions.default_value.
    expect(new Set(Object.values(ORG_WITHOUT_PLAN_FEATURES.features).map((f) => f.source)))
      .toEqual(new Set(['default']));
  });
});

// ---------------------------------------------------------------------------
// FAIL-OPEN pair: pinned, not improved
// ---------------------------------------------------------------------------

describe('getOrgFeatures / isFeatureEnabled (fail-open — DO NOT TIGHTEN)', () => {
  it('returns the RPC payload untouched on success', async () => {
    mockRpc.mockResolvedValue({ data: ORG_WITHOUT_PLAN_FEATURES, error: null });
    await expect(getOrgFeatures(TEST_ORG_ID)).resolves.toEqual(ORG_WITHOUT_PLAN_FEATURES);
  });

  it('returns the unknown/empty default when the RPC errors', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(getOrgFeatures(TEST_ORG_ID)).resolves.toEqual({
      org_id: TEST_ORG_ID,
      plan_name: 'unknown',
      plan_tier: 'unknown',
      features: {},
    });
  });

  it('returns the unknown/empty default on the RPC\'s own error payload', async () => {
    mockRpc.mockResolvedValue({ data: NOT_AUTHENTICATED_PAYLOAD, error: null });
    await expect(getOrgFeatures(TEST_ORG_ID)).resolves.toEqual({
      org_id: TEST_ORG_ID,
      plan_name: 'unknown',
      plan_tier: 'unknown',
      features: {},
    });
  });

  it('still ALLOWS an unknown key — this is the policy, not a bug', () => {
    expect(isFeatureEnabled(ORG_WITHOUT_PLAN_FEATURES, SCIM)).toBe(true);
  });

  it('honours a key that is present and disabled', () => {
    expect(isFeatureEnabled(ORG_WITHOUT_PLAN_FEATURES, 'broker_portal_access')).toBe(false);
    expect(isFeatureEnabled(ORG_WITHOUT_PLAN_FEATURES, 'email_sync')).toBe(true);
  });

  it('reads values, and reports null for an absent key', () => {
    expect(getFeatureValue(ORG_WITHOUT_PLAN_FEATURES, 'max_transaction_size')).toBe('10');
    expect(getFeatureValue(ORG_WITHOUT_PLAN_FEATURES, SCIM)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FAIL-CLOSED, pure
// ---------------------------------------------------------------------------

describe('isFeatureEnabledStrict', () => {
  it('allows only a key that is present and enabled', () => {
    expect(isFeatureEnabledStrict(SCIM_ENABLED_FEATURES, SCIM)).toBe(true);
  });

  it('refuses a key that is present and disabled', () => {
    expect(isFeatureEnabledStrict(SCIM_DISABLED_FEATURES, SCIM)).toBe(false);
  });

  it('refuses an absent key (control (b): the feature row does not exist)', () => {
    expect(isFeatureEnabledStrict(ORG_WITHOUT_PLAN_FEATURES, SCIM)).toBe(false);
  });

  it('refuses a null/undefined feature set instead of throwing', () => {
    expect(isFeatureEnabledStrict(null, SCIM)).toBe(false);
    expect(isFeatureEnabledStrict(undefined, SCIM)).toBe(false);
  });

  it('refuses when the features map itself is missing', () => {
    expect(isFeatureEnabledStrict({ org_id: 'x' } as unknown as OrgFeatures, SCIM)).toBe(false);
  });

  it('requires enabled === true, not merely truthy', () => {
    const truthy = {
      ...SCIM_DISABLED_FEATURES,
      features: {
        ...SCIM_DISABLED_FEATURES.features,
        [SCIM]: {
          ...SCIM_DISABLED_FEATURES.features[SCIM],
          enabled: 'true' as unknown as boolean,
        },
      },
    };
    expect(isFeatureEnabledStrict(truthy, SCIM)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FAIL-CLOSED, end to end through the RPC
// ---------------------------------------------------------------------------

describe('isFeatureEnabledFailClosed', () => {
  it('allows when the org really has the feature enabled', async () => {
    mockRpc.mockResolvedValue({ data: SCIM_ENABLED_FEATURES, error: null });
    await expect(isFeatureEnabledFailClosed(TEST_ORG_ID, SCIM)).resolves.toBe(true);
  });

  it('refuses when the feature is seeded and disabled', async () => {
    mockRpc.mockResolvedValue({ data: SCIM_DISABLED_FEATURES, error: null });
    await expect(isFeatureEnabledFailClosed(TEST_ORG_ID, SCIM)).resolves.toBe(false);
  });

  // CONTROL (b): the state prod is in today — the feature row has never been
  // created, so the key is simply absent from the payload.
  it('refuses when the scim_provisioning row does not exist [CONTROL b]', async () => {
    mockRpc.mockResolvedValue({ data: ORG_WITHOUT_PLAN_FEATURES, error: null });
    await expect(isFeatureEnabledFailClosed(TEST_ORG_ID, SCIM)).resolves.toBe(false);
  });

  // CONTROL (a): force the RPC error branch.
  it('refuses when the RPC returns a supabase error [CONTROL a]', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'connection reset' } });
    await expect(isFeatureEnabledFailClosed(TEST_ORG_ID, SCIM)).resolves.toBe(false);
  });

  // CONTROL (a), second shape: the RPC reports failure as DATA with HTTP 200.
  it('refuses on the RPC\'s own error payload [CONTROL a]', async () => {
    mockRpc.mockResolvedValue({ data: NOT_AUTHENTICATED_PAYLOAD, error: null });
    await expect(isFeatureEnabledFailClosed(TEST_ORG_ID, SCIM)).resolves.toBe(false);
  });

  it('refuses when the RPC resolves with null data', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await expect(isFeatureEnabledFailClosed(TEST_ORG_ID, SCIM)).resolves.toBe(false);
  });

  it('refuses when the payload has no features object', async () => {
    mockRpc.mockResolvedValue({ data: { org_id: TEST_ORG_ID }, error: null });
    await expect(isFeatureEnabledFailClosed(TEST_ORG_ID, SCIM)).resolves.toBe(false);
  });

  it('refuses without calling the RPC when there is no org id', async () => {
    await expect(isFeatureEnabledFailClosed('', SCIM)).resolves.toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('queries the org it was asked about', async () => {
    mockRpc.mockResolvedValue({ data: SCIM_ENABLED_FEATURES, error: null });
    await isFeatureEnabledFailClosed(TEST_ORG_ID, SCIM);
    expect(mockRpc).toHaveBeenCalledWith('broker_get_org_features', { p_org_id: TEST_ORG_ID });
  });
});
