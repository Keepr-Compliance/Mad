/**
 * Feature Gate Utility - Server-side feature checking
 *
 * Uses the `broker_get_org_features` RPC to determine which features
 * an organization has access to based on their plan.
 *
 * IMPORTANT: All feature checks happen server-side in server components.
 * Never expose feature gate logic to client-side JavaScript.
 *
 * TASK-2129: Broker Portal Feature Gate Enforcement
 * BACKLOG-933: Uses broker-specific RPC that requires only authentication
 *   (not org membership), and checks JSONB error field in RPC response.
 *
 * ---------------------------------------------------------------------------
 * TWO POLICIES LIVE IN THIS FILE. PICK THE ONE THAT MATCHES THE BLAST RADIUS.
 * ---------------------------------------------------------------------------
 *
 * FAIL-OPEN  — `getOrgFeatures` + `isFeatureEnabled`
 *   An unknown key or a failed RPC ALLOWS access. Correct where the cost of a
 *   false negative is a paying customer locked out of something they bought.
 *   Callers as of BACKLOG-3087: app/dashboard/submissions/page.tsx,
 *   app/dashboard/submissions/[id]/page.tsx, components/ui/FeatureGated.tsx.
 *   Their behaviour is pinned by __tests__/lib/feature-gate.test.ts — do not
 *   "tighten" these two functions without reading it.
 *
 * FAIL-CLOSED — `isFeatureEnabledStrict` + `isFeatureEnabledFailClosed`
 *   An unknown key or a failed RPC REFUSES access. Correct where the surface
 *   promises something the backend cannot deliver, so showing it by accident
 *   costs more than hiding it by accident. First user: the SCIM settings
 *   surfaces (BACKLOG-3087) — the endpoint they hand out returns 404.
 *
 * A gate that fails open is not a gate the moment the RPC hiccups or the
 * feature row is missing, and it looks identical to a working one in any
 * happy-path test. That is the whole reason the strict pair exists.
 */

import { createClient } from '@/lib/supabase/server';

export interface OrgFeatureDetail {
  enabled: boolean;
  value: string;
  value_type: string;
  name: string;
  source: string;
}

export interface OrgFeatures {
  org_id: string;
  plan_name: string;
  plan_tier: string;
  features: Record<string, OrgFeatureDetail>;
}

/** Why a feature fetch could not be trusted. Never widened silently. */
export type FeatureFetchFailure =
  | 'rpc_error' // supabase-level error (transport, auth, function missing)
  | 'payload_error' // RPC returned its own { error: ... } JSONB
  | 'malformed_payload'; // null data, or no usable `features` object

type FeatureFetchResult =
  | { ok: true; features: OrgFeatures }
  | { ok: false; reason: FeatureFetchFailure };

/** The shape `getOrgFeatures` has always returned when it could not fetch. */
function failOpenDefault(orgId: string): OrgFeatures {
  return {
    org_id: orgId,
    plan_name: 'unknown',
    plan_tier: 'unknown',
    features: {},
  };
}

/**
 * The single place the RPC is called. Reports failure instead of deciding what
 * failure means — that decision belongs to the caller's policy.
 */
async function fetchOrgFeatures(orgId: string): Promise<FeatureFetchResult> {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc('broker_get_org_features', {
    p_org_id: orgId,
  });

  if (error) {
    console.error('Failed to fetch org features:', error);
    return { ok: false, reason: 'rpc_error' };
  }

  // The RPC reports its own errors as data, not as Supabase errors: an
  // unauthenticated caller gets { error: 'not_authenticated', features: {} }
  // with a 200. A check on `error` alone would read that as success.
  if (data && (data as { error?: unknown }).error) {
    console.error(
      'Broker feature gate RPC error:',
      (data as { error?: unknown }).error,
      'for org:',
      orgId
    );
    return { ok: false, reason: 'payload_error' };
  }

  const features = (data as OrgFeatures | null)?.features;
  if (!data || typeof features !== 'object' || features === null) {
    console.error('Broker feature gate returned no usable features for org:', orgId);
    return { ok: false, reason: 'malformed_payload' };
  }

  return { ok: true, features: data as OrgFeatures };
}

/**
 * Fetch the feature set for a given organization.
 *
 * FAIL-OPEN. Every failure path returns a default whose `features` map is
 * EMPTY, which `isFeatureEnabled` then reads as "allow". Preserved verbatim for
 * the submissions surfaces; new gates should use `isFeatureEnabledFailClosed`.
 *
 * @param orgId - The organization UUID
 * @returns The org's features, or a fail-open default if the RPC fails
 */
export async function getOrgFeatures(orgId: string): Promise<OrgFeatures> {
  const result = await fetchOrgFeatures(orgId);
  return result.ok ? result.features : failOpenDefault(orgId);
}

/**
 * Check if a specific feature is enabled for the org.
 *
 * FAIL-OPEN: an unknown key returns true.
 *
 * @param features - The org's feature set from getOrgFeatures
 * @param featureKey - The feature key to check (e.g., 'broker_text_view')
 * @returns true if the feature is enabled or unknown
 */
export function isFeatureEnabled(features: OrgFeatures, featureKey: string): boolean {
  const feature = features.features[featureKey];
  if (!feature) return true; // Unknown feature = allow (fail-open)
  return feature.enabled;
}

/**
 * FAIL-CLOSED sibling of `isFeatureEnabled`, for an already-fetched feature set.
 *
 * Returns true ONLY for a key that is present and explicitly enabled. A missing
 * key means the feature row has not been created (or has been deleted), and the
 * honest answer to "does this org have it?" is no.
 *
 * `enabled === true`, not a truthiness check: the RPC builds this field with
 * jsonb_build_object, and a non-boolean landing there must refuse rather than
 * coerce.
 */
export function isFeatureEnabledStrict(
  features: OrgFeatures | null | undefined,
  featureKey: string
): boolean {
  const feature = features?.features?.[featureKey];
  if (!feature) return false; // Unknown feature = refuse (fail-closed)
  return feature.enabled === true;
}

/**
 * Fetch + check in one call, FAIL-CLOSED on every failure mode.
 *
 * Refuses when: the RPC errors, the RPC returns its own error payload, the
 * payload is null or malformed, the key is absent, or the key is present and
 * disabled. There is no path through this function that returns true without a
 * feature row that says `enabled: true`.
 */
export async function isFeatureEnabledFailClosed(
  orgId: string,
  featureKey: string
): Promise<boolean> {
  if (!orgId) return false;

  const result = await fetchOrgFeatures(orgId);
  if (!result.ok) {
    console.error(
      `Feature "${featureKey}" refused for org ${orgId}: ${result.reason} (fail-closed)`
    );
    return false;
  }

  return isFeatureEnabledStrict(result.features, featureKey);
}

/**
 * Get the value of a specific feature flag.
 *
 * @param features - The org's feature set from getOrgFeatures
 * @param featureKey - The feature key to look up
 * @returns The feature's value string, or null if not found
 */
export function getFeatureValue(features: OrgFeatures, featureKey: string): string | null {
  const feature = features.features[featureKey];
  if (!feature) return null;
  return feature.value;
}
