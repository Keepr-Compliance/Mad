import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { PageHeader } from '@keepr/design-system';
import { formatCurrency, formatRelativeTime, getStatusColor, formatStatus } from '@/lib/utils';
import { SubmissionListClient } from '@/components/submission/SubmissionListClient';
import { EmptySubmissions } from '@/components/ui/EmptyState';
import { SubmissionPagination } from '@/components/submission/SubmissionPagination';
import { SubmissionRow } from '@/components/submission/SubmissionRow';
import { getDataClient, getTargetOrganizationId } from '@/lib/impersonation-guards';
import { getOrgFeatures, isFeatureEnabled } from '@/lib/feature-gate';
import type { SupabaseClient } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';
import { requireFullPortalAccess } from '@/lib/auth/portalAccess';
import { LINK_COLUMNS, loadDealPage } from '@/lib/submissions/dealList';

interface Submission {
  id: string;
  organization_id: string;
  property_address: string;
  property_city: string | null;
  property_state: string | null;
  transaction_type: string;
  listing_price: number | null;
  sale_price: number | null;
  status: string;
  message_count: number;
  attachment_count: number;
  created_at: string;
  reviewed_at: string | null;
}

interface PageProps {
  searchParams: Promise<{ status?: string; search?: string; page?: string }>;
}

const PAGE_SIZE = 25;

