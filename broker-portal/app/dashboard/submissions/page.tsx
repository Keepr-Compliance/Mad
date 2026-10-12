import Link from 'next/link';
import { PageHeader } from '@keepr/design-system';
import { PAGE_TITLES } from '@/lib/dashboard-page-titles';
import { formatCurrency, formatRelativeTime, getStatusColor, formatStatus } from '@/lib/utils';
import { SubmissionListClient } from '@/components/submission/SubmissionListClient';
import { EmptySubmissions } from '@/components/ui/EmptyState';
import { SubmissionPagination } from '@/components/submission/SubmissionPagination';
import { SubmissionRow } from '@/components/submission/SubmissionRow';
import { SubmissionCard } from '@/components/submission/SubmissionCard';
import { getDataClient, getTargetOrganizationId } from '@/lib/impersonation-guards';
import { getAllowedOrgIds } from '@/lib/submissions/allowedOrgs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';
import { requireFullPortalAccess } from '@/lib/auth/portalAccess';
import {
  BROKER_LINK_COLUMNS,
  PENDING_REVIEW_FILTER,
  headMatchesSearch,
  pageOfHeads,
  readDealHeads,
  type BrokerChainLink,
  type Identity,
} from '@/lib/submissions/dealList';
import { formatUsAddress } from '@/lib/submissions/formatUsAddress';
import { resolveUserIdentities } from '@/lib/submissions/names';
import {
  buildListUrl,
  hasActiveFilters,
  parseAgentParam,
  parseSearchParam,
  parseViewParam,
  type ListFilters,
} from '@/lib/submissions/listUrl';
import { compareHeads, parseSortParam } from '@/lib/submissions/listSort';
import { boardLaneFor } from '@/lib/submissions/boardLanes';
import {
  SubmissionDesktopFilters,
  SubmissionPhoneFilters,
  type AgentOption,
  type FacetCount,
} from '@/components/submission/SubmissionFilters';

interface Submission {
  id: string;
  organization_id: string;
  submitted_by?: string | null;
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
  searchParams: Promise<{ status?: string; search?: string; agent?: string; page?: string; sort?: string; view?: string }>;
}

const PAGE_SIZE = 25;

const STATUSES = [
  { value: 'all', label: 'All' },
  { value: 'submitted', label: 'Pending' },
  { value: 'new', label: 'New' },
  { value: 'resubmitted', label: 'Resubmitted' },
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
  /** Every deal head in the list's scope, before search and filters (Y). */
  scopeTotal: number;
  /** Every submitter among the in-scope deals (BACKLOG-3904). */
  agents: AgentOption[];
  /** Deals matching the search, counted per (head status, submitter). */
  facets: FacetCount[];
}

const EMPTY_LIST: SubmissionList = { submissions: [], totalCount: 0, page: 1, totalPages: 1, scopeTotal: 0, agents: [], facets: [] };

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
    compare: compareHeads(filters.sort ?? 'newest'),
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
    scopeTotal: heads.length,
    agents: agentOptions(heads, identities),
    facets: facetCounts(searched),
  };
}

