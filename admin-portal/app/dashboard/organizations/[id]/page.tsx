import { getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Building2, Shield, Users } from 'lucide-react';
import { Card } from '@keepr/design-system';
import { MembersTable, type MemberRow } from './components/MembersTable';
import { PendingInvitationsTable, type PendingInvitationRow } from './components/PendingInvitationsTable';
import { PlanAssignment } from './components/PlanAssignment';
import { BrokerageBillingCard } from './components/BrokerageBillingCard';
import { OrgInviteButton } from './components/OrgInviteButton';
import { OrgPeopleCard } from './components/OrgPeopleCard';
import { shouldShowBillingCard, type OrgBilling } from '@/lib/billing/dealRules';
import { formatDate } from '@/lib/format';
import { pickOrgPlanRow, type OrgPlanEmbed } from '@/lib/orgPlanEmbed';

export const dynamic = 'force-dynamic';

/**
 * Organization Detail Page - Admin Portal
 *
 * Server component that loads organization details and members.
 * Uses existing admin RLS policies for cross-org read access.
 */
export default async function OrganizationDetailPage({
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

  // Check if user can manage plans
  const { data: canManagePlans } = await supabase.rpc('has_permission', {
    check_user_id: adminUser.id,
    required_permission: 'plans.manage',
  });

  // BACKLOG-4007: Invite on this page needs the same permission as the Users page invite.
  const { data: canInvite } = await supabase.rpc('has_permission', {
    check_user_id: adminUser.id,
    required_permission: 'users.edit',
  });

  // BACKLOG-3853 PR-2A: the brokerage Billing card. billing.view gates the read
  // (admin_get_org_billing refuses without it); the card renders only while
  // brokerage billing is switched on or the organization is a test organization.
  const { data: canViewBilling } = await supabase.rpc('has_permission', {
    check_user_id: adminUser.id,
    required_permission: 'billing.view',
  });
  let billing: OrgBilling | null = null;
  if (canViewBilling) {
    const { data: billingData } = await supabase.rpc('admin_get_org_billing', { p_org: id });
    billing = (billingData as OrgBilling | null) ?? null;
  }

  // Fetch org details, members, and pending invitations in parallel
  const [orgResult, membersResult, pendingResult] = await Promise.all([
    supabase
      .from('organizations')
      .select('id, name, slug, max_seats, created_at, organization_plans(plan_id, plans(id, name, tier))')
      .eq('id', id)
      .single(),
    supabase
      .from('organization_members')
      .select('user_id, role, license_status, joined_at, users(id, email, display_name, status, suspended_at)')
      .eq('organization_id', id)
      .not('user_id', 'is', null)
      .order('joined_at', { ascending: false }),
    supabase
      .from('organization_members')
      .select('id, invited_email, role, license_status, invited_at, invitation_expires_at')
      .eq('organization_id', id)
      .is('user_id', null)
      .not('invited_email', 'is', null)
      .order('invited_at', { ascending: false }),
  ]);

  if (!orgResult.data) {
    notFound();
  }

  const org = orgResult.data;

  // Extract plan from the organization_plans embed (object or array, see lib/orgPlanEmbed.ts)
  const activePlan = pickOrgPlanRow(org.organization_plans as unknown as OrgPlanEmbed)?.plans ?? null;
  const planName = activePlan?.name ?? 'None';

  // Transform members to include user info
  const members: MemberRow[] = (membersResult.data ?? []).map((m) => {
    const user = m.users as unknown as { id: string; email: string | null; display_name: string | null; status: string | null; suspended_at: string | null } | null;
    return {
      user_id: m.user_id ?? user?.id ?? '',
      display_name: user?.display_name ?? null,
      email: user?.email ?? null,
      role: m.role,
      license_status: m.license_status,
      joined_at: m.joined_at,
      status: user?.status ?? null,
    };
  });

  // Transform pending invitations
  const pendingInvitations: PendingInvitationRow[] = (pendingResult.data ?? []).map((p) => ({
    id: p.id,
    invited_email: p.invited_email!,
    role: p.role,
    invited_at: p.invited_at,
    invitation_expires_at: p.invitation_expires_at,
  }));

  // BACKLOG-4022: one Invite button, rendered in the header, the Members heading row and the
  // empty state. Same props everywhere, so the same rules (billing card, deal, users.edit) hold.
  const inviteButton = (
    <OrgInviteButton
      organizationId={org.id}
      organizationName={org.name}
      canInvite={!!canInvite}
      canViewBilling={!!canViewBilling}
      hasDeal={!!billing?.deal}
      showBillingCard={shouldShowBillingCard(billing)}
      isFirstInvite={members.length === 0 && pendingInvitations.length === 0}
    />
  );

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Back navigation */}
      <Link
        href="/dashboard/organizations"
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Organizations
      </Link>

      {/* Organization header card */}
      <Card>
        <div className="flex items-start gap-4 max-md:flex-wrap">
          <div className="h-12 w-12 rounded-lg bg-primary-100 text-primary-700 flex items-center justify-center">
            <Building2 className="h-6 w-6" />
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-gray-900">{org.name}</h1>
            <p className="text-sm text-gray-500 mt-0.5">{org.slug}</p>
          </div>
          {inviteButton}
        </div>

        <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Plan</dt>
            <dd className="mt-1 text-sm text-gray-900">{planName}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Max Seats</dt>
            <dd className="mt-1 text-sm text-gray-900">{org.max_seats ?? 'Unlimited'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Members</dt>
            <dd className="mt-1 text-sm text-gray-900">{members.length}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Created</dt>
            <dd className="mt-1 text-sm text-gray-900">{formatDate(org.created_at)}</dd>
          </div>
        </div>
      </Card>

      {/* Sub-navigation links */}
      <div className="flex items-center gap-3 max-md:flex-wrap">
        <Link
          href={`/dashboard/organizations/${org.id}/identity-providers`}
          className="inline-flex items-center gap-2 rounded-md bg-white border border-gray-200 shadow-sm px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-300 transition-colors"
        >
          <Shield className="h-4 w-4 text-gray-500" />
          Identity Providers
        </Link>
      </div>

      {/* Plan assignment */}
      <PlanAssignment organizationId={org.id} canManage={!!canManagePlans} />

      {/* Brokerage billing (BACKLOG-3853) */}
      {shouldShowBillingCard(billing) && (
        <BrokerageBillingCard organizationId={org.id} organizationName={org.name} planName={planName} billing={billing} />
      )}

      {/* Brokerage people (BACKLOG-4007 PR-4): next to the Billing card, same gate */}
      {shouldShowBillingCard(billing) && <OrgPeopleCard organizationId={org.id} organizationName={org.name} />}

      {/* Pending invitations */}
      {pendingInvitations.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wider mb-4">
            Pending Invitations ({pendingInvitations.length})
          </h2>
          <PendingInvitationsTable invitations={pendingInvitations} />
        </div>
      )}

      {/* Members table (includes license summary filter cards) */}
      <div>
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wider">
            Members ({members.length})
          </h2>
          {members.length > 0 && inviteButton}
        </div>
        {members.length === 0 ? (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12">
            <Users className="mx-auto block h-12 w-12 text-gray-300" />
            <p className="mt-4 text-center text-sm text-gray-500">No members yet.</p>
            <div className="mt-4 flex justify-center">{inviteButton}</div>
          </div>
        ) : (
          <MembersTable members={members} />
        )}
      </div>
    </div>
  );
}
