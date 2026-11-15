/**
 * Submissions report table — BACKLOG-3513 PR-3a.
 *
 * Presentational: the rows the server page read through the row function. One
 * row per deal. A full role links to the submission page; an agent to the same
 * deal in My Transactions.
 */

import Link from 'next/link';
import { formatCurrency, formatDate, formatStatus, getStatusColor } from '@/lib/utils';
import { formatUsAddress } from '@/lib/submissions/formatUsAddress';
import type { SubmissionsReportRow } from '@/lib/reports/datasets/submissions';

export interface SubmissionsReportTableProps {
  rows: SubmissionsReportRow[];
  /** Agent column and links to the Submissions page (full roles). */
  full: boolean;
  /** Submitter names; null: not available. */
  names: ReadonlyMap<string, string> | null;
}

function price(row: SubmissionsReportRow): number | null {
  return row.sale_price && row.sale_price > 0 ? row.sale_price : row.listing_price;
}

export function SubmissionsReportTable({ rows, full, names }: SubmissionsReportTableProps) {
  const href = (id: string) => (full ? `/dashboard/submissions/${id}` : `/dashboard/my-transactions/${id}`);
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-gray-200 text-sm" data-testid="submissions-report-table">
        <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
          <tr>
            <th scope="col" className="px-4 py-3">
              Property
            </th>
            {full ? (
              <th scope="col" className="px-4 py-3">
                Agent
              </th>
            ) : null}
            <th scope="col" className="px-4 py-3">
              Type
            </th>
            <th scope="col" className="px-4 py-3">
              Status
            </th>
            <th scope="col" className="px-4 py-3 text-right">
              Price
            </th>
            <th scope="col" className="px-4 py-3">
              Submitted
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((row) => {
            const address = formatUsAddress(row.property_address, row.property_city, row.property_state);
            return (
              <tr key={row.id} data-testid="submissions-report-row">
                <td className="px-4 py-3">
                  <Link href={href(row.id)} className="font-medium text-gray-900 hover:underline">
                    {address.street}
                  </Link>
                  {address.cityLine ? <div className="text-xs text-gray-500">{address.cityLine}</div> : null}
                </td>
                {full ? (
                  <td className="px-4 py-3 text-gray-700">
                    {row.submitted_by ? (names?.get(row.submitted_by) ?? 'Former member') : '-'}
                  </td>
                ) : null}
                <td className="px-4 py-3 capitalize text-gray-700">{row.transaction_type}</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${getStatusColor(row.status)}`}
                  >
                    {formatStatus(row.status)}
                  </span>
                </td>
                <td className="px-4 py-3 text-right text-gray-700">{formatCurrency(price(row))}</td>
                <td className="px-4 py-3 text-gray-700">{formatDate(row.created_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
