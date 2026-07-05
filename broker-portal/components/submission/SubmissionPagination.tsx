import Link from 'next/link';
import { paginationButtonClasses } from '@keepr/design-system';

interface SubmissionPaginationProps {
  currentPage: number;
  totalPages: number;
  baseUrl: string;
}

/**
 * Build the href for a specific page number.
 * If the baseUrl already has query params (e.g., ?status=submitted),
 * append &page=N. Otherwise, append ?page=N.
 * Page 1 omits the page param entirely for cleaner URLs.
 */
function buildPageUrl(baseUrl: string, page: number): string {
  if (page <= 1) {
    return baseUrl;
  }
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}page=${page}`;
}

/**
 * Server-rendered pagination component for the submission list.
 * Uses Next.js Link for server-side navigation (no client state).
 */
export function SubmissionPagination({
  currentPage,
  totalPages,
  baseUrl,
}: SubmissionPaginationProps) {
  const hasPrevious = currentPage > 1;
  const hasNext = currentPage < totalPages;

  return (
    <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-t border-gray-200">
      <span className="text-sm text-gray-600">
        Page {currentPage} of {totalPages}
      </span>
      <div className="flex gap-2">
        {hasPrevious ? (
          <Link
            href={buildPageUrl(baseUrl, currentPage - 1)}
            className={paginationButtonClasses}
          >
            Previous
          </Link>
        ) : (
          <span className={`${paginationButtonClasses} opacity-50 cursor-not-allowed pointer-events-none`}>
            Previous
          </span>
        )}
        {hasNext ? (
          <Link
            href={buildPageUrl(baseUrl, currentPage + 1)}
            className={paginationButtonClasses}
          >
            Next
          </Link>
        ) : (
          <span className={`${paginationButtonClasses} opacity-50 cursor-not-allowed pointer-events-none`}>
            Next
          </span>
        )}
      </div>
    </div>
  );
}
