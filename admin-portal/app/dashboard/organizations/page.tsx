import { getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { PageHeader } from '@keepr/design-system';
import { OrganizationsTable, type OrganizationRow } from './components/OrganizationsTable';
import { billingLiveForNewOrg } from '@/lib/billing/dealRules';
import { parseOrgListState } from '@/lib/organizations/org-list';

export const dynamic = 'force-dynamic';

/**
 * Organizations List Page - Admin Portal
 *
 * Server component that fetches all organizations with member counts.
 * Uses existing admin RLS policies for cross-org read access.
 */
type OrganizationsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/** A boolean flag from the RPC row, or null when the key is missing or not a boolean. */
function rowFlag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

// Props are required by Next's page type check (an optional first argument fails it once
// .next/types exists). `props?.` keeps a bare Page() call (tests) from throwing.
export default async function OrganizationsPage(props: OrganizationsPageProps) {
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

  // BACKLOG-4007: Create Organization asks for Max Seats only while brokerage billing is off.
  // Same switch as the org page's Billing card; a failed read counts as off.
  const billingLive = canEdit
    ? billingLiveForNewOrg(await supabase.rpc('admin_get_brokerage_billing_live'))
    : false;

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
    is_personal: rowFlag(org.is_personal),
    is_test: rowFlag(org.is_test),
  }));

  // BACKLOG-4098: filters, search and sort come from the URL so a reload or a shared link
  // shows the same list. The "shown of total" count lives in the table (client state).
  const initialState = parseOrgListState((await props?.searchParams) ?? {});

  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader title="Organizations" />

      <OrganizationsTable
        organizations={organizations}
        canEdit={!!canEdit}
        billingLive={billingLive}
        initialState={initialState}
      />
    </div>
  );
}
