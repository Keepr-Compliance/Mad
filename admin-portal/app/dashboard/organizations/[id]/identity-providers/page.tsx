import { getAuthenticatedUser, createServiceClient } from '@/lib/supabase/server';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Building2 } from 'lucide-react';
import { Card } from '@keepr/design-system';
import {
  listIdentityProviders,
  getActiveScimToken,
  getDirectorySyncStatus,
  getSyncHistory,
  getScimEndpointUrl,
  extractGroupRoleMapping,
} from '@/lib/idp';
import { IdpManager } from './components/IdpManager';

export const dynamic = 'force-dynamic';

/**
 * Identity Providers Page - Admin Portal
 *
 * Server component that loads identity provider configurations for an org,
 * plus SCIM token status, directory sync status, and sync history.
 * Delegates all CRUD to the IdpManager client component which uses server actions.
 */
export default async function IdentityProvidersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { supabase, user: adminUser } = await getAuthenticatedUser();

  if (!adminUser) {
    redirect('/login');
  }

  const { data: internalRole } = await supabase
    .from('internal_roles')
    .select('role_id')
    .eq('user_id', adminUser.id)
    .single();

  if (!internalRole) {
    redirect('/login?error=not_authorized');
  }

  // Defense-in-depth: verify page-level permission
  const { data: hasPerm } = await supabase.rpc('has_permission', {
    check_user_id: adminUser.id,
    required_permission: 'organizations.view',
  });
  if (!hasPerm) {
    redirect('/dashboard?error=insufficient_permissions');
  }

  // Fetch org details (use service client to ensure we get tenant/domain columns)
  const serviceClient = createServiceClient();
  const { data: org } = await serviceClient
    .from('organizations')
    .select('id, name, slug, microsoft_tenant_id, google_workspace_domain')
    .eq('id', id)
    .single();

  if (!org) {
    notFound();
  }

  // Parallel data fetches for the management panels
  const [
    { data: providers, error },
    { data: scimToken },
    { data: syncStatus },
    { data: syncHistory, total: syncHistoryTotal },
  ] = await Promise.all([
    listIdentityProviders(id),
    getActiveScimToken(id),
    getDirectorySyncStatus(id),
    getSyncHistory(id, 20, 0),
  ]);

  if (error) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <Link
          href={`/dashboard/organizations/${id}`}
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to {org.name}
        </Link>
        <div className="bg-white rounded-lg shadow-sm border border-red-200 p-8 text-center">
          <p className="text-red-600 text-sm">Failed to load identity providers: {error}</p>
        </div>
      </div>
    );
  }

  // Extract group role mapping from the first active provider (if any)
  const activeProvider = (providers ?? []).find((p) => p.is_active) ?? (providers ?? [])[0];
  const groupRoleMapping = activeProvider
    ? extractGroupRoleMapping(activeProvider.attribute_mapping)
    : { group_role_mapping: {}, default_role: 'agent', group_sync_enabled: false };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Back navigation */}
      <Link
        href={`/dashboard/organizations/${id}`}
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to {org.name}
      </Link>

      {/* Organization header */}
      <Card>
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-lg bg-primary-100 text-primary-700 flex items-center justify-center">
            <Building2 className="h-6 w-6" />
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-gray-900">{org.name}</h1>
            <p className="text-sm text-gray-500 mt-0.5">Identity Provider Configuration</p>
          </div>
        </div>

        {/* Current org-level SSO info */}
        <div className="mt-4 grid grid-cols-2 gap-4">
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">
              Azure AD Tenant ID
            </dt>
            <dd className="mt-1 text-sm text-gray-900">
              {org.microsoft_tenant_id || 'Not configured'}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">
              Google Workspace Domain
            </dt>
            <dd className="mt-1 text-sm text-gray-900">
              {org.google_workspace_domain || 'Not configured'}
            </dd>
          </div>
        </div>
      </Card>

      {/* IdP Manager (client component) */}
      <IdpManager
        organizationId={id}
        initialProviders={providers ?? []}
        orgTenantId={org.microsoft_tenant_id ?? null}
        orgWorkspaceDomain={org.google_workspace_domain ?? null}
        scimEndpointUrl={getScimEndpointUrl()}
        initialScimToken={scimToken ?? null}
        initialSyncStatus={syncStatus ?? {
          directory_sync_enabled: false,
          directory_sync_last_at: null,
          directory_sync_error: null,
        }}
        initialGroupRoleMapping={groupRoleMapping}
        activeIdpId={activeProvider?.id ?? null}
        initialSyncHistory={syncHistory}
        syncHistoryTotal={syncHistoryTotal}
      />
    </div>
  );
}
