import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { PageHeader } from '@keepr/design-system';
import { PAGE_TITLES } from '@/lib/dashboard-page-titles';
import { formatCurrency, formatRelativeTime, getStatusColor, formatStatus } from '@/lib/utils';
import { SubmissionListClient } from '@/components/submission/SubmissionListClient';
import { EmptySubmissions } from '@/components/ui/EmptyState';
import { SubmissionPagination } from '@/components/submission/SubmissionPagination';
import { SubmissionRow } from '@/components/submission/SubmissionRow';
import { getDataClient, getTargetOrganizationId } from '@/lib/impersonation-guards';
import { getAllowedOrgIds } from '@/lib/submissions/allowedOrgs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';
import { requireFullPortalAccess } from '@/lib/auth/portalAccess';
import {
  BROKER_LINK_COLUMNS,
  headMatchesSearch,
  pageOfHeads,
  readDealHeads,
  type BrokerChainLink,
  type Identity,
} from '@/lib/submissions/dealList';
import { resolveUserIdentities } from '@/lib/submissions/names';
import {
  buildListUrl,
  hasActiveFilters,
  parseAgentParam,
  parseSearchParam,
  type ListFilters,
} from '@/lib/submissions/listUrl';
import {
  SubmissionDesktopFilters,
  SubmissionPhoneFilters,
  type AgentOption,
  type FacetCount,
} from '@/components/submission/SubmissionFilters';

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
  searchParams: Promise<{ status?: string; search?: string; agent?: string; page?: string }>;
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

interface SubmissionList {
  submissions: Submission[];
  totalCount: number;
  page: number;
  totalPages: number;
  /** Every submitter among the in-scope deals (BACKLOG-3904). */
  agents: AgentOption[];
  /** Deals matching the search, counted per (head status, submitter). */
  facets: FacetCount[];
}

const EMPTY_LIST: SubmissionList = { submissions: [], totalCount: 0, page: 1, totalPages: 1, agents: [], facets: [] };

/**
 * BACKLOG-3904: the agent filter's options are the submitters of the deals
 * this list already shows — never a read of users or organization_members,
 * which reach wider than the list's scope. Labels come from `identities`
 * (ids already in scope); null (support session, or the lookup failed) gives
 * neutral numbered labels so nobody is mislabelled a former member.
 */
function agentOptions(heads: BrokerChainLink[], identities: ReadonlyMap<string, Identity> | null): AgentOption[] {
  const ids = Array.from(new Set(heads.map((h) => h.submitted_by).filter((id): id is string => !!id))).sort();
  if (identities === null) return ids.map((id, i) => ({ id, label: `Agent ${i + 1}` }));
  return ids
    .map((id) => ({ id, label: identities.get(id)?.name ?? 'Former member' }))
    .sort((a, b) => a.label.localeCompare(b.label) || (a.id < b.id ? -1 : 1));
}

function facetCounts(heads: BrokerChainLink[]): FacetCount[] {
  const byKey = new Map<string, FacetCount>();
  for (const h of heads) {
    const status = h.status ?? '';
    const key = `${status}|${h.submitted_by ?? ''}`;
    const entry = byKey.get(key);
    if (entry) entry.count += 1;
    else byKey.set(key, { status, agent: h.submitted_by, count: 1 });
  }
  return Array.from(byKey.values());
}

/**
 * BACKLOG-3597: one row per deal — the latest version of each resubmission
 * chain (lib/submissions/dealList.ts). Count, status filter and pagination all
 * apply to deals. BACKLOG-3904: search and the agent filter match the same
 * heads, before the count and the page.
 */
