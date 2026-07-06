import { getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { PageHeader } from '@keepr/design-system';
import { OrganizationsTable, type OrganizationRow } from './components/OrganizationsTable';

export const dynamic = 'force-dynamic';

/**
 * Organizations List Page - Admin Portal
 *
 * Server component that fetches all organizations with member counts.
 * Uses existing admin RLS policies for cross-org read access.
 */
export default async function OrganizationsPage() {
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

  // Check if admin has organizations.edit permission
  const { data: canEdit } = await supabase.rpc('has_permission', {
    check_user_id: adminUser.id,
    required_permission: 'organizations.edit',
  });

  // Fetch all organizations via SECURITY DEFINER RPC (bypasses RLS join issues)
  const { data: rpcResult, error } = await supabase.rpc('admin_list_organizations');

  if (error || !rpcResult?.success) {
    return (
      <div className="max-w-7xl mx-auto">
        <PageHeader title="Organizations" />
        <div className="bg-white rounded-lg shadow-sm border border-danger-500/20 p-8 text-center">
          <p className="text-danger-600 text-sm">Failed to load organizations: {error?.message || rpcResult?.error}</p>
        </div>
      </div>
    );
  }

  const organizations: OrganizationRow[] = ((rpcResult.organizations as Array<Record<string, unknown>>) ?? []).map((org) => ({
    id: org.id as string,
    name: org.name as string,
    slug: org.slug as string,
    plan_name: (org.plan_name as string) ?? null,
    plan_tier: (org.plan_tier as string) ?? null,
    created_at: org.created_at as string,
    member_count: (org.member_count as number) ?? 0,
  }));

  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader
        title="Organizations"
        subtitle={<>{organizations.length} organization{organizations.length !== 1 ? 's' : ''} total</>}
      />

      <OrganizationsTable organizations={organizations} canEdit={!!canEdit} />
    </div>
  );
}
