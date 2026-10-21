import { getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { UserProfileCard } from './components/UserProfileCard';
import { OrganizationCard } from './components/OrganizationCard';
import { LicenseCard } from './components/LicenseCard';
import { PlanCard } from './components/PlanCard';
import { DevicesTable } from './components/DevicesTable';
import { AuditLogTable } from './components/AuditLogTable';
import { BillingCreditsCard } from './components/BillingCreditsCard';
import { SentryErrorsCard } from './components/SentryErrorsCard';
import { createServiceClient } from '@/lib/supabase/server';
import { getBillingData } from '@/lib/billing-queries';
import { getSuspensionStatus } from '@/lib/suspension-queries';
import { readPlanLinesWithOrgs, validPlanLineIds } from '@/lib/planLines';
import { planAmountLine } from '@/lib/billing/planAmount';
import type { OrgBilling } from '@/lib/billing/dealRules';
import type { PlanLine } from '@keepr/shared';
import * as Sentry from '@sentry/nextjs';
import { pickOrgPlanRow, type OrgPlanEmbed } from '@/lib/orgPlanEmbed';

export const dynamic = 'force-dynamic';

/**
 * User Detail Page - Admin Portal
 *
 * Server component that loads all user data in parallel and renders
 * a unified detail view. Sentry data is loaded client-side via
 * the SentryErrorsCard component to avoid blocking SSR.
 */
export default async function UserDetailPage({
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
    required_permission: 'users.view',
  });
  if (!hasPerm) {
    redirect('/dashboard?error=insufficient_permissions');
  }

  // Service-role client for RLS-bypassing support reads (billing/credits are
  // scoped to another user, so the admin's own cookie-scoped client cannot see
  // them). Only ever used server-side here.
  const serviceSupabase = createServiceClient();

  // Fetch target user profile and check permissions in parallel
  const [profileResult, orgsResult, licensesResult, devicesResult, auditResult, impersonatePermResult, devicesManagePermResult, billingData, suspensionStatus] =
    await Promise.all([
      supabase
        .from('users')
        .select('id, email, display_name, avatar_url, oauth_provider, status, subscription_tier, created_at, last_login_at')
        .eq('id', id)
        .single(),
      supabase
        .from('organization_members')
        .select('organization_id, role, joined_at, organizations(name, organization_plans(plan_id, plans(id, name, tier)))')
        .eq('user_id', id),
      supabase
        .from('licenses')
        .select('id, license_type, license_key, status, max_devices, expires_at, created_at')
        .eq('user_id', id),
      supabase.rpc('admin_list_user_devices', {
        p_user_id: id,
      }),
      supabase
        .from('audit_logs')
        .select('id, action, resource_type, resource_id, metadata, created_at')
        .eq('user_id', id)
        .order('created_at', { ascending: false })
        .limit(20),
      supabase.rpc('has_permission', {
        check_user_id: adminUser.id,
        required_permission: 'users.impersonate',
      }),
      supabase.rpc('has_permission', {
        check_user_id: adminUser.id,
        required_permission: 'devices.manage',
      }),
      getBillingData(serviceSupabase, id),
      getSuspensionStatus(serviceSupabase, id),
    ]);

  if (!profileResult.data) {
    notFound();
  }

  const profile = profileResult.data;

  // BACKLOG-3859: the plan line. Gated above (session has_permission users.view)
  // before the service client was created. Credits come from getBillingData's
  // get_credit_balance read, so no second read of the balance; when that read
  // failed (creditBalance then defaults to 0) the count is left out, not shown as 0.
  const balanceFailed = billingData.errorMessages.some((m) => m.startsWith('Credit balance:'));
  let planLineForUser: PlanLine | null = null;
  let planAmount: string | null = null;
  const planIds = validPlanLineIds([id]);
  if (planIds) {
    try {
      const { lines, brokerageOrgIds } = await readPlanLinesWithOrgs(
        serviceSupabase,
        planIds,
        new Date(),
        balanceFailed ? undefined : { [id]: billingData.creditBalance }
      );
      planLineForUser = lines[id] ?? null;
      // BACKLOG-3852: seat price and next invoice, brokerage members only, for billing.view holders.
      // Read through the SESSION client: admin_get_org_billing refuses a caller without billing.view,
      // so the database checks it too.
      const orgId = brokerageOrgIds[id];
      if (orgId && planLineForUser?.kind === 'brokerage') {
        const { data: canViewBilling } = await supabase.rpc('has_permission', {
          check_user_id: adminUser.id,
          required_permission: 'billing.view',
        });
        if (canViewBilling === true) {
          const read = await supabase.rpc('admin_get_org_billing', { p_org: orgId });
          if (!read.error) planAmount = planAmountLine(read.data as OrgBilling | null);
        }
      }
    } catch (err) {
      Sentry.captureException(err, { tags: { area: 'admin-plan-lines' } });
    }
  }

  // Transform org memberships to include org name and plan info
  const orgMemberships = (orgsResult.data ?? []).map((m) => {
    const org = m.organizations as unknown as {
      name: string;
      organization_plans: OrgPlanEmbed;
    } | null;
    const orgPlan = pickOrgPlanRow(org?.organization_plans);
    return {
      organization_id: m.organization_id,
      org_name: org?.name ?? null,
      role: m.role,
      joined_at: m.joined_at,
      plan_id: orgPlan?.plan_id ?? null,
      plan_name: orgPlan?.plans?.name ?? null,
      plan_tier: orgPlan?.plans?.tier ?? null,
    };
  });

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Back navigation */}
      <Link
        href="/dashboard/users"
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Users
      </Link>

      {/* Profile card */}
      <UserProfileCard
        user={profile}
        canImpersonate={impersonatePermResult.data === true}
        isOwnProfile={adminUser.id === id}
      />

      {/* Plan (BACKLOG-3859) */}
      <PlanCard line={planLineForUser} amount={planAmount} />

      {/* Two-column grid for org + account */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <OrganizationCard memberships={orgMemberships} />
        <LicenseCard licenses={licensesResult.data ?? []} />
      </div>

      {/* Billing & Credits (support-facing; credit grant/clawback is live) */}
      <BillingCreditsCard data={billingData} userId={id} suspension={suspensionStatus} />

      {/* Devices */}
      <DevicesTable
        devices={(devicesResult.data ?? []) as import('@/lib/admin-queries').AdminDevice[]}
        userId={id}
        canManage={devicesManagePermResult.data === true}
      />

      {/* Audit log */}
      <AuditLogTable entries={auditResult.data ?? []} />

      {/* Sentry errors - client component, fetched separately */}
      {profile.email && <SentryErrorsCard email={profile.email} />}
    </div>
  );
}
