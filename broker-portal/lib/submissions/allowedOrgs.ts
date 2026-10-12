/**
 * Which organizations' submissions the broker lists may show. One definition
 * for the Submissions list and the dashboard's stat cards (BACKLOG-3904), so a
 * card's number and the list it links to are scoped identically.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getOrgFeatures, isFeatureEnabled } from '@/lib/feature-gate';

/**
 * TASK-2158: Get the set of org IDs that have broker_portal_access enabled.
 *
 * Fetches distinct organization IDs from the submissions visible to this broker,
 * then checks each org's features to filter out those without broker_portal_access.
 *
 * During impersonation (single org), skips the distinct query and checks just that org.
 */
export async function getAllowedOrgIds(
  client: SupabaseClient,
  orgId?: string,
): Promise<string[] | null> {
  // During impersonation, check the single org
  if (orgId) {
    const features = await getOrgFeatures(orgId);
    const hasAccess = isFeatureEnabled(features, 'broker_portal_access');
    return hasAccess ? [orgId] : [];
  }

  // Normal broker session: get distinct org IDs from visible submissions
  const { data: orgRows, error } = await client
    .from('transaction_submissions')
    .select('organization_id')
    .neq('status', 'uploading');

  if (error || !orgRows) {
    console.error('Error fetching submission org IDs:', error);
    // Fail-open: return null to skip filtering
    return null;
  }

  // Deduplicate org IDs
  const uniqueOrgIds = Array.from(new Set(orgRows.map((r: { organization_id: string }) => r.organization_id)));

  if (uniqueOrgIds.length === 0) {
    return [];
  }

  // Check broker_portal_access for each org in parallel
  const featureResults = await Promise.all(
    uniqueOrgIds.map(async (id) => {
      const features = await getOrgFeatures(id);
      return { id, hasAccess: isFeatureEnabled(features, 'broker_portal_access') };
    })
  );

  return featureResults.filter((r) => r.hasAccess).map((r) => r.id);
}
