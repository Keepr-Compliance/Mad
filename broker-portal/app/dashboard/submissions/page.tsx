import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { PageHeader } from '@keepr/design-system';
import { formatCurrency, formatRelativeTime, getStatusColor, formatStatus } from '@/lib/utils';
import { SubmissionListClient } from '@/components/submission/SubmissionListClient';
import { EmptySubmissions } from '@/components/ui/EmptyState';
import { SubmissionPagination } from '@/components/submission/SubmissionPagination';
import { getDataClient, getTargetOrganizationId } from '@/lib/impersonation-guards';
import { getOrgFeatures, isFeatureEnabled } from '@/lib/feature-gate';
import type { SupabaseClient } from '@supabase/supabase-js';

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

async function getSubmissions(
  client: SupabaseClient,
  status?: string,
  page: number = 1,
  orgId?: string,
  allowedOrgIds?: string[] | null,
): Promise<{ submissions: Submission[]; totalCount: number }> {
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  // Data query with pagination range
  let query = client
    .from('transaction_submissions')
    .select('*')
    .neq('status', 'uploading')  // Hide incomplete uploads (two-phase commit)
    .order('created_at', { ascending: false })
    .range(from, to);

  // Count query (separate for total)
  let countQuery = client
    .from('transaction_submissions')
    .select('*', { count: 'exact', head: true })
    .neq('status', 'uploading');

  // During impersonation, filter by organization
  if (orgId) {
    query = query.eq('organization_id', orgId);
    countQuery = countQuery.eq('organization_id', orgId);
  }

  // TASK-2158: Filter to only orgs with broker_portal_access enabled
  if (allowedOrgIds !== null && allowedOrgIds !== undefined && !orgId) {
    if (allowedOrgIds.length === 0) {
      // No orgs have access — return empty immediately
      return { submissions: [], totalCount: 0 };
    }
    query = query.in('organization_id', allowedOrgIds);
    countQuery = countQuery.in('organization_id', allowedOrgIds);
  }

  // Apply status filter if provided and not 'all'
  if (status && status !== 'all') {
    query = query.eq('status', status);
    countQuery = countQuery.eq('status', status);
  }

  const [{ data, error }, { count, error: countError }] = await Promise.all([
    query,
    countQuery,
  ]);

  if (error) {
    console.error('Error fetching submissions:', error);
    return { submissions: [], totalCount: 0 };
  }

  if (countError) {
    console.error('Error fetching submission count:', countError);
  }

  return {
    submissions: data || [],
    totalCount: count || 0,
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

  const { client, organizationId } = await getDataClient();

  // BACKLOG-908: Use deduped helper for org ID resolution
  const orgId = getTargetOrganizationId(organizationId);

  // TASK-2158: Resolve which orgs have broker_portal_access enabled
  const allowedOrgIds = await getAllowedOrgIds(client, orgId);

  const { submissions, totalCount } = await getSubmissions(client, status, currentPage, orgId, allowedOrgIds);
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // If requested page exceeds total pages (and there are results), clamp to last page
  const effectivePage = totalPages > 0 && currentPage > totalPages ? totalPages : currentPage;

  // Re-fetch if we clamped the page (edge case: items deleted while on last page)
  let displaySubmissions = submissions;
  if (effectivePage !== currentPage && totalCount > 0) {
    const refetch = await getSubmissions(client, status, effectivePage, orgId, allowedOrgIds);
    displaySubmissions = refetch.submissions;
  }

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
            {currentStatus !== 'all' && ` with status "${formatStatus(currentStatus)}"`}
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
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
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
              <tbody className="bg-white divide-y divide-gray-200">
                {displaySubmissions.map((submission) => (
                  <tr key={submission.id} className="hover:bg-gray-50 transition-colors cursor-pointer group">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">
                        {submission.property_address}
                      </div>
                      <div className="text-sm text-gray-500">
                        {submission.property_city}, {submission.property_state}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="capitalize text-sm text-gray-700">
                        {submission.transaction_type}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatCurrency(submission.sale_price || submission.listing_price)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(
                          submission.status
                        )}`}
                      >
                        {formatStatus(submission.status)}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      <div className="flex items-center gap-2">
                        <span title="Messages">{submission.message_count} msgs</span>
                        <span className="text-gray-300">|</span>
                        <span title="Attachments">{submission.attachment_count} files</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatRelativeTime(submission.created_at)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <Link
                        href={`/dashboard/submissions/${submission.id}`}
                        className="inline-flex items-center gap-1 text-primary-600 hover:text-primary-700 font-medium group-hover:underline"
                      >
                        Review
                        <ChevronRight className="h-4 w-4 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </Link>
                    </td>
                  </tr>
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
