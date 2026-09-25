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
 * `organization_id = the brokerage the key was checked on`. RLS also limits an
 * agent to their own rows, but it has no organization term, so the portal
 * narrows to the current brokerage explicitly.
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

  async function load(page: number): Promise<{ rows: MyTransaction[]; total: number }> {
    const from = (page - 1) * PAGE_SIZE;
    let rowsQuery = supabase
      .from('transaction_submissions')
      .select(LIST_COLUMNS)
      .eq('submitted_by', userId)
      .eq('organization_id', organizationId)
      .neq('status', 'uploading')
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    let countQuery = supabase
      .from('transaction_submissions')
      .select('id', { count: 'exact', head: true })
      .eq('submitted_by', userId)
      .eq('organization_id', organizationId)
      .neq('status', 'uploading');
    if (currentStatus !== 'all') {
      rowsQuery = rowsQuery.eq('status', currentStatus);
      countQuery = countQuery.eq('status', currentStatus);
    }

    const [{ data, error }, { count }] = await Promise.all([rowsQuery, countQuery]);
    if (error) {
      console.error('Error fetching my transactions:', error.message);
      return { rows: [], total: 0 };
    }
    const rows = (data ?? []) as unknown as MyTransaction[];
    return { rows, total: count ?? rows.length };
  }

  const first = await load(currentPage);
  const total = first.total;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // A page past the end (rows removed while it was open) shows the last page.
  const effectivePage = currentPage > totalPages ? totalPages : currentPage;
  const rows = effectivePage !== currentPage && total > 0 ? (await load(effectivePage)).rows : first.rows;

  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader
        title="My Transactions"
        subtitle={
          <>
            {total} submission{total !== 1 ? 's' : ''}
            {currentStatus !== 'all' && ` with status "${formatStatus(currentStatus)}"`}
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
