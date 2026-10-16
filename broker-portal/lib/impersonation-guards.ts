/**
 * Impersonation Guards - Server-side helpers
 *
 * Provides reusable guards for:
 * 1. Checking if a request is during impersonation
 * 2. Getting a Supabase client that queries data for the target user
 * 3. Blocking write operations during impersonation sessions
 *
 * TASK-2125: Impersonation E2E Read-Only Enforcement
 * TASK-2134: Replace service-role client with scoped RLS for impersonation
 */

import { getImpersonationSession, type ImpersonationSession } from './impersonation';
import { createServiceClient } from './supabase/service';
import { createClient } from './supabase/server';
import { createScopedClient } from './scoped-client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PORTAL_MEMBERSHIP_SELECT, type PortalMembershipRow } from './auth/membership';
import { routedMembership } from './auth/routedMembership';

/**
 * Returns the appropriate Supabase client for data loading.
 *
 * During impersonation: returns a scoped client that automatically restricts
 * all queries to the target user's organization. Write operations are blocked.
 * The underlying service-role client is never exposed directly.
 *
 * Normal session: returns the standard server client with no target override.
 *
 * Also resolves the target user's organization_id during impersonation,
 * so pages don't need to look it up separately.
 */
export async function getDataClient(): Promise<{
  client: SupabaseClient;
  impersonation: ImpersonationSession | null;
  targetUserId: string | null;
  organizationId: string | null;
}> {
  const impersonation = await getImpersonationSession();

  if (impersonation) {
    const serviceClient = createServiceClient();
    const targetUserId = impersonation.target_user_id;

    // Resolve the target user's organization (needed for scoping): the one the
    // portal routes them on (BACKLOG-3851; a reverted member holds two rows).
    const { data: memberships } = await serviceClient
      .from('organization_members')
      .select(PORTAL_MEMBERSHIP_SELECT)
      .eq('user_id', targetUserId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });

    const organizationId =
      routedMembership(memberships as PortalMembershipRow[] | null, targetUserId)?.organization_id || null;

    if (!organizationId) {
      // If user has no organization, return a client that blocks everything.
      // This is a safety net -- impersonation should only target users with orgs.
      throw new Error(
        `Cannot create scoped impersonation client: target user ${targetUserId} has no organization`
      );
    }

    return {
      client: createScopedClient(serviceClient, targetUserId, organizationId),
      impersonation,
      targetUserId,
      organizationId,
    };
  }

  return {
    client: await createClient(),
    impersonation: null,
    targetUserId: null,
    organizationId: null,
  };
}

/**
 * Guard for server actions that perform write operations.
 * Call at the top of any server action that modifies data.
 *
 * Returns an error result if impersonation is active, null otherwise.
 */
export async function blockWriteDuringImpersonation(): Promise<{ error: string } | null> {
  const impersonation = await getImpersonationSession();
  if (impersonation) {
    return { error: 'Write operations are not allowed during impersonation sessions' };
  }
  return null;
}

/**
 * Extracts the target organization ID for data queries.
 *
 * During impersonation, getDataClient() resolves the target user's org.
 * Normal sessions return null (RLS handles scoping).
 *
 * Returns undefined (not null) so callers can pass it directly to
 * Supabase .eq() filters — undefined is simply ignored.
 *
 * BACKLOG-908: Deduplicated from dashboard/page.tsx, submissions/page.tsx,
 * and submissions/[id]/page.tsx which all had `organizationId || undefined`.
 */
export function getTargetOrganizationId(
  organizationId: string | null,
): string | undefined {
  return organizationId || undefined;
}
