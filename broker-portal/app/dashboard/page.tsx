import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Inbox, RefreshCw, Eye, XCircle } from 'lucide-react';
import {
  PageHeader,
  EmptyState,
  Card,
  CardHeader,
  CardTitle,
} from '@keepr/design-system';
import { formatRelativeTime, getStatusColor, formatStatus } from '@/lib/utils';
import { getDataClient, getTargetOrganizationId } from '@/lib/impersonation-guards';
import {
  getDashboardHeading,
  resolveViewerIdentity,
  type ViewerUser,
} from '@/lib/utils/userDisplay';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getPortalAccess } from '@/lib/auth/portalAccess';
import { orgSuspendedLanding, suspendedLanding } from '@/lib/auth/membership';
import { billingEnabled } from '@/lib/billing/flag';
import { billingSetupPending, SETUP_GUIDE_PATH } from '@/lib/billing/setupState';
import { Alert } from '@keepr/design-system';
import { FloorDashboard } from './components/FloorDashboard';
import { DashboardStatCards } from '@/components/dashboard/DashboardStatCards';
import { buildStatCards, type StatCardData } from '@/lib/dashboard/statCards';
import { getAllowedOrgIds } from '@/lib/submissions/allowedOrgs';
import { LINK_COLUMNS, readDealHeads } from '@/lib/submissions/dealList';
import { resolveUserIdentities } from '@/lib/submissions/names';
import { SubmissionCard } from '@/components/submission/SubmissionCard';

/**
 * BACKLOG-3904: the stat cards count deals - the head of every resubmission
 * chain - in the Submissions list's own scope (same org gate, same
 * uploading exclusion), so each linked card's number is the size of the list it
 * opens. See lib/dashboard/statCards.ts.
 */
async function getStatCards(client: SupabaseClient, orgId?: string): Promise<StatCardData[]> {
  // BACKLOG-3906: a failed lookup counts nothing.
  const allowed = await getAllowedOrgIds(client, orgId);
  if (!allowed.ok || allowed.orgIds.length === 0) return buildStatCards([]);
  const allowedOrgIds = allowed.orgIds;

  const read = await readDealHeads((from, to) => {
    let query = client
      .from('transaction_submissions')
      .select(LINK_COLUMNS)
      .neq('status', 'uploading');
    // During impersonation, filter by organization
    if (orgId) query = query.eq('organization_id', orgId);
    query = query.in('organization_id', allowedOrgIds);
    return query.order('id').range(from, to);
  });

  if (read.error) {
    console.error('Error fetching stats:', read.error);
    return buildStatCards([]);
  }
  return buildStatCards(read.heads);
}

