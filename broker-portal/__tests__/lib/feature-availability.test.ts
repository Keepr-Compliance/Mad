/**
 * "gray what a plan gates, hide what doesn't exist" — BACKLOG-3078/3098.
 *
 * Three assertions live here that nothing else can make:
 *
 *   1. THE RULE ITSELF, as a full table rather than a sample. Four inputs
 *      (built/unbuilt x on/off) and one output each, enumerated — an it.each
 *      over a described set would keep the totals stable while the cases
 *      changed underneath.
 *
 *   2. THE FAIL DIRECTION. BACKLOG-3098 moved "which features are unbuilt" out
 *      of a hardcoded array and into feature_definitions.is_built, which means
 *      the portal can now fail to READ it. Every such failure must resolve to
 *      unbuilt -> HIDDEN. Graying says "you could buy this", and saying that
 *      about a feature we cannot confirm was ever built is the exact false
 *      promise the rule exists to prevent. Each way of not knowing is driven
 *      separately, because they take different code paths: the query errors,
 *      the payload is not rows, the client throws, the row is missing, the
 *      column is null.
 *
 *   3. THE READ ASKS FOR THE RIGHT THING. A query naming the wrong table or the
 *      wrong columns would return nothing, hide everything, and look exactly
 *      like a correctly-cautious portal.
 *
 * WHAT THIS CAN PROVE: that the rule and the read behave. WHAT IT CANNOT: that
 * the migration adding the column has been applied to prod — that is the
 * founder's call, and __tests__/migrations/feature-definitions-is-built.test.ts
 * covers what the migration file says.
 */

const mockCreateClient = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

import {
  DEFAULT_UNLOCK_LABEL,
  FEATURE_UNLOCK_LABELS,
  fetchFeatureBuildStates,
  featureRenderPolicy,
  featureUnlockLabel,
  isFeatureBuilt,
  type FeatureBuildStates,
} from '@/lib/feature-availability';
import {
  FEATURE_DEFINITION_ROWS,
  FEATURE_DEFINITION_ROW_COUNT,
  UNBUILT_FEATURE_ROW_COUNT,
  builtFlagRows,
  makeSupabaseStub,
  withBuiltFlag,
} from '../fixtures/orgFeatures';

/** The map shape fetchFeatureBuildStates produces, from fixture rows. */
function statesFrom(rows: { key: string; is_built: boolean }[]): FeatureBuildStates {
  return new Map(rows.map((r) => [r.key, r.is_built]));
}

const UNBUILT = 'scim_provisioning';
const AVAILABLE = 'custom_retention';

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  mockCreateClient.mockReset();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errorSpy.mockRestore());

/** Point the mocked server client at a given feature_definitions result. */
function definitionsRead(result: { data?: unknown; error?: unknown }) {
  const stub = makeSupabaseStub({ tables: { feature_definitions: result } });
  mockCreateClient.mockResolvedValue(stub.client);
  return stub;
}

// ---------------------------------------------------------------------------
// 0. The fixture is what it claims to be
// ---------------------------------------------------------------------------

describe('the transcribed feature_definitions fixture', () => {
  it('carries all 23 rows, exactly 2 of them unbuilt', () => {
    // Pre-registered, so a silent edit that drops a row or flips a flag fails
    // here rather than quietly weakening every case below.
    expect(FEATURE_DEFINITION_ROWS).toHaveLength(FEATURE_DEFINITION_ROW_COUNT);
    const unbuilt = FEATURE_DEFINITION_ROWS.filter((r) => !r.is_built).map((r) => r.key);
    expect(unbuilt.sort()).toEqual(['jit_provisioning', 'scim_provisioning']);
    expect(unbuilt).toHaveLength(UNBUILT_FEATURE_ROW_COUNT);
  });
});

// ---------------------------------------------------------------------------
// 1. The rule
// ---------------------------------------------------------------------------

