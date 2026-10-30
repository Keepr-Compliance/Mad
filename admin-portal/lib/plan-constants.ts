/**
 * Shared plan-related constants used across plan management components.
 */

/** Human-readable tier labels keyed by internal tier slug. */
export const TIER_LABELS: Record<string, string> = {
  individual: 'Individual',
  team: 'Team',
  enterprise: 'Enterprise',
  custom: 'Custom',
};

/**
 * Feature keys the plan editor never offers. `account_suspended` is a read-only signal written
 * per organization by the brokerage billing engine; a plan-level toggle would mark every
 * organization on that plan as suspended.
 */
export const PLAN_EDITOR_HIDDEN_FEATURE_KEYS: readonly string[] = ['account_suspended'];

/** Drops feature definitions the plan editor must not offer. */
export function withoutPlanEditorHiddenFeatures<T extends { key: string }>(defs: T[]): T[] {
  return defs.filter((d) => !PLAN_EDITOR_HIDDEN_FEATURE_KEYS.includes(d.key));
}

/** Same filter for plan_features rows, which carry their definition. */
export function withoutPlanEditorHiddenPlanFeatures<T extends { feature_definitions?: { key: string } | null }>(
  rows: T[],
): T[] {
  return rows.filter((r) => !r.feature_definitions || !PLAN_EDITOR_HIDDEN_FEATURE_KEYS.includes(r.feature_definitions.key));
}