async function getRecentSubmissions(client: SupabaseClient, orgId?: string) {
  let query = client
    .from('transaction_submissions')
    .select('*')
    .neq('status', 'uploading')
    .order('created_at', { ascending: false })
    .limit(5);

  if (orgId) {
    query = query.eq('organization_id', orgId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching recent submissions:', error);
    return [];
  }

  return data || [];
}

export default async function DashboardPage() {
  const { client, impersonation, organizationId } = await getDataClient();

  // BACKLOG-3077: the signed-in user, kept for the header greeting. Null during
  // impersonation, where the session names the target user instead.
  let authUser: ViewerUser | null = null;

  // BACKLOG-3080: only a full-portal user gets the brokerage overview.
  // Everyone else gets the floor, decided BEFORE any submission is read.
  let isFullPortal = false;
  // BACKLOG-4007 PR-3: "Finish setup" banner while the brokerage waits for the Billing step.
  let setupPending = false;

  // IT admins only manage users — redirect to Users page (skip during impersonation)
  if (!impersonation) {
    const portal = await getPortalAccess();
    // BACKLOG-3878: a suspended account has no dashboard home; this page owns
    // that refusal too (middleware is not the only gate). Never in the
    // impersonation branch: a support session keeps its view.
    if (portal?.suspended === true) {
      redirect(suspendedLanding(portal.access, billingEnabled()));
    }
    // BACKLOG-3853 PR-2B: a suspended brokerage's broker, admin and IT admin
    // have no dashboard home either. An agent keeps it (Q7 a).
    if (portal?.orgSuspended === true && portal.access.kind === 'full') {
      redirect(orgSuspendedLanding(portal.access, billingEnabled()));
    }
    if (portal) {
      authUser = portal.user;
      if (portal.access.kind === 'full') {
        isFullPortal = true;
        if (portal.access.role === 'it_admin') {
          redirect('/dashboard/users');
        }
        setupPending = await billingSetupPending(portal.supabase, portal.access);
      }
    }
  }

  // BACKLOG-3077: greet the person by first name; falls back to "Dashboard"
  // when neither a name nor an email local part is available.
  const headerTitle = getDashboardHeading(resolveViewerIdentity(impersonation, authUser));

  if (!impersonation && !isFullPortal) {
    return <FloorDashboard headerTitle={headerTitle} />;
  }

  // BACKLOG-908: Use deduped helper for org ID resolution
  const orgId = getTargetOrganizationId(organizationId);

  const [statCards, recentSubmissions] = await Promise.all([
    getStatCards(client, orgId),
    getRecentSubmissions(client, orgId),
  ]);
  // The phone cards name the agent, as the Submissions list does. A support
  // session looks up no names (users is ID-scoped to the target there).
  const agentNames = impersonation
    ? null
    : await resolveUserIdentities(client, recentSubmissions.map((s) => s.submitted_by));

  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader phoneHideTitle phoneHideSubtitle title={headerTitle} subtitle="Overview of transaction submissions" />

      <div className="space-y-6">
        {setupPending ? (
          <Alert variant="warning">
            <p>
              Finish your account setup. Confirm the billing details before you invite your team.{' '}
              <Link href={SETUP_GUIDE_PATH} className="font-medium underline">
                Finish setup
              </Link>
            </p>
          </Alert>
        ) : null}

        {/* Stats Grid */}
        <DashboardStatCards
          cards={statCards}
          icons={{
            new: <Inbox className="h-5 w-5" />,
            resubmitted: <RefreshCw className="h-5 w-5" />,
            under_review: <Eye className="h-5 w-5" />,
            needs_changes: <XCircle className="h-5 w-5" />,
          }}
        />

        {/* Recent Submissions */}
        <Card
          padding="none"
          className={
            recentSubmissions.length > 0
              ? 'max-md:rounded-none max-md:border-0 max-md:bg-transparent max-md:shadow-none'
              : undefined
          }
        >
          <CardHeader
            className="max-md:px-0 max-md:pt-0 max-md:pb-3 max-md:border-b-0"
            action={
              <Link
                href="/dashboard/submissions"
                className="text-sm font-medium text-primary-600 hover:text-primary-700"
              >
                View all
              </Link>
            }
          >
            <CardTitle>Recent Submissions</CardTitle>
          </CardHeader>

          {recentSubmissions.length === 0 ? (
            <EmptyState
              card={false}
              icon={<Inbox className="mx-auto h-12 w-12 text-gray-300" />}
              title="No submissions yet"
            />
          ) : (
            <>
            <div className="flex flex-col gap-2 md:hidden" data-slot="submission-cards">
              {recentSubmissions.map((submission) => (
                <SubmissionCard
                  key={submission.id}
                  submission={submission}
                  agent={submission.submitted_by ? agentNames?.get(submission.submitted_by)?.name : undefined}
                />
              ))}
            </div>
            <ul className="divide-y divide-gray-200 max-md:hidden">
              {recentSubmissions.map((submission) => (
                <li key={submission.id}>
                  <Link
                    href={`/dashboard/submissions/${submission.id}`}
                    className="block px-6 py-4 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {submission.property_address}
                        </p>
                        <p className="text-sm text-gray-500">
                          {submission.property_city}, {submission.property_state}
                        </p>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="text-sm text-gray-500">
                          {formatRelativeTime(submission.created_at)}
                        </span>
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(
                            submission.status
                          )}`}
                        >
                          {formatStatus(submission.status)}
                        </span>
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