async function getSubmissions(
  client: SupabaseClient,
  filters: ListFilters,
  page: number = 1,
  orgId?: string,
  allowedOrgIds?: string[] | null,
  isImpersonating: boolean = false,
): Promise<SubmissionList> {
  const restrictToOrgs = allowedOrgIds !== null && allowedOrgIds !== undefined && !orgId;

  // TASK-2158: Filter to only orgs with broker_portal_access enabled
  if (restrictToOrgs && allowedOrgIds.length === 0) {
    // No orgs have access — return empty immediately
    return EMPTY_LIST;
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

  const read = await readDealHeads<BrokerChainLink>((from, to) =>
    scoped(BROKER_LINK_COLUMNS).order('id').range(from, to)
  );
  if (read.error) {
    console.error('Error fetching submissions:', read.error);
    return EMPTY_LIST;
  }
  const heads = read.heads;

  // Names only for submitters already in scope. A support session looks up no
  // names at all (users is ID-scoped to the target there — BACKLOG-3477), so
  // name/email search is off and address search still works.
  const identities = isImpersonating
    ? null
    : await resolveUserIdentities(client, heads.map((h) => h.submitted_by));

  const searched = filters.search
    ? heads.filter((h) => headMatchesSearch(h, filters.search, identities))
    : heads;

  const result = await pageOfHeads<Submission, BrokerChainLink>({
    heads: searched,
    readRows: (ids) => scoped('*').in('id', ids),
    status: filters.status !== 'all' ? filters.status : null,
    match: filters.agent ? (h) => h.submitted_by === filters.agent : undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  if (result.error) {
    console.error('Error fetching submissions:', result.error);
    return EMPTY_LIST;
  }

  return {
    submissions: result.rows,
    totalCount: result.total,
    page: result.page,
    totalPages: result.totalPages,
    agents: agentOptions(heads, identities),
    facets: facetCounts(searched),
  };
}

export default async function SubmissionsPage({ searchParams }: PageProps) {
  const { status, page: pageParam, agent: agentParam, search: searchParam } = await searchParams;
  const currentPage = Math.max(1, Number(pageParam) || 1);
  const currentStatus = status || 'all';
  // BACKLOG-3904: a non-uuid agent is ignored; search is trimmed and capped.
  const filters: ListFilters = {
    status: currentStatus,
    agent: parseAgentParam(agentParam),
    search: parseSearchParam(searchParam),
  };
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
    agents,
    facets,
  } = await getSubmissions(client, filters, currentPage, orgId, allowedOrgIds, !!impersonation);

  // Pagination keeps every filter (BACKLOG-3904).
  const baseUrl = buildListUrl(filters);
  // R1: the selected agent's label comes only from the in-scope options.
  const selectedAgentLabel = filters.agent
    ? agents.find((a) => a.id === filters.agent)?.label ?? 'Unknown agent'
    : 'All agents';

  return (
    <SubmissionListClient>
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <PageHeader
        phoneHideTitle
        phoneHideSubtitle
        title={PAGE_TITLES.submissions}
        className="max-md:mb-3"
        subtitle={
          <span className="max-md:hidden">
            {totalCount} submission{totalCount !== 1 ? 's' : ''}
            {currentStatus !== 'all' && ` with status "${currentStatusLabel}"`}
          </span>
        }
      />

      <div className="space-y-6 max-md:space-y-3">
      {/* Status Filters - clicking a filter resets to page 1 (no page param).
          BACKLOG-3904: desktop only; below md the phone filters replace them. */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 max-md:hidden">
        <div className="flex flex-wrap gap-2">
          {STATUSES.map(({ value, label }) => {
            const isActive = currentStatus === value;
            return (
              <Link
                key={value}
                href={buildListUrl({ ...filters, status: value })}
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
        <SubmissionDesktopFilters filters={filters} agents={agents} />
      </div>

      <SubmissionPhoneFilters
        filters={filters}
        statuses={STATUSES}
        agents={agents}
        facets={facets}
        selectedAgentLabel={selectedAgentLabel}
      />

      {/* Submissions Table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        {displaySubmissions.length === 0 ? (
          <EmptySubmissions filtered={hasActiveFilters(filters)} />
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
