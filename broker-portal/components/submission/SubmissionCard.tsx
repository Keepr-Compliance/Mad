/**
 * The phone card for one submission, shared by the Submissions list and the
 * dashboard's Recent Submissions (BACKLOG-3904). Street / city line on the
 * left, status pill over price on the right, "agent · type · date" underneath.
 *
 * The whole card is one link: one tab stop, named by its content. A plain
 * <Link> click already starts the top loading bar (NavigationProgress listens
 * for anchor clicks). Hover colour applies only where a pointer can hover.
 * Callers show it below md only (their wrapper is md:hidden).
 */

import Link from 'next/link';
import { formatCurrency, formatRelativeTime, getStatusColor, formatStatus } from '@/lib/utils';
import { formatUsAddress } from '@/lib/submissions/formatUsAddress';

export interface SubmissionCardData {
  id: string;
  property_address: string;
  property_city: string | null;
  property_state: string | null;
  transaction_type: string;
  listing_price: number | null;
  sale_price: number | null;
  status: string;
  created_at: string;
}

function capitalize(text: string | null | undefined): string {
  const t = (text ?? '').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function SubmissionCard({ submission, agent }: { submission: SubmissionCardData; agent?: string | null }) {
  const { street, cityLine } = formatUsAddress(
    submission.property_address,
    submission.property_city,
    submission.property_state
  );
  const meta = [agent, capitalize(submission.transaction_type), formatRelativeTime(submission.created_at)]
    .filter(Boolean)
    .join(' · ');

  return (
    <Link
      href={`/dashboard/submissions/${submission.id}`}
      data-slot="submission-card"
      className="grid grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_auto_1fr_auto] gap-x-3 rounded-[10px] border border-gray-200 bg-white p-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 [@media(hover:hover)]:hover:bg-gray-50"
    >
      <div className="col-start-1 row-span-3 row-start-1 min-w-0">
        <div className="text-[15px] font-semibold leading-[1.3] text-gray-900">{street}</div>
        {cityLine && <div className="mt-[3px] text-[13px] text-gray-500">{cityLine}</div>}
      </div>
      <div className="col-start-2 row-start-1 self-start justify-self-end">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${getStatusColor(
            submission.status
          )}`}
        >
          {formatStatus(submission.status)}
        </span>
      </div>
      <div className="col-start-2 row-start-2 mt-[3px] justify-self-end text-[13px] font-semibold text-gray-900">
        {formatCurrency(submission.sale_price || submission.listing_price)}
      </div>
      <div className="col-start-1 row-start-4 mt-[3px] min-w-0 truncate text-xs text-gray-500">{meta}</div>
    </Link>
  );
}