export default async function SubmissionsPage({ searchParams }: PageProps) {
  const { status, page: pageParam, agent: agentParam, search: searchParam, sort: sortParam, view: viewParam } =
    await searchParams;
  const currentPage = Math.max(1, Number(pageParam) || 1);
  // BACKLOG-3914: the phone board is this list with the status set to one lane
  // (New when the status names no lane), so its cards and counts are the list's.
  const view = parseViewParam(viewParam);
  const currentStatus = view === 'board' ? boardLaneFor(status) : status || 'all';
  // BACKLOG-3904: a non-uuid agent is ignored; search is trimmed and capped.
  const filters: ListFilters = {
    status: currentStatus,
    agent: parseAgentParam(agentParam),
    search: parseSearchParam(searchParam),
    sort: parseSortParam(sortParam),
    ...(view === 'board' ? { view } : {}),
  };
  // BACKLOG-3597: the "submitted" filter now covers submitted AND resubmitted
  // deals (STATUSES labels it "Pending"), so the caption uses that tab label
  // instead of formatStatus, which still reports a single submission's own
  // "Submitted" status elsewhere on this page.
  // `pending` (the dashboard card's set: submitted + under_review) is not a
  // standing tab; it shows, active, only while it is the filter.
  const statusOptions =
    currentStatus === PENDING_REVIEW_FILTER
      ? [STATUSES[0], { value: PENDING_REVIEW_FILTER, label: 'Pending Review' }, ...STATUSES.slice(1)]
      : STATUSES;
  const currentStatusLabel = statusOptions.find((s) => s.value === currentStatus)?.label ?? formatStatus(currentStatus);

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
    scopeTotal,
    agents,
    facets,
  } = await getSubmissions(client, filters, currentPage, orgId, allowedOrgIds, !!impersonation);

  const agentLabels = new Map(agents.map((a) => [a.id, a.label]));

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
        className="max-md:mb-0"
        subtitle={
          <span className="max-md:hidden">
            {totalCount} submission{totalCount !== 1 ? 's' : ''}
            {currentStatus !== 'all' && ` with status "${currentStatusLabel}"`}
          </span>
        }
      />

      {/* Below md the desktop filter box is display:none but still a sibling, so
          space-y would put a margin above the phone filters; cancel it so the gap
          under the top bar equals the dashboard's (16px, main padding only). */}
      <div className="space-y-6 max-md:space-y-3 max-md:[&>:nth-child(2)]:!mt-0">
      {/* BACKLOG-3904: desktop only, the same search + filters card as Users Management;
          below md the phone filters replace it. */}
      <div className="max-md:hidden">
        <SubmissionDesktopFilters
          filters={filters}
          statuses={statusOptions}
          agents={agents}
          matchingCount={totalCount}
          scopeTotal={scopeTotal}
        />
      </div>

      <SubmissionPhoneFilters
        filters={filters}
        statuses={statusOptions}
        agents={agents}
        facets={facets}
        selectedAgentLabel={selectedAgentLabel}
        matchingCount={totalCount}
        scopeTotal={scopeTotal}
      />

      {/* Submissions Table */}
      {/* Below md the row cards sit straight on the page background (no frame), so their
          left and right edges are the search field's; the frame stays from md up. */}
      <div
        className={`bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden${
          displaySubmissions.length > 0 || view === 'board' ? ' max-md:overflow-visible max-md:rounded-none max-md:border-0 max-md:bg-transparent max-md:shadow-none' : ''
        }`}
      >
        {displaySubmissions.length === 0 ? (
          view === 'board' ? (
            <>
              {/* BACKLOG-3914: an empty board lane on the phone, as in the mockup. */}
              <p className="py-4 text-center text-sm text-gray-500 md:hidden" data-slot="board-lane-empty">
                Nothing here
              </p>
              <div className="max-md:hidden">
                <EmptySubmissions filtered={hasActiveFilters(filters)} />
              </div>
            </>
          ) : (
            <EmptySubmissions filtered={hasActiveFilters(filters)} />
          )
        ) : (
          <>
            {/* BACKLOG-3798/3904: below md the list is the shared SubmissionCard (also used by the
                dashboard's Recent Submissions); the table is the md+ view. */}
            <div className="flex flex-col gap-2 md:hidden" data-slot="submission-cards">
              {displaySubmissions.map((submission) => (
                <SubmissionCard
                  key={submission.id}
                  submission={submission}
                  agent={submission.submitted_by ? agentLabels.get(submission.submitted_by) : undefined}
                />
              ))}
            </div>
            <table className="min-w-full divide-y divide-gray-200 max-md:hidden">
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
                    Submitted
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {displaySubmissions.map((submission) => {
                  const href = `/dashboard/submissions/${submission.id}`;
                  const { street, cityLine } = formatUsAddress(
                    submission.property_address,
                    submission.property_city,
                    submission.property_state
                  );
                  return (
                  <SubmissionRow
                    key={submission.id}
                    href={href}
                    className="hover:bg-gray-50 transition-colors cursor-pointer group"
                  >
                    {/* The street is the row's keyboard stop and accessible name (the row itself is
                        a <tr>, which cannot be a link); the row click covers pointer users. */}
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">
                        <Link
                          href={href}
                          className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1"
                        >
                          {street}
                        </Link>
                      </div>
                      {cityLine && <div className="text-sm text-gray-500">{cityLine}</div>}
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
                      {formatRelativeTime(submission.created_at)}
                    </td>
                  </SubmissionRow>
                  );
                })}
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
