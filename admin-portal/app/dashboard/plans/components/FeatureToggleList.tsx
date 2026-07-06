'use client';

/**
 * FeatureToggleList - Interactive feature toggle grid for a plan.
 *
 * Groups features by category, with platform sub-grouping for export/attachment keys.
 * Enforces tier constraints (greying out features above the plan's tier) and
 * feature dependencies (greying out features with unmet prerequisites).
 *
 * - Boolean features: toggle switch
 * - Integer features: number input
 * - String features: text input
 *
 * Tracks dirty state and provides a save button with confirmation.
 */

import { useState, useMemo, useCallback } from 'react';
import { Save, RotateCcw, Lock, Link2 } from 'lucide-react';
import { Card } from '@keepr/design-system';
import { updatePlanFeature, type FeatureDefinition, type PlanFeature, type FeatureDependency } from '@/lib/admin-queries';
import { ConfirmationDialog } from '@/components/shared/ConfirmationDialog';
import { TIER_LABELS } from '@/lib/plan-constants';

interface FeatureState {
  enabled: boolean;
  value: string | null;
}

interface FeatureToggleListProps {
  planId: string;
  planTier: string;
  features: PlanFeature[];
  allFeatures: FeatureDefinition[];
  dependencies: FeatureDependency[];
  canManage: boolean;
}

// Tier rank for comparison: higher number = more permissive
const TIER_RANK: Record<string, number> = {
  individual: 1,
  team: 2,
  enterprise: 3,
  custom: 4,
};

const CATEGORY_LABELS: Record<string, string> = {
  export: 'Export',
  sync: 'Sync',
  compliance: 'Compliance',
  general: 'General',
};

const CATEGORY_ORDER = ['general', 'sync', 'export', 'compliance'];

// Platform grouping for export/attachment keys
const BROKER_PORTAL_KEYS = new Set([
  'broker_text_view',
  'broker_email_view',
  'broker_text_attachments',
  'broker_email_attachments',
]);

const DESKTOP_APP_KEYS = new Set([
  'desktop_text_export',
  'desktop_email_export',
  'desktop_text_attachments',
  'desktop_email_attachments',
]);

function isPlatformKey(key: string): boolean {
  return BROKER_PORTAL_KEYS.has(key) || DESKTOP_APP_KEYS.has(key);
}

function getPlatformGroup(key: string): 'broker' | 'desktop' | null {
  if (BROKER_PORTAL_KEYS.has(key)) return 'broker';
  if (DESKTOP_APP_KEYS.has(key)) return 'desktop';
  return null;
}

/**
 * Check if a feature is tier-locked for the given plan tier.
 * Custom tier bypasses all min_tier checks.
 */
function isTierLocked(feature: FeatureDefinition, planTier: string): boolean {
  if (planTier === 'custom') return false;
  if (!feature.min_tier) return false;
  const planRank = TIER_RANK[planTier] ?? 0;
  const minRank = TIER_RANK[feature.min_tier] ?? 0;
  return planRank < minRank;
}

function computeInitialState(
  features: PlanFeature[],
  allFeatures: FeatureDefinition[],
): Record<string, FeatureState> {
  const state: Record<string, FeatureState> = {};
  for (const fd of allFeatures) {
    const pf = features.find((f) => f.feature_id === fd.id);
    state[fd.id] = {
      enabled: pf?.enabled ?? false,
      value: pf?.value ?? fd.default_value ?? null,
    };
  }
  return state;
}