const STATUSES = [
  { value: 'all', label: 'All' },
  { value: 'submitted', label: 'Pending' },
  { value: 'under_review', label: 'Under Review' },
  { value: 'needs_changes', label: 'Needs Changes' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

/**
 * TASK-2158: Get the set of org IDs that have broker_portal_access enabled.
 *
 * Fetches distinct organization IDs from the submissions visible to this broker,
 * then checks each org's features to filter out those without broker_portal_access.
 *
 * During impersonation (single org), skips the distinct query and checks just that org.
 */
async function getAllowedOrgIds(
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

/**
 * BACKLOG-3597: one row per deal — the latest version of each resubmission
 * chain (lib/submissions/dealList.ts). Count, status filter and pagination all
 * apply to deals.
 */
async function getSubmissions(
  client: SupabaseClient,
  status?: string,
  page: number = 1,
  orgId?: string,
  allowedOrgIds?: string[] | null,
): Promise<{ submissions: Submission[]; totalCount: number; page: number; totalPages: number }> {
  const restrictToOrgs = allowedOrgIds !== null && allowedOrgIds !== undefined && !orgId;

  // TASK-2158: Filter to only orgs with broker_portal_access enabled
  if (restrictToOrgs && allowedOrgIds.length === 0) {
    // No orgs have access — return empty immediately
    return { submissions: [], totalCount: 0, page: 1, totalPages: 1 };
  }

  /** The list's scope, identical for both reads. */
  function scoped(columns: string) {
    let query = client
      .from('transaction_submissions')
      .select(columns)
      .neq('status', 'uploading'); // Hide incomplete uploads (two-phase commit)
    // During impersonation, filter by organization
    if (orgId) query = query.eq('organization_id', orgId);
    if (restrictToOrgs) query = query.in('organization_id', allowedOrgIds);
    return query;
  }

  const result = await loadDealPage<Submission>({
    readLinks: (from, to) => scoped(LINK_COLUMNS).order('id').range(from, to),
    readRows: (ids) => scoped('*').in('id', ids),
    status: status && status !== 'all' ? status : null,
    page,
    pageSize: PAGE_SIZE,
  });

  if (result.error) {
    console.error('Error fetching submissions:', result.error);
    return { submissions: [], totalCount: 0, page: 1, totalPages: 1 };
  }

  return {
    submissions: result.rows,
    totalCount: result.total,
    page: result.page,
    totalPages: result.totalPages,
  };
}

/**
 * Build the base URL for pagination links, preserving current filters
 * but excluding the page parameter.
 */
function buildBaseUrl(currentStatus: string): string {
  if (currentStatus === 'all') {
    return '/dashboard/submissions';
  }
  return `/dashboard/submissions?status=${currentStatus}`;
}

export default async function SubmissionsPage({ searchParams }: PageProps) {
  const { status, page: pageParam } = await searchParams;
  const currentPage = Math.max(1, Number(pageParam) || 1);
  const currentStatus = status || 'all';
  // BACKLOG-3597: the "submitted" filter now covers submitted AND resubmitted
  // deals (STATUSES labels it "Pending"), so the caption uses that tab label
  // instead of formatStatus, which still reports a single submission's own
  // "Submitted" status elsewhere on this page.
  const currentStatusLabel = STATUSES.find((s) => s.value === currentStatus)?.label ?? formatStatus(currentStatus);

  const { client, impersonation, organizationId } = await getDataClient();

  // BACKLOG-3080: brokerage submissions are for the full portal only. Refused
  // before any submission is read. A support session keeps its read-only view.
  if (!impersonation && !(await requireFullPortalAccess())) {
    redirect('/dashboard');
  }

  // BACKLOG-908: Use deduped helper for org ID resolution
  const orgId = getTargetOrganizationId(organizationId);

  // TASK-2158: Resolve which orgs have broker_portal_access enabled
  const allowedOrgIds = await getAllowedOrgIds(client, orgId);

  // A requested page past the end shows the last page (clamped in getSubmissions).
  const {
    submissions: displaySubmissions,
    totalCount,
    page: effectivePage,
    totalPages,
  } = await getSubmissions(client, status, currentPage, orgId, allowedOrgIds);

  const baseUrl = buildBaseUrl(currentStatus);

  return (
    <SubmissionListClient>
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <PageHeader
        title="Submissions"
        subtitle={
          <>
            {totalCount} submission{totalCount !== 1 ? 's' : ''}
            {currentStatus !== 'all' && ` with status "${currentStatusLabel}"`}
          </>
        }
      />

      <div className="space-y-6">
      {/* Status Filters - clicking a filter resets to page 1 (no page param) */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="flex flex-wrap gap-2">
          {STATUSES.map(({ value, label }) => {
            const isActive = currentStatus === value;
            return (
              <Link
                key={value}
                href={value === 'all' ? '/dashboard/submissions' : `/dashboard/submissions?status=${value}`}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-primary-600 text-white'
                    : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
              >
                {label}
              </Link>
            );
          })}
        </div>
      </div>

      {/* Submissions Table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        {displaySubmissions.length === 0 ? (
          <EmptySubmissions filtered={currentStatus !== 'all'} />
        ) : (
          <>
            {/* BACKLOG-3798: below md each row renders as a card (max-md: only;
                one DOM, so desktop and the row-click tests see the same table). */}
            <table className="min-w-full divide-y divide-gray-200 max-md:block">
              <thead className="bg-gray-50 max-md:hidden">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Property
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Price
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Docs
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Submitted
                  </th>
                  <th className="relative px-6 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200 max-md:block">
                {displaySubmissions.map((submission) => (
                  <SubmissionRow
                    key={submission.id}
                    href={`/dashboard/submissions/${submission.id}`}
                    className="hover:bg-gray-50 transition-colors cursor-pointer group max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-3 max-md:gap-y-1 max-md:px-4 max-md:py-3"
                  >
                    <td className="px-6 py-4 whitespace-nowrap max-md:p-0 max-md:w-full max-md:whitespace-normal">
                      <div className="text-sm font-medium text-gray-900">
                        {submission.property_address}
                      </div>
                      <div className="text-sm text-gray-500">
                        {submission.property_city}, {submission.property_state}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap max-md:p-0">
                      <span className="capitalize text-sm text-gray-700">
                        {submission.transaction_type}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 max-md:p-0">
                      {formatCurrency(submission.sale_price || submission.listing_price)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap max-md:p-0">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(
                          submission.status
                        )}`}
                      >
                        {formatStatus(submission.status)}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 max-md:p-0">
                      <div className="flex items-center gap-2">
                        <span title="Messages">{submission.message_count} msgs</span>
                        <span className="text-gray-300">|</span>
                        <span title="Attachments">{submission.attachment_count} files</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 max-md:p-0">
                      {formatRelativeTime(submission.created_at)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium max-md:p-0 max-md:ml-auto">
                      <Link
                        href={`/dashboard/submissions/${submission.id}`}
                        className="inline-flex items-center gap-1 text-primary-600 hover:text-primary-700 font-medium group-hover:underline"
                      >
                        Review
                        <ChevronRight className="h-4 w-4 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </Link>
                    </td>
                  </SubmissionRow>
                ))}
              </tbody>
            </table>

            {/* Pagination */}
            {totalPages > 1 && (
              <SubmissionPagination
                currentPage={effectivePage}
                totalPages={totalPages}
                baseUrl={baseUrl}
              />
            )}
          </>
        )}
      </div>
      </div>
    </div>
    </SubmissionListClient>
  );
}
