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
import type { FeatureAccess } from "../../electron/types/featureGate";
import { isFeatureAllowed } from "./featureAccess";

export type { FeatureAccess } from "../../electron/types/featureGate";

// BACKLOG-4174: the evaluation, and the renderer's strict key record
// (`STRICT_FEATURE_KEYS`, `Record<StrictFeatureKey, true>`), now live in the
// pure module `./featureAccess` (no hook, never mocked with this one), so the
// Settings session reads share the exact same rule. Comments elsewhere that
// point at this file for the record mean that module.
export { isFeatureAllowed } from "./featureAccess";

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
    (featureKey: string): boolean => isFeatureAllowed(features, featureKey),
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