export function FeatureToggleList({
  planId,
  planTier,
  features,
  allFeatures,
  dependencies,
  canManage,
}: FeatureToggleListProps) {
  const [initialState, setInitialState] = useState<Record<string, FeatureState>>(() =>
    computeInitialState(features, allFeatures),
  );
  const [featureState, setFeatureState] = useState<Record<string, FeatureState>>(() =>
    computeInitialState(features, allFeatures),
  );
  const [saving, setSaving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [depConfirm, setDepConfirm] = useState<{
    type: 'enable-deps' | 'disable-dependents';
    featureId: string;
    featureName: string;
    relatedNames: string[];
    relatedIds: string[];
  } | null>(null);

  // Build lookup maps for dependencies
  const keyToFeature = useMemo(() => {
    const map: Record<string, FeatureDefinition> = {};
    for (const fd of allFeatures) {
      map[fd.key] = fd;
    }
    return map;
  }, [allFeatures]);

  // deps: feature_key -> list of keys it depends on
  const depsOf = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const dep of dependencies) {
      if (!map[dep.feature_key]) map[dep.feature_key] = [];
      map[dep.feature_key].push(dep.depends_on_key);
    }
    return map;
  }, [dependencies]);

  // reverseDeps: feature_key -> list of keys that depend on it
  const dependentsOf = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const dep of dependencies) {
      if (!map[dep.depends_on_key]) map[dep.depends_on_key] = [];
      map[dep.depends_on_key].push(dep.feature_key);
    }
    return map;
  }, [dependencies]);

  /**
   * Check if a feature has unmet dependencies (some required features are not enabled).
   */
  const getUnmetDeps = useCallback(
    (featureKey: string): FeatureDefinition[] => {
      const depKeys = depsOf[featureKey];
      if (!depKeys) return [];
      return depKeys
        .map((key) => keyToFeature[key])
        .filter((fd) => fd && !featureState[fd.id]?.enabled);
    },
    [depsOf, keyToFeature, featureState],
  );

  /**
   * Check which enabled features depend on a given feature.
   */
  const getEnabledDependents = useCallback(
    (featureKey: string): FeatureDefinition[] => {
      const depKeys = dependentsOf[featureKey];
      if (!depKeys) return [];
      return depKeys
        .map((key) => keyToFeature[key])
        .filter((fd) => fd && featureState[fd.id]?.enabled);
    },
    [dependentsOf, keyToFeature, featureState],
  );

  // Group features by category, with platform sub-grouping
  const grouped = useMemo(() => {
    const groups: Record<string, FeatureDefinition[]> = {};
    for (const fd of allFeatures) {
      const cat = fd.category || 'general';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(fd);
    }
    return groups;
  }, [allFeatures]);

  const sortedCategories = useMemo(() => {
    const keys = Object.keys(grouped);
    return keys.sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a);
      const bi = CATEGORY_ORDER.indexOf(b);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
  }, [grouped]);

  const isDirty = useMemo(() => {
    for (const fdId of Object.keys(featureState)) {
      const current = featureState[fdId];
      const initial = initialState[fdId];
      if (!initial) continue;
      if (current.enabled !== initial.enabled || current.value !== initial.value) {
        return true;
      }
    }
    return false;
  }, [featureState, initialState]);

  const handleToggle = useCallback(
    (featureId: string) => {
      const fd = allFeatures.find((f) => f.id === featureId);
      if (!fd) return;

      const currentlyEnabled = featureState[featureId]?.enabled ?? false;

      if (!currentlyEnabled) {
        // Enabling: check dependencies
        const unmetDeps = getUnmetDeps(fd.key);
        if (unmetDeps.length > 0) {
          setDepConfirm({
            type: 'enable-deps',
            featureId,
            featureName: fd.name,
            relatedNames: unmetDeps.map((d) => d.name),
            relatedIds: unmetDeps.map((d) => d.id),
          });
          return;
        }
      } else {
        // Disabling: check dependents
        const enabledDependents = getEnabledDependents(fd.key);
        if (enabledDependents.length > 0) {
          setDepConfirm({
            type: 'disable-dependents',
            featureId,
            featureName: fd.name,
            relatedNames: enabledDependents.map((d) => d.name),
            relatedIds: enabledDependents.map((d) => d.id),
          });
          return;
        }
      }

      setFeatureState((prev) => ({
        ...prev,
        [featureId]: { ...prev[featureId], enabled: !prev[featureId].enabled },
      }));
      setSaveSuccess(false);
    },
    [allFeatures, featureState, getUnmetDeps, getEnabledDependents],
  );

  const handleDepConfirm = useCallback(() => {
    if (!depConfirm) return;

    if (depConfirm.type === 'enable-deps') {
      // Enable the feature AND all its unmet dependencies
      setFeatureState((prev) => {
        const updated = { ...prev };
        // Enable dependencies first
        for (const depId of depConfirm.relatedIds) {
          updated[depId] = { ...updated[depId], enabled: true };
        }
        // Enable the target feature
        updated[depConfirm.featureId] = { ...updated[depConfirm.featureId], enabled: true };
        return updated;
      });
    } else {
      // Disable the feature AND all its dependents
      setFeatureState((prev) => {
        const updated = { ...prev };
        // Disable dependents first
        for (const depId of depConfirm.relatedIds) {
          updated[depId] = { ...updated[depId], enabled: false };
        }
        // Disable the target feature
        updated[depConfirm.featureId] = { ...updated[depConfirm.featureId], enabled: false };
        return updated;
      });
    }

    setSaveSuccess(false);
    setDepConfirm(null);
  }, [depConfirm]);

  const handleToggleCategory = useCallback(
    (categoryFeatures: FeatureDefinition[]) => {
      setFeatureState((prev) => {
        const toggleable = categoryFeatures.filter((fd) => !isTierLocked(fd, planTier));
        const allEnabled = toggleable.every((fd) => prev[fd.id]?.enabled);
        const updated = { ...prev };
        for (const fd of toggleable) {
          updated[fd.id] = { ...updated[fd.id], enabled: !allEnabled };
        }
        return updated;
      });
      setSaveSuccess(false);
    },
    [planTier],
  );

  const handleValueChange = useCallback((featureId: string, value: string) => {
    setFeatureState((prev) => ({
      ...prev,
      [featureId]: { ...prev[featureId], value },
    }));
    setSaveSuccess(false);
  }, []);

  const handleReset = useCallback(() => {
    setFeatureState(initialState);
    setSaveError(null);
    setSaveSuccess(false);
  }, [initialState]);

  /**
   * Topologically sort feature IDs based on dependency graph.
   * Returns IDs in dependency-first order: if A depends on B, B comes before A.
   */
  const topologicalSort = useCallback(
    (featureIds: string[]): string[] => {
      // Build adjacency: for each feature ID, which IDs must come before it?
      const idToKey: Record<string, string> = {};
      const keyToId: Record<string, string> = {};
      for (const fd of allFeatures) {
        idToKey[fd.id] = fd.key;
        keyToId[fd.key] = fd.id;
      }

      const idSet = new Set(featureIds);
      const inDegree: Record<string, number> = {};
      const graph: Record<string, string[]> = {};

      for (const id of featureIds) {
        inDegree[id] = 0;
        graph[id] = [];
      }

      // For each feature in our set, add edges from its dependencies (also in set)
      for (const id of featureIds) {
        const key = idToKey[id];
        if (!key) continue;
        const depKeys = depsOf[key];
        if (!depKeys) continue;
        for (const depKey of depKeys) {
          const depId = keyToId[depKey];
          if (depId && idSet.has(depId)) {
            // depId must come before id
            graph[depId].push(id);
            inDegree[id] = (inDegree[id] || 0) + 1;
          }
        }
      }

      // Kahn's algorithm
      const queue: string[] = [];
      for (const id of featureIds) {
        if (inDegree[id] === 0) queue.push(id);
      }

      const sorted: string[] = [];
      while (queue.length > 0) {
        const current = queue.shift()!;
        sorted.push(current);
        for (const neighbor of graph[current]) {
          inDegree[neighbor]--;
          if (inDegree[neighbor] === 0) queue.push(neighbor);
        }
      }

      // If cycle detected (sorted shorter than input), append remaining in original order
      if (sorted.length < featureIds.length) {
        const sortedSet = new Set(sorted);
        for (const id of featureIds) {
          if (!sortedSet.has(id)) sorted.push(id);
        }
      }

      return sorted;
    },
    [allFeatures, depsOf],
  );

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setShowConfirm(false);

    const enables: { featureId: string; enabled: boolean; value: string | null }[] = [];
    const disables: { featureId: string; enabled: boolean; value: string | null }[] = [];
    const valueOnly: { featureId: string; enabled: boolean; value: string | null }[] = [];

    for (const fdId of Object.keys(featureState)) {
      const current = featureState[fdId];
      const initial = initialState[fdId];
      if (!initial) continue;
      if (current.enabled !== initial.enabled || current.value !== initial.value) {
        if (current.enabled && !initial.enabled) {
          enables.push({ featureId: fdId, enabled: current.enabled, value: current.value });
        } else if (!current.enabled && initial.enabled) {
          disables.push({ featureId: fdId, enabled: current.enabled, value: current.value });
        } else {
          // Value-only change (enabled state unchanged)
          valueOnly.push({ featureId: fdId, enabled: current.enabled, value: current.value });
        }
      }
    }

    // Sort enables in dependency-first order (topological: dependencies before dependents)
    const enableOrder = topologicalSort(enables.map((e) => e.featureId));
    const enableMap = new Map(enables.map((e) => [e.featureId, e]));
    const sortedEnables = enableOrder.map((id) => enableMap.get(id)!);

    // Sort disables in dependent-first order (reverse topological: dependents before dependencies)
    const disableOrder = topologicalSort(disables.map((d) => d.featureId));
    const disableMap = new Map(disables.map((d) => [d.featureId, d]));
    const sortedDisables = disableOrder.map((id) => disableMap.get(id)!).reverse();

    // Process in safe order: disables first (dependents before deps),
    // then enables (deps before dependents), then value-only changes
    const orderedChanges = [...sortedDisables, ...sortedEnables, ...valueOnly];

    for (const change of orderedChanges) {
      const result = await updatePlanFeature(planId, change.featureId, change.enabled, change.value);
      if (result.error) {
        setSaveError(`Failed to update feature: ${result.error.message}`);
        setSaving(false);
        return;
      }
    }

    setInitialState({ ...featureState });
    setSaving(false);
    setSaveSuccess(true);
  };

  /**
   * Render a single feature row with tier lock and dependency indicators.
   */
  const renderFeatureRow = (fd: FeatureDefinition) => {
    const state = featureState[fd.id];
    if (!state) return null;

    const tierLocked = isTierLocked(fd, planTier);
    const unmetDeps = getUnmetDeps(fd.key);
    const hasUnmetDeps = unmetDeps.length > 0 && !state.enabled;
    // Also lock if any unmet dependency is itself tier-locked (can never be enabled on this tier)
    const depsAreTierLocked = hasUnmetDeps && unmetDeps.some((dep) => isTierLocked(dep, planTier));
    const isLocked = tierLocked || depsAreTierLocked;

    // Build tooltip text
    let tooltip = '';
    if (tierLocked) {
      tooltip = `Requires ${TIER_LABELS[fd.min_tier!] ?? fd.min_tier} tier or higher`;
    } else if (depsAreTierLocked) {
      const lockedDeps = unmetDeps.filter((dep) => isTierLocked(dep, planTier));
      tooltip = `Blocked: ${lockedDeps.map((d) => d.name).join(', ')} requires a higher tier`;
    } else if (hasUnmetDeps) {
      tooltip = `Requires ${unmetDeps.map((d) => d.name).join(', ')} to be enabled first`;
    }

    return (
      <div
        key={fd.id}
        className={`px-6 py-4 flex items-center justify-between gap-4 ${
          isLocked ? 'opacity-50 bg-gray-50' : ''
        }`}
        title={tooltip || undefined}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-gray-900">{fd.name}</p>
            {tierLocked && (
              <span className="inline-flex items-center gap-1 text-xs text-gray-500" title={tooltip}>
                <Lock className="h-3 w-3" />
                <span>{TIER_LABELS[fd.min_tier!] ?? fd.min_tier}+</span>
              </span>
            )}
            {depsAreTierLocked && !tierLocked && (
              <span className="inline-flex items-center gap-1 text-xs text-gray-500" title={tooltip}>
                <Lock className="h-3 w-3" />
                <span>Blocked by tier</span>
              </span>
            )}
            {hasUnmetDeps && !tierLocked && !depsAreTierLocked && (
              <span className="inline-flex items-center gap-1 text-xs text-amber-600" title={tooltip}>
                <Link2 className="h-3 w-3" />
                <span>Requires {unmetDeps.map((d) => d.name).join(', ')}</span>
              </span>
            )}
          </div>
          {fd.description && (
            <p className="text-xs text-gray-500 mt-0.5">{fd.description}</p>
          )}
          <p className="text-xs text-gray-400 mt-0.5 font-mono">{fd.key}</p>
        </div>

        <div className="flex items-center gap-4 shrink-0">
          {/* Value input for non-boolean types */}
          {fd.value_type === 'integer' && (
            <input
              type="number"
              value={state.value ?? ''}
              onChange={(e) => handleValueChange(fd.id, e.target.value)}
              disabled={!canManage || !state.enabled || isLocked}
              className="w-24 rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-900 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 disabled:opacity-50 disabled:bg-gray-50"
            />
          )}
          {fd.value_type === 'string' && (
            <input
              type="text"
              value={state.value ?? ''}
              onChange={(e) => handleValueChange(fd.id, e.target.value)}
              disabled={!canManage || !state.enabled || isLocked}
              className="w-32 rounded-md border border-gray-300 px-2 py-1 text-sm text-gray-900 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 disabled:opacity-50 disabled:bg-gray-50"
            />
          )}

          {/* Toggle switch */}
          <button
            type="button"
            role="switch"
            aria-checked={state.enabled}
            onClick={() => handleToggle(fd.id)}
            disabled={!canManage || isLocked}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${
              state.enabled ? 'bg-primary-600' : 'bg-gray-200'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                state.enabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>
    );
  };

  /**
   * Render a category section, potentially splitting platform-grouped features.
   */
  const renderCategorySection = (category: string) => {
    const categoryFeatures = grouped[category];
    if (!categoryFeatures) return null;

    // Split features into platform groups and regular features
    const platformFeatures = categoryFeatures.filter((fd) => isPlatformKey(fd.key));
    const regularFeatures = categoryFeatures.filter((fd) => !isPlatformKey(fd.key));

    const hasPlatformGroups = platformFeatures.length > 0;
    const brokerFeatures = platformFeatures.filter((fd) => getPlatformGroup(fd.key) === 'broker');
    const desktopFeatures = platformFeatures.filter((fd) => getPlatformGroup(fd.key) === 'desktop');

    const toggleableFeatures = categoryFeatures.filter((fd) => !isTierLocked(fd, planTier));

    return (
      <Card key={category} padding="none">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider">
            {CATEGORY_LABELS[category] ?? category}
          </h3>
          {canManage && toggleableFeatures.length > 0 && (
            <button
              onClick={() => handleToggleCategory(categoryFeatures)}
              className="text-xs font-medium text-primary-600 hover:text-primary-700 transition-colors"
            >
              {toggleableFeatures.every((fd) => featureState[fd.id]?.enabled) ? 'Deselect All' : 'Select All'}
            </button>
          )}
        </div>

        {/* Regular features */}
        {regularFeatures.length > 0 && (
          <div className="divide-y divide-gray-100">
            {regularFeatures.map(renderFeatureRow)}
          </div>
        )}

        {/* Platform-grouped features */}
        {hasPlatformGroups && (
          <>
            {brokerFeatures.length > 0 && (
              <>
                <div className="px-6 py-2 bg-gray-50 border-t border-gray-200">
                  <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wider">
                    Broker Portal
                  </h4>
                </div>
                <div className="divide-y divide-gray-100">
                  {brokerFeatures.map(renderFeatureRow)}
                </div>
              </>
            )}
            {desktopFeatures.length > 0 && (
              <>
                <div className="px-6 py-2 bg-gray-50 border-t border-gray-200">
                  <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wider">
                    Desktop App
                  </h4>
                </div>
                <div className="divide-y divide-gray-100">
                  {desktopFeatures.map(renderFeatureRow)}
                </div>
              </>
            )}
          </>
        )}
      </Card>
    );
  };

  return (
    <div className="space-y-6">
      {/* Save bar */}
      {canManage && (
        <Card padding="none" className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            {isDirty && (
              <span className="text-sm text-amber-600 font-medium">Unsaved changes</span>
            )}
            {saveSuccess && !isDirty && (
              <span className="text-sm text-green-600 font-medium">Changes saved</span>
            )}
            {saveError && (
              <span className="text-sm text-red-600">{saveError}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isDirty && (
              <button
                onClick={handleReset}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                <RotateCcw className="h-4 w-4" />
                Reset
              </button>
            )}
            <button
              onClick={() => setShowConfirm(true)}
              disabled={!isDirty || saving}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Save className="h-4 w-4" />
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </Card>
      )}

      {/* Feature groups */}
      {sortedCategories.map(renderCategorySection)}

      {allFeatures.length === 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
          <p className="text-gray-500 text-sm">No features defined yet.</p>
        </div>
      )}

      {/* Save confirmation dialog */}
      {showConfirm && (
        <ConfirmationDialog
          title="Save Feature Changes"
          description="Are you sure you want to save these feature configuration changes? This will immediately affect organizations on this plan."
          confirmLabel="Save Changes"
          onConfirm={handleSave}
          onCancel={() => setShowConfirm(false)}
          isLoading={saving}
        />
      )}

      {/* Dependency confirmation dialog */}
      {depConfirm && (
        <ConfirmationDialog
          title={
            depConfirm.type === 'enable-deps'
              ? 'Enable Required Dependencies'
              : 'Disable Dependent Features'
          }
          description={
            depConfirm.type === 'enable-deps'
              ? `"${depConfirm.featureName}" requires the following features to be enabled first. Enable them all?`
              : `Disabling "${depConfirm.featureName}" will also disable the following features that depend on it:`
          }
          confirmLabel={
            depConfirm.type === 'enable-deps' ? 'Enable All' : 'Disable All'
          }
          onConfirm={handleDepConfirm}
          onCancel={() => setDepConfirm(null)}
          isDestructive={depConfirm.type === 'disable-dependents'}
        >
          <ul className="mt-2 space-y-1">
            {depConfirm.relatedNames.map((name) => (
              <li key={name} className="text-sm text-gray-700 flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-gray-400 shrink-0" />
                {name}
              </li>
            ))}
          </ul>
        </ConfirmationDialog>
      )}
    </div>
  );
}
