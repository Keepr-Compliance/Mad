/**
 * My Transactions — BACKLOG-3080.
 *
 * A brokerage agent's OWN submissions to their CURRENT brokerage, read-only.
 * Never the brokerage's review queue (/dashboard/submissions stays full-portal
 * only).
 *
 * lib/my-transactions-access.ts decides, before anything is read:
 *   - admitted -> the list below, through the session client only;
 *   - upsell   -> the plan message, and no submission is read;
 *   - null     -> notFound().
 *
 * Every read is scoped in the query itself to `submitted_by = the agent` AND
 * `organization_id = the brokerage the key was checked on`: the portal narrows
 * to the current brokerage explicitly.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { PageHeader } from '@keepr/design-system';
import { formatCurrency, formatRelativeTime, getStatusColor, formatStatus } from '@/lib/utils';
import { EmptySubmissions } from '@/components/ui/EmptyState';
import { SubmissionPagination } from '@/components/submission/SubmissionPagination';
import { UpsellPanel } from '@/components/my-transactions/UpsellPanel';
import { getMyTransactionsGate } from '@/lib/my-transactions-access';
import { LINK_COLUMNS, loadDealPage } from '@/lib/submissions/dealList';

interface MyTransaction {
  id: string;
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
}

interface PageProps {
  searchParams: Promise<{ status?: string; page?: string }>;
}

const PAGE_SIZE = 25;
const BASE_PATH = '/dashboard/my-transactions';

/** Explicit columns: only what the list renders. */
const LIST_COLUMNS =
  'id, property_address, property_city, property_state, transaction_type, listing_price, sale_price, status, message_count, attachment_count, created_at';

const STATUSES = [
  { value: 'all', label: 'All' },
  { value: 'submitted', label: 'Pending' },
  { value: 'under_review', label: 'Under Review' },
  { value: 'needs_changes', label: 'Needs Changes' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

function statusHref(value: string): string {
  return value === 'all' ? BASE_PATH : `${BASE_PATH}?status=${value}`;
}

export default async function MyTransactionsPage({ searchParams }: PageProps) {
  const gate = await getMyTransactionsGate();
  if (!gate) notFound();
  if (gate.kind === 'upsell') return <UpsellPanel />;

  const { supabase, userId, organizationId } = gate;
  const { status, page: pageParam } = await searchParams;
  const currentStatus = STATUSES.some((s) => s.value === status) ? (status as string) : 'all';
  const currentPage = Math.max(1, Number(pageParam) || 1);
  // BACKLOG-3597: the "submitted" filter now covers submitted AND resubmitted
  // deals (STATUSES labels it "Pending"), so the caption uses that tab label
  // instead of formatStatus, which still reports a single submission's own
  // "Submitted" status elsewhere on this page.
  const currentStatusLabel = STATUSES.find((s) => s.value === currentStatus)?.label ?? formatStatus(currentStatus);

  /** The agent's own rows in this brokerage, identical for both reads. */
  function own(columns: string) {
    return supabase
      .from('transaction_submissions')
      .select(columns)
      .eq('submitted_by', userId)
      .eq('organization_id', organizationId)
      .neq('status', 'uploading');
  }

  // BACKLOG-3597: one row per deal, its latest version (lib/submissions/dealList.ts).
  // Count, status filter and pagination apply to deals. A page past the end
  // (rows removed while it was open) shows the last page.
  const result = await loadDealPage<MyTransaction>({
    readLinks: (from, to) => own(LINK_COLUMNS).order('id').range(from, to),
    readRows: (ids) => own(LIST_COLUMNS).in('id', ids),
    status: currentStatus !== 'all' ? currentStatus : null,
    page: currentPage,
    pageSize: PAGE_SIZE,
  });
  if (result.error) {
    const message = (result.error as { message?: string }).message ?? String(result.error);
    console.error('Error fetching my transactions:', message);
  }
  const { rows, total, totalPages, page: effectivePage } = result.error
    ? { rows: [] as MyTransaction[], total: 0, totalPages: 1, page: 1 }
    : result;

  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader
        title="My Transactions"
        subtitle={
          <>
            {total} submission{total !== 1 ? 's' : ''}
            {currentStatus !== 'all' && ` with status "${currentStatusLabel}"`}
          </>
        }
      />

      <div className="space-y-6">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <div className="flex flex-wrap gap-2">
            {STATUSES.map(({ value, label }) => {
              const isActive = currentStatus === value;
              return (
                <Link
                  key={value}
                  href={statusHref(value)}
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

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          {rows.length === 0 ? (
            <EmptySubmissions
              filtered={currentStatus !== 'all'}
              emptyDescription="Transactions you submit from the Keepr app will appear here."
            />
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
                  {rows.map((submission) => (
                    <tr key={submission.id} className="hover:bg-gray-50 transition-colors group">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">{submission.property_address}</div>
                        <div className="text-sm text-gray-500">
                          {submission.property_city}, {submission.property_state}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="capitalize text-sm text-gray-700">{submission.transaction_type}</span>
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
                          href={`${BASE_PATH}/${submission.id}`}
                          className="inline-flex items-center gap-1 text-primary-600 hover:text-primary-700 font-medium group-hover:underline"
                        >
                          View
                          <ChevronRight className="h-4 w-4 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {totalPages > 1 && (
                <SubmissionPagination
                  currentPage={effectivePage}
                  totalPages={totalPages}
                  baseUrl={statusHref(currentStatus)}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
