/**
 * "gray what a plan gates, hide what doesn't exist" — BACKLOG-3078.
 *
 * Two assertions live here that nothing else can make:
 *
 *   1. THE RULE ITSELF, as a full table rather than a sample. Three inputs
 *      (unbuilt/available x on/off) and one output each, enumerated — an
 *      it.each over a described set would keep the totals stable while the
 *      cases changed underneath.
 *
 *   2. THE HARDCODED LIST IS NOT A TYPO. UNBUILT_FEATURES decides which keys
 *      render ABSENT when off. A misspelled key does not fail loudly: it drops
 *      out of the hidden category and the feature renders GRAYED with an
 *      "Available on Enterprise" label — a purchase promise for something no
 *      plan can deliver, which is the precise failure the rule exists to
 *      prevent. So every key is proven to be one the database actually knows.
 *
 * WHAT (2) CAN PROVE: that a migration seeds the key into feature_definitions.
 * WHAT IT CANNOT: that the migration has been applied to prod. That is the
 * founder's call, same as BACKLOG-3087's.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_UNLOCK_LABEL,
  FEATURE_UNLOCK_LABELS,
  UNBUILT_FEATURES,
  featureRenderPolicy,
  featureUnlockLabel,
  isUnbuiltFeature,
} from '@/lib/feature-availability';

const UNBUILT = 'scim_provisioning';
const AVAILABLE = 'custom_retention';

// ---------------------------------------------------------------------------
// 1. The rule
// ---------------------------------------------------------------------------

describe('featureRenderPolicy', () => {
  it('an available feature that is ON renders enabled', () => {
    expect(featureRenderPolicy(AVAILABLE, true)).toBe('enabled');
  });

  it('an available feature that is OFF renders grayed', () => {
    expect(featureRenderPolicy(AVAILABLE, false)).toBe('grayed');
  });

  it('an unbuilt feature that is OFF renders hidden', () => {
    expect(featureRenderPolicy(UNBUILT, false)).toBe('hidden');
  });

  it('an unbuilt feature that is ON renders enabled — turning the row on is how it ships', () => {
    // BACKLOG-3087's documented path for switching SCIM on later is an
    // organization_plans override. If ON still hid the card, that path would
    // silently do nothing and the card would be unreachable forever.
    expect(featureRenderPolicy(UNBUILT, true)).toBe('enabled');
  });

  it('an unknown key that is OFF renders grayed, not hidden', () => {
    // Hiding an unrecognised key would make a typo in UNBUILT_FEATURES
    // indistinguishable from a correct entry.
    expect(featureRenderPolicy('some_key_nobody_declared', false)).toBe('grayed');
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

  it('never advertises an unlock for a feature that does not exist', () => {
    // A label on an unbuilt key would be a promise no plan can keep — it would
    // only be reachable if the key fell out of UNBUILT_FEATURES, which is what
    // the migration guard below is for.
    for (const key of UNBUILT_FEATURES) {
      expect(FEATURE_UNLOCK_LABELS[key]).toBeUndefined();
    }
  });
});

describe('isUnbuiltFeature', () => {
  it('reads the list', () => {
    expect(isUnbuiltFeature('scim_provisioning')).toBe(true);
    expect(isUnbuiltFeature('jit_provisioning')).toBe(true);
    expect(isUnbuiltFeature('custom_retention')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Every hardcoded key is a real feature_definitions key
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(__dirname, '../../../supabase/migrations');

/**
 * Keys seeded by an INSERT INTO public.feature_definitions, derived by reading
 * the INSERT blocks — not by grepping the file for the key.
 *
 * grep finds a TOKEN. A key named in a comment, a DELETE, or a plan_features
 * row is a token, not evidence the definition exists. Only the values inside
 * an `INSERT INTO public.feature_definitions ... ON CONFLICT` block count.
 */
function seededFeatureKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of readdirSync(MIGRATIONS_DIR)) {
    if (!file.endsWith('.sql')) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const blocks = sql.split(/INSERT\s+INTO\s+public\.feature_definitions/i).slice(1);
    for (const block of blocks) {
      const values = block.split(/ON\s+CONFLICT/i)[0];
      for (const [, key] of values.matchAll(/'([a-z0-9_]+)'/g)) {
        keys.add(key);
      }
    }
  }
  return keys;
}

describe('UNBUILT_FEATURES keys exist in feature_definitions', () => {
  const seeded = seededFeatureKeys();

  it('reads a non-empty set of migrations — the check is worthless otherwise', () => {
    // Without this, a wrong MIGRATIONS_DIR would yield an empty set, every
    // it.each case below would be skipped, and the suite would still be green.
    expect(seeded.size).toBeGreaterThan(5);
    expect(UNBUILT_FEATURES.length).toBeGreaterThan(0);
  });

  it.each([...UNBUILT_FEATURES])('%s is seeded by a migration', (key) => {
    expect([...seeded]).toContain(key);
  });

  it('the control key is present too, proving the extractor finds real keys', () => {
    expect([...seeded]).toContain('custom_retention');
  });
});
