/**
 * Which organizations' submissions the broker lists may show. One definition
 * for the Submissions list and the dashboard's stat cards (BACKLOG-3904), so a
 * card's number and the list it links to are scoped identically.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getOrgFeatures, isFeatureEnabledStrict, type OrgFeatures } from '@/lib/feature-gate';

/**
 * The orgs the broker lists may show, or `ok: false` when that could not be
 * established. Callers show nothing on `ok: false` (BACKLOG-3906).
 */
export type AllowedOrgIds = { ok: true; orgIds: string[] } | { ok: false };

const PORTAL_FEATURE = 'broker_portal_access';

/**
 * broker_get_org_features emits every feature_definitions key on success, and
 * broker_portal_access has a definition, so a feature set without that key is
 * a failed read (getOrgFeatures' fallback), not an answer.
 */
function portalAccess(features: OrgFeatures): boolean | null {
  if (!features.features?.[PORTAL_FEATURE]) return null;
  return isFeatureEnabledStrict(features, PORTAL_FEATURE);
}

/**
 * TASK-2158: Get the set of org IDs that have broker_portal_access enabled.
 *
 * Fetches distinct organization IDs from the submissions visible to this broker,
 * then checks each org's features to filter out those without broker_portal_access.
 *
 * During impersonation (single org), skips the distinct query and the feature
 * check and returns just that org.
 *
 * BACKLOG-3906: in broker sessions any failed read (the org list, or any org's
 * features) returns `ok: false`; it never widens the list.
 */
export async function getAllowedOrgIds(
  client: SupabaseClient,
  orgId?: string,
): Promise<AllowedOrgIds> {
  // Support sessions do not apply the broker_portal_access check: they carry
  // no Supabase login, so the feature lookup always answers not_authenticated
  // and cannot tell access from no access. Same rule as
  // lib/org-settings-access.ts (impersonationFeatureView). Full fix: BACKLOG-3922.
  if (orgId) return { ok: true, orgIds: [orgId] };

  // Normal broker session: get distinct org IDs from visible submissions
  const { data: orgRows, error } = await client
    .from('transaction_submissions')
    .select('organization_id')
    .neq('status', 'uploading');

  if (error || !orgRows) {
    console.error('Error fetching submission org IDs:', error);
    return { ok: false };
  }

  // Deduplicate org IDs
  const uniqueOrgIds = Array.from(new Set(orgRows.map((r: { organization_id: string }) => r.organization_id)));

  if (uniqueOrgIds.length === 0) {
    return { ok: true, orgIds: [] };
  }

  // Check broker_portal_access for each org in parallel
  const featureResults = await Promise.all(
    uniqueOrgIds.map(async (id) => ({ id, hasAccess: portalAccess(await getOrgFeatures(id)) }))
  );

  if (featureResults.some((r) => r.hasAccess === null)) {
    console.error('Error fetching broker_portal_access for a submission org');
    return { ok: false };
  }
  return { ok: true, orgIds: featureResults.filter((r) => r.hasAccess).map((r) => r.id) };
}
