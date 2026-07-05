/**
 * Submissions Page Loading State
 *
 * Shows skeleton UI while submissions are being fetched.
 */

import { SubmissionTableSkeleton, Skeleton } from '@/components/ui/Skeleton';

export default function SubmissionsLoading() {
  return (
    <div className="max-w-7xl mx-auto">
      {/* Header Skeleton (mirrors PageHeader) */}
      <div className="mb-6">
        <Skeleton className="h-8 w-40 mb-2" />
        <Skeleton className="h-4 w-32" />
      </div>

      <div className="space-y-6">
        {/* Filter Pills Skeleton */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-24 rounded-full" />
            ))}
          </div>
        </div>

        {/* Table Skeleton */}
        <SubmissionTableSkeleton rows={5} />
      </div>
    </div>
  );
}
