/**
 * Dashboard route loading state (BACKLOG-3893, ported from the admin portal's
 * BACKLOG-3797). Shown inside the dashboard shell while a server page under
 * /dashboard loads and that page has no loading state of its own
 * (submissions, users and my-transactions keep theirs). Static: no data
 * fetching, no hooks.
 */

import { Skeleton } from '@/components/ui/Skeleton';

export default function DashboardLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      data-testid="dashboard-loading"
      className="max-w-7xl mx-auto"
    >
      {/* Header Skeleton (mirrors PageHeader) */}
      <div className="mb-6">
        <Skeleton className="h-8 w-48 mb-2" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
      <span className="sr-only">Loading</span>
    </div>
  );
}
