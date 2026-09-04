/**
 * How a feature-gated control renders — BACKLOG-3078.
 *
 * ===========================================================================
 * "gray what a plan gates, hide what doesn't exist" — founder, 2026-09-04
 * ===========================================================================
 *
 * Two different reasons a control is off, and they must not look the same:
 *
 *   GRAYED  The feature works; this org's plan does not include it. Render the
 *           control disabled with a label naming what unlocks it. That is true,
 *           and it does sales work — the customer sees what they could have.
 *
 *   HIDDEN  The feature does not exist. Render nothing. Graying implies
 *           purchasable, and no plan can deliver it, so a grayed control would
 *           be a promise we cannot keep on any tier.
 *
 * Every false-promise defect found on 2026-09-03/04 was the same shape: a
 * surface offering something the backend could not deliver. Graying an unbuilt
 * feature recreates exactly that, one layer down.
 *
 * ---------------------------------------------------------------------------
 * A GRAYED OR HIDDEN CONTROL IS NOT A GATE.
 * ---------------------------------------------------------------------------
 * Nothing in this file refuses anything. It decides pixels. The refusals live
 * in lib/scim-access.ts (BACKLOG-3087), lib/jit-access.ts (BACKLOG-3094) and
 * the retention check in lib/actions/scim.ts, and they must keep refusing
 * whatever this file returns. A caller who knows an action's name never goes
 * through here at all.
 */

/**
 * Which features are unbuilt, rather than merely unlicensed. A flag reads false
 * for both, so the distinction has to live somewhere explicit. Hardcoded on
 * purpose for speed (founder, 2026-09-04); BACKLOG-3098 moves it to a column on
 * feature_definitions so shipping SCIM becomes a data change, not a deploy.
 *
 * - scim_provisioning: the `scim` edge function has never been deployed; the
 *   endpoint the settings page hands out returns 404 (BACKLOG-3087 / 2241).
 * - jit_provisioning: every JIT join fails and signs the user out — signature
 *   drift plus EXECUTE revoked from `authenticated` (BACKLOG-3094 / 1954).
 *
 * `__tests__/lib/feature-availability.test.ts` asserts every key here is seeded
 * into feature_definitions by a migration. A typo would silently move a feature
 * out of the hidden category and gray something unbuilt — the exact failure the
 * rule exists to prevent. BACKLOG-3098 must keep an equivalent guard.
 */
export const UNBUILT_FEATURES = ['scim_provisioning', 'jit_provisioning'] as const;

export type UnbuiltFeatureKey = (typeof UNBUILT_FEATURES)[number];

/** How a single feature-gated control should render. */
export type FeatureRenderPolicy = 'enabled' | 'grayed' | 'hidden';

/**
 * What unlocks each grayed feature. Lives beside UNBUILT_FEATURES so
 * BACKLOG-3098 moves one thing, not two.
 *
 * custom_retention verified against plan_features on 2026-09-04: enterprise
 * enabled, team and individual disabled.
 */
export const FEATURE_UNLOCK_LABELS: Readonly<Record<string, string>> = {
  custom_retention: 'Available on Enterprise',
};

/** The fallback when a grayed key has no specific unlock label recorded. */
export const DEFAULT_UNLOCK_LABEL = 'Not included in your plan';

/**
 * The rule, in one place.
 *
 * ON ALWAYS WINS. An unbuilt feature that resolves true is enabled, not hidden:
 * turning the feature_definitions row (or an organization_plans override) on is
 * the deliberate act that ships it, and BACKLOG-3087 documents that as the way
 * SCIM gets switched on later. This also means the SCIM card's behaviour is
 * byte-for-byte what 3087 shipped — visible iff the feature resolves true —
 * rather than a new rule wearing its name.
 *
 * So the list below only decides what OFF looks like.
 */
export function featureRenderPolicy(
  featureKey: string,
  enabled: boolean
): FeatureRenderPolicy {
  if (enabled) return 'enabled';
  return isUnbuiltFeature(featureKey) ? 'hidden' : 'grayed';
}

/** Is this key one of the unbuilt ones? Read the list, never a per-key literal. */
export function isUnbuiltFeature(featureKey: string): boolean {
  return (UNBUILT_FEATURES as readonly string[]).includes(featureKey);
}

/**
 * The label shown next to a grayed control.
 *
 * Returns null for anything not grayed, so a caller cannot accidentally print
 * "Available on Enterprise" beside a working control.
 */
export function featureUnlockLabel(
  featureKey: string,
  policy: FeatureRenderPolicy
): string | null {
  if (policy !== 'grayed') return null;
  return FEATURE_UNLOCK_LABELS[featureKey] ?? DEFAULT_UNLOCK_LABEL;
}
