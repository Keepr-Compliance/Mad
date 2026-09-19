/**
 * How a feature-gated control renders — BACKLOG-3078, moved to data by 3098.
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
 * WHICH FEATURES ARE UNBUILT IS NOW A DATABASE FACT, NOT A CONSTANT.
 * ---------------------------------------------------------------------------
 * BACKLOG-3078 shipped the list as a hardcoded array here, approved as a
 * deliberate shortcut. `feature_definitions.is_built` replaces it: shipping
 * SCIM is a data change (flip the row) instead of a portal deploy, and this
 * file no longer knows the name of a single product feature. It takes two
 * booleans and returns a render policy.
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

import { createClient } from '@/lib/supabase/server';

/** How a single feature-gated control should render. */
export type FeatureRenderPolicy = 'enabled' | 'grayed' | 'hidden';

/**
 * What the database says about each feature's existence: key -> is_built.
 *
 * A map of every row rather than a set of the built ones, and the difference is
 * load-bearing in BOTH directions:
 *
 *   PRESENT AND FALSE is the DESIGNED state — scim_provisioning and
 *   jit_provisioning are supposed to read false. It renders hidden, quietly. A
 *   set of the built keys could not tell that apart from a fault, so every
 *   admin load of /dashboard/settings would log two errors forever and bury the
 *   line that means something real.
 *
 *   ABSENT is a FAULT — the read failed, the column is missing, the row was
 *   deleted, the key was misspelled. Still hidden, because an unreadable column
 *   is not evidence a feature exists, but reported loudly.
 *
 * The conservative render is still the one you get by default: every way of not
 * knowing produces an absence, and an absence is not built.
 */
export type FeatureBuildStates = ReadonlyMap<string, boolean>;

/**
 * What unlocks each grayed feature.
 *
 * Still keyed by feature, because a label is copy and copy is not a database
 * fact the way existence is. custom_retention verified against plan_features on
 * 2026-09-04: enterprise enabled, team and individual disabled.
 */
export const FEATURE_UNLOCK_LABELS: Readonly<Record<string, string>> = {
  custom_retention: 'Available on Enterprise',
};

/** The fallback when a grayed key has no specific unlock label recorded. */
export const DEFAULT_UNLOCK_LABEL = 'Not included in your plan';

/**
 * Read which features exist, once, for every key the caller will ask about.
 *
 * One query for the whole table rather than one per key: the answer is global
 * product state, not per-org, and two keys resolved from two different reads
 * could disagree about a flip that happened between them.
 *
 * ---------------------------------------------------------------------------
 * THE FAILURE FALLBACK LIVES ON THE `return EMPTY` LINES BELOW: UNBUILT/HIDDEN.
 * ---------------------------------------------------------------------------
 * An unreadable column is not evidence a feature exists. Hidden is the
 * conservative render — graying says "you could buy this", and saying that
 * about a feature we cannot confirm was ever built is exactly the false promise
 * the gray-vs-hide rule exists to prevent. Refusing to render costs a customer
 * one support ticket; a purchase promise for a 404 costs more.
 *
 * The cost of this direction is a real one and it is accepted: until the
 * BACKLOG-3098 migration is applied, this read fails and every gated card on
 * /dashboard/settings is absent, retention included. Apply the migration before
 * deploying the portal.
 */
export async function fetchFeatureBuildStates(): Promise<FeatureBuildStates> {
  const EMPTY: FeatureBuildStates = new Map<string, boolean>();

  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('feature_definitions')
      .select('key, is_built');

    if (error) {
      console.error('feature_definitions.is_built unreadable:', error);
      return EMPTY; // every feature unknown -> every OFF control hidden
    }
    if (!Array.isArray(data)) {
      console.error('feature_definitions returned no usable rows');
      return EMPTY; // every feature unknown -> every OFF control hidden
    }

    const states = new Map<string, boolean>();
    for (const row of data as { key?: unknown; is_built?: unknown }[]) {
      // `=== true`, not truthiness: a null landing in this column (a row
      // written before the NOT NULL default, a view that widens it) must read
      // as unbuilt rather than coerce to built. It is still a row we HAVE, so
      // it maps to false rather than being left absent.
      if (typeof row?.key === 'string') states.set(row.key, row.is_built === true);
    }
    return states;
  } catch (e) {
    // createClient throws outside a request scope, and PostgREST can reject
    // before it produces an `error` object.
    console.error('feature_definitions.is_built unreadable:', e);
    return EMPTY; // every feature unknown -> every OFF control hidden
  }
}

/**
 * Does this feature exist, according to the database?
 *
 * Three answers, not two, and the middle one is why this reads a map:
 *
 *   true       the row says built. Render by plan.
 *   false      the row says NOT built. Hidden, and SILENT — this is the state
 *              the migration deliberately puts scim_provisioning and
 *              jit_provisioning in, not a fault to report on every page load.
 *   no row     a fault: a misspelled key here, a deleted feature row, or a
 *              column that could not be read. Hidden, and reported LOUDLY,
 *              because neither should be discoverable only as a card that
 *              quietly stopped appearing.
 */
export function isFeatureBuilt(
  states: FeatureBuildStates,
  featureKey: string
): boolean {
  const isBuilt = states.get(featureKey);
  if (isBuilt !== undefined) return isBuilt;
  console.error(
    `Feature "${featureKey}" is not in feature_definitions — hiding its control. ` +
      'Either the row is missing or the is_built column could not be read.'
  );
  return false;
}

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
 * So `isBuilt` only decides what OFF looks like. No feature key reaches this
 * function; that is the whole point of BACKLOG-3098.
 */
export function featureRenderPolicy(
  enabled: boolean,
  isBuilt: boolean
): FeatureRenderPolicy {
  if (enabled) return 'enabled';
  return isBuilt ? 'grayed' : 'hidden';
}

/**
 * The label shown next to a grayed control.
 *
 * Returns null for anything not grayed, so a caller cannot accidentally print
 * "Available on Enterprise" beside a working control — or beside an unbuilt
 * one, which no plan can sell.
 */
export function featureUnlockLabel(
  featureKey: string,
  policy: FeatureRenderPolicy
): string | null {
  if (policy !== 'grayed') return null;
  return FEATURE_UNLOCK_LABELS[featureKey] ?? DEFAULT_UNLOCK_LABEL;
}