describe('featureRenderPolicy', () => {
  it('a built feature that is ON renders enabled', () => {
    expect(featureRenderPolicy(true, true)).toBe('enabled');
  });

  it('a built feature that is OFF renders grayed', () => {
    expect(featureRenderPolicy(false, true)).toBe('grayed');
  });

  it('an unbuilt feature that is OFF renders hidden', () => {
    expect(featureRenderPolicy(false, false)).toBe('hidden');
  });

  it('an unbuilt feature that is ON renders enabled — turning the row on is how it ships', () => {
    // BACKLOG-3087's documented path for switching SCIM on later is an
    // organization_plans override. If ON still hid the card, that path would
    // silently do nothing and the card would be unreachable forever.
    expect(featureRenderPolicy(true, false)).toBe('enabled');
  });

  it('takes no feature key at all — that is the point of BACKLOG-3098', () => {
    // The signature is the guard. While a key was an input, a component or a
    // helper could grow a per-key branch here; now there is nothing to branch
    // on. arguments.length is the only way to assert an absent parameter.
    expect(featureRenderPolicy).toHaveLength(2);
  });
});

describe('featureUnlockLabel', () => {
  it('names what unlocks a grayed feature', () => {
    expect(featureUnlockLabel(AVAILABLE, 'grayed')).toBe('Available on Enterprise');
  });

  it('falls back to a generic label for a grayed key with none recorded', () => {
    expect(featureUnlockLabel('unlabelled_key', 'grayed')).toBe(DEFAULT_UNLOCK_LABEL);
  });

  it('returns nothing for an enabled control', () => {
    expect(featureUnlockLabel(AVAILABLE, 'enabled')).toBeNull();
  });

  it('returns nothing for a hidden control', () => {
    expect(featureUnlockLabel(UNBUILT, 'hidden')).toBeNull();
  });

  it('never advertises an unlock for a feature the database calls unbuilt', () => {
    // A label on an unbuilt key would be a promise no plan can keep. Read from
    // the transcribed table rather than a hand-listed pair, so a third unbuilt
    // feature added later is covered without editing this test.
    for (const row of FEATURE_DEFINITION_ROWS.filter((r) => !r.is_built)) {
      expect(FEATURE_UNLOCK_LABELS[row.key]).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Reading the column
// ---------------------------------------------------------------------------

describe('fetchFeatureBuildStates', () => {
  it('returns every key the table marks built, and no key it marks unbuilt', () => {
    // Identity, not counts: a set of the right size made of the wrong keys
    // would hide the wrong cards.
    definitionsRead({ data: builtFlagRows(), error: null });
    return fetchFeatureBuildStates().then((states) => {
      // Every row is present — a row that says false is a row we HAVE, and the
      // difference between that and an absent row is what keeps the healthy
      // state quiet. Identity, not counts.
      expect([...states.keys()].sort()).toEqual(
        FEATURE_DEFINITION_ROWS.map((r) => r.key).sort()
      );
      expect(states.get('scim_provisioning')).toBe(false);
      expect(states.get('jit_provisioning')).toBe(false);
      expect(states.get('custom_retention')).toBe(true);
    });
  });

  it('asks feature_definitions for key and is_built', async () => {
    // A read naming the wrong table or the wrong columns returns nothing, hides
    // everything, and is indistinguishable from correct caution at the surface.
    const stub = definitionsRead({ data: builtFlagRows(), error: null });
    await fetchFeatureBuildStates();
    expect(stub.from).toHaveBeenCalledWith('feature_definitions');
    const query = stub.from.mock.results[0].value as { select: jest.Mock };
    expect(query.select).toHaveBeenCalledWith('key, is_built');
  });

  it('reads the table ONCE for every key, not once per key', async () => {
    const stub = definitionsRead({ data: builtFlagRows(), error: null });
    await fetchFeatureBuildStates();
    expect(stub.from).toHaveBeenCalledTimes(1);
  });
});

describe('fetchFeatureBuildStates — every way of not knowing means UNBUILT', () => {
  // The migration has not been applied to prod, so `column is_built does not
  // exist` is the live case, not a hypothetical one.
  it('a query error yields an empty set', async () => {
    definitionsRead({
      data: null,
      error: { message: 'column feature_definitions.is_built does not exist' },
    });
    expect((await fetchFeatureBuildStates()).size).toBe(0);
  });

  it('a non-array payload yields an empty set', async () => {
    definitionsRead({ data: { unexpected: true }, error: null });
    expect((await fetchFeatureBuildStates()).size).toBe(0);
  });

  it('a throwing client yields an empty set rather than a 500', async () => {
    // createClient throws outside a request scope; an unhandled throw here
    // would take the whole settings page down instead of hiding a card.
    mockCreateClient.mockRejectedValue(new Error('cookies() outside request scope'));
    expect((await fetchFeatureBuildStates()).size).toBe(0);
  });

  it('reports the failure rather than swallowing it', async () => {
    definitionsRead({ data: null, error: { message: 'boom' } });
    await fetchFeatureBuildStates();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('treats a null is_built as unbuilt, never coercing it to built', async () => {
    definitionsRead({
      data: [{ key: 'custom_retention', is_built: null }],
      error: null,
    });
    expect((await fetchFeatureBuildStates()).get('custom_retention')).toBe(false);
  });

  it('treats a non-boolean is_built as unbuilt', async () => {
    definitionsRead({ data: [{ key: 'custom_retention', is_built: 'true' }], error: null });
    expect((await fetchFeatureBuildStates()).get('custom_retention')).toBe(false);
  });
});

describe('isFeatureBuilt', () => {
  it('reports a key the database marks built', () => {
    expect(isFeatureBuilt(statesFrom(builtFlagRows()), 'custom_retention')).toBe(true);
  });

  it('a key missing from the table is UNBUILT, so its control hides', () => {
    expect(isFeatureBuilt(statesFrom([{ key: 'custom_retention', is_built: true }]), 'scim_provisioning')).toBe(false);
  });

  it('is SILENT about a row that exists and says false — that is the designed state', () => {
    // scim_provisioning and jit_provisioning are SUPPOSED to read false. If
    // "not built" and "I could not find out" produced the same console.error,
    // every admin load of /dashboard/settings would log two errors forever and
    // bury the line that means something real.
    const states = statesFrom(builtFlagRows());
    expect(isFeatureBuilt(states, 'scim_provisioning')).toBe(false);
    expect(isFeatureBuilt(states, 'jit_provisioning')).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('a missing key fails LOUDLY — a deleted row must not be silent', () => {
    // The backlog item is explicit: an unknown key or a feature row missing
    // entirely must fail loudly rather than default to visible. Hidden is the
    // right pixel; silence is the wrong diagnostic.
    isFeatureBuilt(new Map<string, boolean>(), 'custom_retention');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('custom_retention'));
  });
});

// ---------------------------------------------------------------------------
// 3. Column -> pixels, end to end through the real rule
// ---------------------------------------------------------------------------

describe('flipping is_built changes the render with no code change', () => {
  async function policyFor(key: string, rows: { key: string; is_built: boolean }[]) {
    definitionsRead({ data: rows, error: null });
    const states = await fetchFeatureBuildStates();
    return featureRenderPolicy(false, isFeatureBuilt(states, key));
  }

  it('is_built false + plan off -> hidden', async () => {
    expect(await policyFor(UNBUILT, builtFlagRows())).toBe('hidden');
  });

  it('is_built true + plan off -> grayed, with only the column changed', async () => {
    // This is BACKLOG-3098's whole promise: the day SCIM ships, one UPDATE
    // makes its card start rendering. Nothing in the portal moves.
    expect(await policyFor(UNBUILT, builtFlagRows(withBuiltFlag(UNBUILT, true)))).toBe(
      'grayed'
    );
  });

  it('a built, unlicensed feature grays and names its unlock', async () => {
    const policy = await policyFor(AVAILABLE, builtFlagRows());
    expect(policy).toBe('grayed');
    expect(featureUnlockLabel(AVAILABLE, policy)).toBe('Available on Enterprise');
  });
});
