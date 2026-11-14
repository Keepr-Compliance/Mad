/**
 * featureAccess — the pure evaluation of a plan read (`feature-gate:get-all`).
 *
 * BACKLOG-4174: extracted from `useFeatureGate` so `useFeatureGate().isAllowed`
 * and the session store's Settings reads (`useVisibleSettingsTabs`) apply ONE
 * fail-open / fail-closed rule. Kept in its own module, without React, so a
 * test that mocks `useFeatureGate` does not also replace this rule.
 */
import type { FeatureAccess, StrictFeatureKey } from "../../electron/types/featureGate";

/**
 * The renderer half of the strict key list — BACKLOG-3349.
 *
 * Typed `Record<StrictFeatureKey, true>`, so it cannot drift from the union in
 * `electron/types/featureGate.ts` or from the main-process record in
 * `electron/handlers/featureGateHandlers.ts` without failing
 * `npm run type-check`.
 *
 * Strictness is PER KEY, and that is measured rather than preferred: making
 * `isAllowed` fail closed for every key turns 7 of the 19 export-gate tests
 * red, because `text_export`, `desktop_email_attachments` and the rest depend
 * on the `?? true` below to keep working when the plan cannot be read.
 */
const STRICT_FEATURE_KEYS: Record<StrictFeatureKey, true> = {
  email_contact_inference: true,
  desktop_hide_from_export: true,
  transaction_checklists: true,
  autodetect_eval: true,
};

/**
 * The one evaluation of a plan read, shared by `useFeatureGate().isAllowed`
 * and the session store's Settings reads (BACKLOG-4174), so the fail-open /
 * fail-closed rule lives in one place.
 */
export function isFeatureAllowed(
  features: Record<string, FeatureAccess>,
  featureKey: string,
): boolean {
  const feature = features[featureKey];

  // A strict key needs a POSITIVE read. `?? true` below would grant it on
  // an empty map — which is exactly what `feature-gate:get-all` returns for
  // a user whose organization could not be resolved, and what `loadFeatures`
  // leaves behind when the invoke rejects.
  //
  // `hasOwnProperty`, not `in`: `featureKey` reaches here from callers all
  // over the renderer, and `"constructor"` is truthy through the prototype
  // chain.
  if (Object.prototype.hasOwnProperty.call(STRICT_FEATURE_KEYS, featureKey)) {
    return feature?.allowed === true;
  }

  // Default to allowed if feature is unknown (fail-open)
  return feature?.allowed ?? true;
}

