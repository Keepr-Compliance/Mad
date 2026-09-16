/**
 * useFeatureGate Hook
 * SPRINT-122: Plan Admin + Feature Gate Enforcement
 *
 * Provides feature access checks in the renderer process.
 * Loads all features on mount and provides an isAllowed() helper.
 *
 * Design:
 * - Fetches all features once on mount
 * - Defaults to allowed for unknown features (fail-open)
 * - Loading state prevents blocking UI
 *
 * @example
 * ```tsx
 * const { isAllowed, loading } = useFeatureGate();
 *
 * if (!loading && !isAllowed("text_export")) {
 *   return <UpgradePrompt featureName="Text Export" />;
 * }
 * ```
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { FeatureAccess, StrictFeatureKey } from "../../electron/types/featureGate";

export type { FeatureAccess } from "../../electron/types/featureGate";

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
};

interface UseFeatureGateReturn {
  /** Check if a feature is allowed. Returns true for unknown features (fail-open). */
  isAllowed: (featureKey: string) => boolean;
  /** All loaded features */
  features: Record<string, FeatureAccess>;
  /** True while features are being loaded for the first time */
  loading: boolean;
  /** True after features have been loaded at least once */
  hasInitialized: boolean;
  /** Refresh features from the server */
  refresh: () => Promise<void>;
}

export function useFeatureGate(): UseFeatureGateReturn {
  const [features, setFeatures] = useState<Record<string, FeatureAccess>>({});
  const [loading, setLoading] = useState(true);
  const hasInitializedRef = useRef(false);
  const [hasInitialized, setHasInitialized] = useState(false);

  const loadFeatures = useCallback(async () => {
    try {
      const result = await window.api.featureGate.getAll();
      setFeatures(result);
    } catch {
      // On error, keep empty features (fail-open: everything allowed)
    } finally {
      setLoading(false);
      if (!hasInitializedRef.current) {
        hasInitializedRef.current = true;
        setHasInitialized(true);
      }
    }
  }, []);

  useEffect(() => {
    loadFeatures();
  }, [loadFeatures]);

  const refresh = useCallback(async () => {
    // Don't set loading=true during refresh to avoid hiding already-visible content.
    // Features stay visible with stale data while refresh completes (no flicker).
    await window.api.featureGate.invalidateCache();
    await loadFeatures();
  }, [loadFeatures]);

  const isAllowed = useCallback(
    (featureKey: string): boolean => {
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
    },
    [features]
  );

  return useMemo(
    () => ({
      isAllowed,
      features,
      loading,
      hasInitialized,
      refresh,
    }),
    [isAllowed, features, loading, hasInitialized, refresh]
  );
}

export default useFeatureGate;
